import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { audit } from "@aihot/backend/audit";
import { config } from "@aihot/backend/config";
import { closeDb, sql, type Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { RESET_MONITOR_BACKENDS } from "@aihot/site/reset-monitor-backends";
import { editorialScopeSchema, reduceEvent, type EventRow, type ActionInput } from "../actions.ts";
import { localizedTextSchema } from "../public-v2.ts";
import { loadActionInput } from "../backend/action-store.ts";
import { verifyActionBackup } from "../backend/backup.ts";
import { inMonitor, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { editorialStatus, saveEditorialState } from "../backend/event-editorial.ts";
import { completeStandardScopeLabel, defaultScopeLabel, publicScopeLabel } from "../backend/scope-labels.ts";
import { assertScopeCutoverComplete, legacyScopeBaselineKey, readyEvent, rebaseScopeWebhookHistory, retiredScopeFields } from "../backend/webhook-events.ts";

const reviewSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  events: z.array(z.strictObject({
    monitorId: z.string().min(1), eventId: z.string().min(1), reviewed: z.literal(true),
    summary: localizedTextSchema.optional(),
    actions: z.array(z.strictObject({ id: z.string().min(1), summary: localizedTextSchema })).optional(),
  })),
});
type Review = z.infer<typeof reviewSchema>;
const recordKey = (monitorId: string, eventId: string) => JSON.stringify([monitorId, eventId]);
function legacyFields(row: EventRow) {
  const scope = row.scope as Record<string, unknown> | null;
  return Object.fromEntries(retiredScopeFields.flatMap(key => scope && Object.hasOwn(scope, key) ? [[key, scope[key]]] : []));
}
function requiresReview(row: EventRow) {
  return Object.values(legacyFields(row)).some(value => !Array.isArray(value) || value.length > 0);
}

/** Only this offline tool reconstructs the previous fingerprint; no old payload is sent or accepted. */
export function legacyWebhookFingerprint(row: EventRow, input: ActionInput, now: number) {
  const event = readyEvent(row, input, now);
  if (!event) return null;
  const type = row.scope?.type ?? "all_users";
  const note = completeStandardScopeLabel(row.scope?.note) ?? defaultScopeLabel(type === "unknown" ? "all_users" : type);
  const scope = row.scope ? { ...row.scope, type, note }
    : { type, note, productCodes: [], planCodes: [], quotaWindowCodes: [] };
  return sha256(stableJson({ ...event, scope }));
}

async function snapshot(db: Db, definitions: readonly ResetMonitorBackendDefinition[], now = Date.now()) {
  const monitors = [];
  const unpublished: Array<{ monitorId: string; eventId: string }> = [];
  for (const definition of definitions) {
    const input = await inMonitor(definition, () => loadActionInput(db));
    const states = await db<{ key: string; value: Record<string, unknown> }[]>`SELECT key,value FROM monitor_state
      WHERE monitor_id=${definition.monitorId} AND (starts_with(key,'webhook:event:') OR starts_with(key,'public_v2:translation:')
        OR key=${legacyScopeBaselineKey}) ORDER BY key`;
    monitors.push({ definition, input, states });
    if (states.some(state => state.key === legacyScopeBaselineKey)) await inMonitor(definition, async () => {
      for (const row of input.events) {
        const before = states.find(state => state.key === `webhook:event:${row.id}`)?.value;
        if (!before || before.historicalPending) continue;
        const withdrawn = row.withdrawn || !reduceEvent(row, input);
        if (before.withdrawn !== withdrawn || !withdrawn && before.fingerprint
          && before.fingerprint !== legacyWebhookFingerprint(row, input, now)) {
          unpublished.push({ monitorId: definition.monitorId, eventId: row.id });
        }
      }
    });
  }
  const deliveries = await db`SELECT d.id,d.status,n.monitor_id,n.event_id,n.revision
    FROM monitor_webhook_deliveries d JOIN monitor_webhook_notifications n ON n.id=d.notification_id
    WHERE d.status IN ('pending','sending') OR (d.status='failed' AND (n.payload->'event'->'scope') ?| ${[...retiredScopeFields]}::text[])
    ORDER BY d.id`;
  const pending = await db`SELECT monitor_id,key FROM monitor_state WHERE starts_with(key,'recognition:pending:') ORDER BY monitor_id,key`;
  const subscriptions = await db`SELECT platforms,count(*)::int AS count FROM monitor_webhook_subscriptions
    WHERE enabled GROUP BY platforms ORDER BY platforms`;
  const ids = definitions.map(definition => definition.monitorId);
  const unconfigured = await db`SELECT monitor_id,id FROM monitor_event_records WHERE NOT(monitor_id=ANY(${ids}::text[]))
    AND scope ?| ${[...retiredScopeFields]}::text[]
    UNION ALL SELECT monitor_id,'state:' || key AS id FROM monitor_state
    WHERE NOT(monitor_id=ANY(${ids}::text[])) AND key=${legacyScopeBaselineKey} ORDER BY monitor_id,id`;
  const target = new URL(config.databaseUrl);
  target.username = ""; target.password = ""; target.search = ""; target.hash = "";
  const fingerprint = sha256(stableJson({ target: target.href, pending, deliveries, subscriptions, unconfigured, unpublished,
    monitors: monitors.map(({ definition, input, states }) => ({ monitor: definition.monitorId, states, ...input,
      standaloneFollowupIds: [...input.standaloneFollowupIds ?? []].sort() })) }));
  return { monitors, deliveries, pending, subscriptions, unconfigured, unpublished, fingerprint };
}

