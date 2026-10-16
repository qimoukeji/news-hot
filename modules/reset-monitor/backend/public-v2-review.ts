import { z } from "zod";
import { randomUUID } from "node:crypto";
import { audit, Conflict } from "@aihot/backend/audit";
import { sql, type Db } from "@aihot/backend/db";
import { stableJson, sha256 } from "@aihot/backend/lib/ids";
import { monitorId, monitor, inMonitor, auditAction, auditSubject, type ResetMonitorBackendDefinition } from "./context.ts";
import { evidenceVersion, loadPublicV2Input, projectPublicV2, type PublicV2Input, type PublicV2EventRow } from "./public-v2.ts";
import { reviewedEventSchema, normalizePublicTime, updateActions, type ReviewedEvent, type ResetSnapshot } from "../public-v2.ts";
import { resolveBonusTimes } from "./public-v2-time.ts";

const text = z.string().regex(/\S/);
const bundleSchema = z.strictObject({
  schemaVersion: z.literal(1), exportedAt: z.iso.datetime({ offset: true }),
  monitors: z.array(z.strictObject({ monitorId: text,
    // Exported source material is for review; application always rereads the database.
    input: z.unknown(), audit: z.array(z.unknown()),
    reviews: z.array(z.strictObject({ id: text, expectedVersion: text, publicV2: reviewedEventSchema.nullable() })),
  })),
});
export type ReviewBundle = z.infer<typeof bundleSchema>;
const reviewVersion = (event: PublicV2EventRow, input: PublicV2Input) => sha256(stableJson({
  evidence: evidenceVersion(event, input), publicV2: event.presentation?.publicV2 ?? null,
}));

export async function exportPublicV2(definitions: ResetMonitorBackendDefinition[]): Promise<ReviewBundle> {
  return sql.begin("isolation level repeatable read read only", async db => ({
    schemaVersion: 1, exportedAt: new Date().toISOString(), monitors: await Promise.all(definitions.map(definition => inMonitor(definition, async () => {
      const input = await loadPublicV2Input(db, true);
      const entries = await db`SELECT created_at,actor,action,subject,reason,before,after FROM audit_log
        WHERE subject LIKE ${auditSubject("event", "%")} OR subject LIKE ${auditSubject("post", "%")} ORDER BY created_at,id`;
      return { monitorId: monitorId(), input, audit: [...entries], reviews: input.events.filter(event => !event.withdrawn).map(event => ({
        id: event.id, expectedVersion: reviewVersion(event, input), publicV2: event.presentation?.publicV2 ?? null,
      })) };
    }))),
  }));
}

export function validateReview(review: ReviewedEvent, row: PublicV2EventRow, input: PublicV2Input) {
  if (review.evidenceVersion !== evidenceVersion(row, input)) throw new Conflict(`Evidence changed: ${monitorId()}/${row.id}`);
  const prior = row.presentation?.publicV2;
  if (prior && Date.parse(reviewedEventSchema.shape.publishedAt.parse(prior.publishedAt)) !== Date.parse(review.publishedAt)) throw new Error(`First publication is immutable: ${row.id}`);
  const linked = new Set(input.links.filter(link => link.event_id === row.id).map(link => link.post_id));
  if (!prior) {
    const first = input.posts.filter(post => linked.has(post.id)).map(post => new Date(post.published_at).getTime()).sort((a, b) => a - b)[0];
    const publication = Date.parse(review.publishedAt);
    const creationSource = input.posts.some(post => linked.has(post.id) && new Date(post.published_at).getTime() === publication && new Date(row.created_at).getTime() === publication);
    if (first !== publication && !creationSource) throw new Error(`First publication must match the creation source or earliest linked source: ${row.id}`);
  }
  for (const evidence of review.evidence) {
    const post = input.posts.find(post => post.id === evidence.postId);
    if (!linked.has(evidence.postId) || !post?.text.includes(evidence.excerpt)) throw new Error(`Evidence is not quoted in a linked source: ${row.id}/${evidence.postId}`);
  }
  if (review.updateSummaries) {
    const required = new Set(input.links.filter(link => link.event_id === row.id && updateActions.includes(link.action as typeof updateActions[number])).map(link => link.post_id));
    const provided = review.updateSummaries.map(update => update.postId);
    if (new Set(provided).size !== provided.length || required.size !== provided.length
      || provided.some(id => !required.has(id) || !review.evidence.some(evidence => evidence.postId === id))) {
      throw new Error(`Update summaries must cover every accepted business update with linked evidence: ${row.id}`);
    }
  }
  for (const resolution of review.timeResolutions ?? []) {
    const post = input.posts.find(post => post.id === resolution.postId);
    if (!linked.has(resolution.postId) || !post?.text.includes(resolution.excerpt)
      || stableJson(resolution.time) !== stableJson(review.bonusCredit?.[resolution.field])) {
      throw new Error(`Time resolution must match a linked source and the reviewed milestone: ${row.id}`);
    }
  }
  if (["completed", "available", "claim_closed", "expired"].includes(review.status) && (row.status !== "confirmed" || row.confirmation_basis !== "source_post")) {
    throw new Error(`Public completion requires source confirmation: ${row.id}`);
  }
  const requireLanguages = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if ("en" in value) for (const language of ["en", "zh", "zh-Hant", "ja", "ko", "ru", "es"]) {
      if (typeof (value as Record<string, unknown>)[language] !== "string") throw new Error(`Missing ${language} translation: ${row.id}`);
    }
    Object.values(value).forEach(requireLanguages);
  };
  requireLanguages(review);
}

