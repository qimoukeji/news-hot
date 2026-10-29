import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import {
  inMonitor,
  monitorId,
  auditAction,
  auditSubject,
  type ResetMonitorBackendDefinition,
} from "./context.ts";
import { loadActionInput, rowVersion, validateScope, lockActionRecords } from "./action-store.ts";
import { editorialTextSchema, editorialScopeSchema, eventIdsForPost } from "../actions.ts";
import type { ResetSnapshot } from "../public-v2.ts";
import { projectPublicV2 } from "./public-v2.ts";
import { enqueuePublicV2 } from "./public-v2-work.ts";
const editorial = z.strictObject({
  title: editorialTextSchema.nullable(),
  summary: editorialTextSchema.nullable(),
  scope: editorialScopeSchema.nullable().optional(),
});
const schema = z.strictObject({
  schemaVersion: z.literal(2),
  monitors: z.array(
    z.strictObject({
      monitorId: z.string(),
      reviews: z.array(
        z.strictObject({
          kind: z.enum(["event", "action", "post"]),
          id: z.string(),
          expectedVersion: z.string(),
          editorial,
        }),
      ),
    }),
  ),
});
export type ReviewBundle = z.infer<typeof schema>;
export async function exportPublicV2(
  definitions: readonly ResetMonitorBackendDefinition[],
): Promise<ReviewBundle> {
  return sql.begin("isolation level repeatable read read only", async (tx) => ({
    schemaVersion: 2 as const,
    monitors: await Promise.all(
      definitions.map((definition) =>
        inMonitor(definition, async () => {
          const input = await loadActionInput(tx);
          const rows = [
            ...input.events.map((row) => ({ kind: "event" as const, row })),
            ...input.actions.map((row) => ({ kind: "action" as const, row })),
            ...input.posts.filter(row => !row.context_only).map((row) => ({ kind: "post" as const, row })),
          ];
          return {
            monitorId: monitorId(),
            reviews: rows.map(({ kind, row }) => ({
              kind,
              id: row.id,
              expectedVersion: rowVersion(row),
              editorial: {
                title: row.title,
                summary: row.summary,
                ...(kind === "event" && "scope" in row
                  ? { scope: row.scope }
                  : {}),
              },
            })),
          };
        }),
      ),
    ),
  }));
}
async function prepare(
  value: unknown,
  definitions: readonly ResetMonitorBackendDefinition[],
  db: Db,
  apply: boolean,
  reason: string,
  actor: string,
) {
  const bundle = schema.parse(value),
    changes: unknown[] = [],
    snapshots: ResetSnapshot[] = [],
    gaps: unknown[] = [];
  const seen = new Set<string>();
  for (const part of bundle.monitors) {
    const definition = definitions.find(
      (definition) => definition.monitorId === part.monitorId,
    );
    if (!definition || seen.has(part.monitorId))
      throw new Error("Unknown or duplicate monitor");
    seen.add(part.monitorId);
    await inMonitor(definition, async () => {
      if (apply) {
        const current = await loadActionInput(db), eventIds = new Set<string>(), actionIds = new Set<string>(), postIds = new Set<string>();
        for (const review of part.reviews) {
          if (review.kind === "event") eventIds.add(review.id);
          else if (review.kind === "action") {
            actionIds.add(review.id);
            const action = current.actions.find(action => action.id === review.id);
            if (action) eventIds.add(action.event_id);
          } else {
            postIds.add(review.id);
            for (const eventId of eventIdsForPost(current, review.id)) eventIds.add(eventId);
          }
        }
        await lockActionRecords(db, eventIds, actionIds, postIds);
      }
      const input = await loadActionInput(db),
        affected = new Set<string>(),
        items = new Set<string>();
      for (const review of part.reviews) {
        const key = review.kind + ":" + review.id;
        if (items.has(key)) throw new Error("Duplicate editorial record");
        items.add(key);
        const rows =
          review.kind === "event"
            ? input.events
            : review.kind === "action"
              ? input.actions
              : input.posts.filter(post => !post.context_only);
        const row = rows.find((row) => row.id === review.id);
        if (!row || rowVersion(row) !== review.expectedVersion)
          throw new Conflict("Editorial record changed");
        if (review.kind !== "event" && "scope" in review.editorial)
          throw new Error("Only event display scope is editorial");
        if (review.kind === "action" && !review.editorial.title)
          throw new Error("Action title is required");
        if (review.editorial.scope) validateScope(review.editorial.scope);
        const before = {
          title: row.title,
          summary: row.summary,
          ...("scope" in row ? { scope: row.scope } : {}),
        };
        Object.assign(row, review.editorial);
        changes.push({
          monitorId: monitorId(),
          kind: review.kind,
          id: row.id,
          before,
          after: review.editorial,
        });
        if (review.kind === "event") affected.add(row.id);
        else if ("event_id" in row) affected.add(row.event_id);
        else
          for (const eventId of eventIdsForPost(input, row.id)) affected.add(eventId);
        if (apply) {
          const table =
            review.kind === "event"
              ? "monitor_event_records"
              : review.kind === "action"
                ? "monitor_event_actions"
                : "monitor_source_posts";
          await db`UPDATE ${db(table)} SET title=${row.title ? db.json(row.title) : null},summary=${row.summary ? db.json(row.summary) : null},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${row.id}`;
          if ("scope" in review.editorial)
            await db`UPDATE ${db(table)} SET scope=${review.editorial.scope ? db.json(review.editorial.scope) : null} WHERE monitor_id=${monitorId()} AND id=${row.id}`;
          await audit(
            actor,
            auditAction("editorial"),
            auditSubject(review.kind === "post" ? "post" : "event", row.id),
            reason,
            before,
            review.editorial,
            { db },
          );
        }
      }
      if (apply) await enqueuePublicV2(db, [...affected]);
      snapshots.push(projectPublicV2(input, definition));
    });
  }
  return { changes, snapshots, gaps };
}
export async function previewPublicV2(
  value: unknown,
  definitions: readonly ResetMonitorBackendDefinition[],
) {
  return sql.begin("isolation level repeatable read read only", (db) =>
    prepare(value, definitions, db, false, "", ""),
  );
}
export async function applyPublicV2(
  value: unknown,
  definitions: readonly ResetMonitorBackendDefinition[],
  reason: string,
  actor = "manual-editorial",
) {
  if (!reason.trim()) throw new Error("Reason required");
  return sql.begin((db) =>
    prepare(value, definitions, db, true, reason, actor),
  );
}