export async function inventoryScopeCutover(db: Db, definitions: readonly ResetMonitorBackendDefinition[]) {
  const state = await snapshot(db, definitions);
  const events = state.monitors.flatMap(({ definition, input }) => input.events.filter(requiresReview).map(row => ({
    monitorId: definition.monitorId, eventId: row.id, legacy: legacyFields(row), title: row.title, summary: row.summary,
    actions: input.actions.filter(action => action.event_id === row.id).map(action => ({ id: action.id, title: action.title,
      summary: action.summary, urls: action.sources.flatMap(({ postId }) => input.posts.find(post => post.id === postId)?.url ?? []) })),
  })));
  return { fingerprint: state.fingerprint, fieldsToRemove: state.monitors.flatMap(({ input }) => input.events).filter(row => Object.keys(legacyFields(row)).length).length,
    pendingRecognition: state.pending, deliveries: state.deliveries, enabledSubscriptions: state.subscriptions, unconfigured: state.unconfigured,
    unpublishedEvents: state.unpublished,
    events, reviewTemplate: { fingerprint: state.fingerprint, events: events.map(({ monitorId, eventId }) => ({ monitorId, eventId, reviewed: false })) } };
}

/** One stopped-writer transaction. Callers must verify the backup before entering it. */
export async function executeScopeCutover(db: Db, definitions: readonly ResetMonitorBackendDefinition[], input: unknown, now = Date.now()) {
  const review = reviewSchema.parse(input);
  await db`SET LOCAL lock_timeout='5s'`;
  await db`LOCK TABLE monitor_event_records,monitor_event_actions,monitor_source_posts,monitor_state,
    monitor_webhook_subscriptions,monitor_webhook_notifications,monitor_webhook_deliveries IN SHARE ROW EXCLUSIVE MODE`;
  const state = await snapshot(db, definitions, now);
  if (state.fingerprint !== review.fingerprint) throw new Error("Scope cutover input changed; review a fresh inventory");
  if (state.pending.length || state.deliveries.some(row => row.status !== "failed") || state.unconfigured.length || state.unpublished.length) {
    throw new Error("Resolve outstanding recognition, deliveries, unpublished changes and unconfigured events before switching contracts");
  }
  const reviewed = new Map(review.events.map(row => [recordKey(row.monitorId, row.eventId), row]));
  const required = state.monitors.flatMap(({ definition, input }) => input.events.filter(requiresReview).map(row => recordKey(definition.monitorId, row.id)));
  if (reviewed.size !== review.events.length || reviewed.size !== required.length || required.some(key => !reviewed.has(key))) {
    throw new Error("Each event with retired scope facts requires exactly one reviewed entry");
  }
  let events = 0, actions = 0;
  for (const { definition, input: before, states } of state.monitors) await inMonitor(definition, async () => {
    const changed = new Map<string, boolean>();
    const changedActions = new Set<string>();
    for (const row of before.events) {
      if (!row.scope || !Object.keys(legacyFields(row)).length) continue;
      const entry = reviewed.get(recordKey(definition.monitorId, row.id));
      const remaining = Object.fromEntries(Object.entries(row.scope).filter(([key]) => !Object.hasOwn(legacyFields(row), key)));
      const { type, note } = editorialScopeSchema.parse(remaining);
      const completeNote = completeStandardScopeLabel(note);
      const normalizedNote = type === "unknown" && completeNote ? publicScopeLabel(type, completeNote) : note;
      const scope = { type, note: normalizedNote };
      const summary = entry?.summary ?? row.summary;
      const eventActions = before.actions.filter(action => action.event_id === row.id);
      const corrections = entry?.actions ?? [];
      const sourcedActions = eventActions.filter(action => action.sources.length > 0);
      const eligibilityActions = sourcedActions.length ? sourcedActions : eventActions.filter(action => action.action === "confirm");
      if (entry && !eligibilityActions.some(action => localizedTextSchema.safeParse(
        corrections.find(correction => correction.id === action.id)?.summary ?? action.summary).success)) {
        throw new Error(`Reviewed event ${row.id} still has no complete action summary preserving the scope facts`);
      }
      for (const correction of corrections) {
        if (changedActions.has(correction.id) || !eventActions.some(action => action.id === correction.id)) {
          throw new Error(`Reviewed action ${correction.id} is duplicate or does not belong to its event`);
        }
        await db`UPDATE monitor_event_actions SET summary=${db.json(correction.summary)},updated_at=clock_timestamp()
          WHERE monitor_id=${definition.monitorId} AND id=${correction.id}`;
        changedActions.add(correction.id);
        actions++;
      }
      await db`UPDATE monitor_event_records SET scope=${db.json(scope)},summary=${summary ? db.json(summary) : null},updated_at=clock_timestamp()
        WHERE monitor_id=${definition.monitorId} AND id=${row.id}`;
      changed.set(row.id, Boolean(entry?.summary));
      events++;
    }
    const after = changed.size ? await loadActionInput(db) : before;
    for (const row of after.events) if (changed.has(row.id)) {
      const status = editorialStatus(before.events.find(event => event.id === row.id)!, before);
      if (changed.get(row.id) || status) await saveEditorialState(db, row, after, changed.get(row.id) ? "ready" : status!);
    }
    // Preserve matching translation work; an unrelated or already stale record is left alone.
    for (const { key, value } of states) {
      const event = before.events.find(row => changed.has(row.id) && key === `public_v2:translation:event:${row.id}`);
      const action = before.actions.find(row => changedActions.has(row.id) && key === `public_v2:translation:action:${row.id}`);
      const previous = event ?? action;
      if (!previous || value.version !== sha256(stableJson(previous))) continue;
      const next = event ? after.events.find(row => row.id === previous.id) : after.actions.find(row => row.id === previous.id);
      await db`UPDATE monitor_state SET value=${db.json({ ...value, version: sha256(stableJson(next)) } as never)},updated_at=clock_timestamp()
        WHERE monitor_id=${definition.monitorId} AND key=${key}`;
    }
    await rebaseScopeWebhookHistory(db, await loadActionInput(db), now);
  });
  await assertScopeCutoverComplete(db);
  await audit("operator", "reset_monitor.scope_cutover", "reset-monitors", "Preserve reviewed eligibility text and remove retired scope fields without sending historical notifications",
    { fingerprint: review.fingerprint }, { events, actions }, { db });
  return { events, actions };
}