async function prepare(bundle: ReviewBundle, definitions: ResetMonitorBackendDefinition[], db: Db, lock = false) {
  const seenMonitors = new Set<string>();
  const changes: Array<{ monitorId: string; id: string; before: unknown; after: ReviewedEvent }> = [];
  const snapshots: ResetSnapshot[] = [];
  const gaps: Array<{ monitorId: string; id: string; fields: string[] }> = [];
  for (const part of bundle.monitors) {
    const definition = definitions.find(definition => definition.monitorId === part.monitorId);
    if (!definition || seenMonitors.has(part.monitorId)) throw new Error("Unknown or duplicate monitor");
    seenMonitors.add(part.monitorId);
    await inMonitor(definition, async () => {
      if (lock) {
        await db`SELECT id FROM monitor_events WHERE monitor_id=${monitorId()} ORDER BY id FOR UPDATE`;
        await db`SELECT id FROM monitor_posts WHERE monitor_id=${monitorId()} ORDER BY id FOR SHARE`;
      }
      const input = await loadPublicV2Input(db);
      const seen = new Set<string>();
      for (const entry of part.reviews) {
        if (seen.has(entry.id)) throw new Error(`Duplicate review: ${entry.id}`);
        seen.add(entry.id);
        const row = input.events.find(row => row.id === entry.id);
        if (!row || row.withdrawn || reviewVersion(row, input) !== entry.expectedVersion) throw new Conflict(`Event changed: ${monitorId()}/${entry.id}`);
        if (!entry.publicV2) continue;
        validateReview(entry.publicV2, row, input);
        entry.publicV2.time = normalizePublicTime(entry.publicV2.time);
        const resolved = resolveBonusTimes(row, input, entry.publicV2.bonusCredit);
        entry.publicV2.bonusCredit = resolved.bonusCredit;
        if (resolved.resolutions.length) entry.publicV2.timeResolutions = resolved.resolutions;
        entry.publicV2.legacyPresentationWasNull = row.presentation?.publicV2?.legacyPresentationWasNull ?? row.presentation === null;
        if (stableJson(row.presentation?.publicV2 ?? null) !== stableJson(entry.publicV2)) changes.push({
          monitorId: monitorId(), id: entry.id, before: row.presentation?.publicV2 ?? null, after: entry.publicV2,
        });
        row.presentation = { ...row.presentation, publicV2: entry.publicV2 };
      }
      const snapshot = projectPublicV2(input, monitor());
      snapshots.push(snapshot);
      for (const event of snapshot.events) {
        const fields = [event.summary === null && "summary",
          event.type === "bonus_credit" && event.bonusCredit === null && "bonusCredit",
          event.type === "bonus_credit" && (!event.bonusCredit?.claimDeadline || event.bonusCredit.claimDeadline.kind === "unknown") && "bonusCredit.claimDeadline",
          event.type === "bonus_credit" && (!event.bonusCredit?.expiresAt || event.bonusCredit.expiresAt.kind === "unknown") && "bonusCredit.expiresAt"].filter((field): field is string => !!field);
        if (fields.length) gaps.push({ monitorId: monitorId(), id: event.id, fields });
      }
    });
  }
  return { changes, snapshots, gaps };
}

export async function previewPublicV2(value: unknown, definitions: ResetMonitorBackendDefinition[]) {
  const bundle = bundleSchema.parse(value);
  return sql.begin("isolation level repeatable read read only", db => prepare(bundle, definitions, db));
}

export async function applyPublicV2(value: unknown, definitions: ResetMonitorBackendDefinition[], reason: string, actor = "public-v2-review") {
  const bundle = bundleSchema.parse(value);
  if (!reason.trim() || !actor.trim()) throw new Error("Application requires an actor and reason");
  return sql.begin("isolation level repeatable read read write", async db => {
    const prepared = await prepare(bundle, definitions, db, true);
    for (const change of prepared.changes) {
      await db`UPDATE monitor_events SET presentation=jsonb_set(coalesce(presentation,'{}'::jsonb),'{publicV2}',${db.json(change.after)},true)
        WHERE monitor_id=${change.monitorId} AND id=${change.id}`;
      const definition = definitions.find(definition => definition.monitorId === change.monitorId)!;
      await inMonitor(definition, () => audit(actor, auditAction("public_v2"), auditSubject("event", change.id), reason, change.before, change.after, { db }));
    }
    return { operationId: randomUUID(), ...prepared };
  });
}