async function main() {
  const { values } = parseArgs({ strict: true, options: { inventory: { type: "string" }, apply: { type: "string" },
    "worker-stopped": { type: "boolean" }, "database-backup": { type: "string" }, "verification-database-env": { type: "string" } } });
  if (Boolean(values.inventory) === Boolean(values.apply)) throw new Error("Use --inventory NEW_FILE or --apply REVIEW_FILE --worker-stopped --database-backup COMPLETE_DUMP");
  try {
    if (values.inventory) {
      if (values["worker-stopped"] || values["database-backup"] || values["verification-database-env"]) throw new Error("Apply options cannot be used with a read-only inventory");
      const inventory = await sql.begin("isolation level repeatable read read only", db => inventoryScopeCutover(db, RESET_MONITOR_BACKENDS));
      await writeFile(values.inventory, JSON.stringify(inventory, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ eventsToReview: inventory.events.length, fieldsToRemove: inventory.fieldsToRemove,
        pendingRecognition: inventory.pendingRecognition.length, outstandingDeliveries: inventory.deliveries.filter(row => row.status !== "failed").length,
        unpublishedEvents: inventory.unpublishedEvents.length }));
      return;
    }
    if (!values["worker-stopped"] || !values["database-backup"]) throw new Error("Apply requires stopped API/workers and a complete database backup");
    for (const [key, value] of Object.entries(process.env)) if (value === "true" &&
      (["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "WEBHOOK_PUSH_ENABLED", "SERVERCHAN_ENABLED", "INDEXNOW_SUBMIT_ENABLED"].includes(key)
        || /^FEISHU_.*_ENABLED$/.test(key))) throw new Error(`${key} must stay disabled during the scope cutover`);
    const variable = values["verification-database-env"];
    if (variable && (!/^[A-Z][A-Z0-9_]*$/.test(variable) || !process.env[variable])) throw new Error("Specify the name of a configured verification database variable");
    const review = reviewSchema.parse(JSON.parse(await readFile(values.apply!, "utf8")));
    await verifyActionBackup(values["database-backup"], variable ? process.env[variable] : undefined);
    console.log(JSON.stringify(await sql.begin("read write", db => executeScopeCutover(db, RESET_MONITOR_BACKENDS, review))));
  } finally { await closeDb(); }
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database]") : "Scope cutover failed");
  process.exitCode = 1;
});
