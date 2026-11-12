import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { audit } from "@aihot/backend/audit";
import { config } from "@aihot/backend/config";
import { closeDb, sql, type Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { RESET_MONITOR_BACKENDS } from "@aihot/site/reset-monitor-backends";
import { editorialScopeSchema, reduceEvent, type ActionInput, type EventRow } from "../actions.ts";
import { localizedTextSchema, scopeSchema } from "../public-v2.ts";
import { loadActionInput } from "../backend/action-store.ts";
import { verifyActionBackup } from "../backend/backup.ts";
import { inferredConfirmation } from "../backend/confirmation.ts";
import { inMonitor, monitor, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { editorialKey, editorialVersion, saveEditorialState } from "../backend/event-editorial.ts";
import { projectPublicV2 } from "../backend/public-v2.ts";
import { cancelReviewNotification } from "../backend/review-notifications.ts";
import { completeStandardScopeLabel, defaultScopeLabel, publicScopeLabel } from "../backend/scope-labels.ts";
import { assertScopeCutoverComplete, legacyScopeBaselineKey, readyEvent, rebaseScopeWebhookHistory, refreshWebhookBaseline, retiredScopeFields } from "../backend/webhook-events.ts";

import { legacyEditorialStatus, legacyEditorialVersion, legacyProjectedEvent, loadLegacyTimeInput, planTimeCutover,
  sourceInstant, type LegacyTimeInput } from "./time-cutover.ts";
import { timeUpgradeKey } from "./business-time-upgrade.ts";

const reviewSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  times: z.array(z.strictObject({ monitorId: z.string().min(1), actionId: z.string().min(1), reviewed: z.literal(true) })).default([]),
  events: z.array(z.strictObject({
    monitorId: z.string().min(1), eventId: z.string().min(1), reviewed: z.literal(true),
    summary: localizedTextSchema.optional(),
    scope: scopeSchema.refine(scope => scope.type !== "selected_users" || scope.note !== null,
      "Selected users require a complete audience label").optional(),
    actions: z.array(z.strictObject({ id: z.string().min(1), summary: localizedTextSchema })).optional(),
  })),
});
const recordKey = (monitorId: string, eventId: string) => JSON.stringify([monitorId, eventId]);
function legacyFields(row: EventRow) {
  const scope = row.scope as Record<string, unknown> | null;
  return Object.fromEntries(retiredScopeFields.flatMap(key => scope && Object.hasOwn(scope, key) ? [[key, scope[key]]] : []));
}
function requiresReview(row: EventRow) {
  return Object.values(legacyFields(row)).some(value => !Array.isArray(value) || value.length > 0);
}

/** Only this offline tool reconstructs the previous fingerprint; no old payload is sent or accepted. */
export function legacyWebhookFingerprint(row: EventRow, input: LegacyTimeInput, now: number, projected = planTimeCutover(input).after) {
  const event = beforeTimeProjection(row, input, projected, now);
  if (!event) return null;
  const type = row.scope?.type ?? "all_users";
  const note = completeStandardScopeLabel(row.scope?.note) ?? defaultScopeLabel(type === "unknown" ? "all_users" : type);
  const scope = row.scope ? { ...row.scope, type, note }
    : { type, note, productCodes: [], planCodes: [], quotaWindowCodes: [] };
  return sha256(stableJson({ ...event, scope }));
}

function beforeTimeProjection(row: EventRow, input: LegacyTimeInput, projected: ActionInput, now: number) {
  const event = readyEvent(row, projected, now);
  return event ? legacyProjectedEvent(row, input, event, projected, monitor().product) : null;
}

async function snapshot(db: Db, definitions: readonly ResetMonitorBackendDefinition[], now = Date.now()) {
  const [column] = await db<{ type: string }[]>`SELECT atttypid::regtype::text AS type FROM pg_attribute
    WHERE attrelid=to_regclass('monitor_event_actions') AND attname='time' AND attnum>0 AND NOT attisdropped`;
  if (column?.type !== "jsonb") throw new Error("Scope/time cutover requires the current JSONB schema; use the 0146–0153 scalar upgrade first");
  const monitors = [];
  const unpublished: Array<{ monitorId: string; eventId: string }> = [];
  for (const definition of definitions) {
    const input = await loadLegacyTimeInput(db, definition.monitorId);
    const timePlan = planTimeCutover(input);
    const reviewPostIds = new Set(timePlan.changes.flatMap(change => change.reviewPostIds));
    const affected = new Set([...timePlan.changes.map(change => change.eventId),
      ...input.events.filter(row => Object.keys(legacyFields(row)).length).map(row => row.id)]);
    const prospective = { ...timePlan.after, posts: timePlan.after.posts.map(post => reviewPostIds.has(post.id)
      ? { ...post, processing_status: "needs_attention" as const } : post) };
    const inferred = prospective.events.flatMap(row => {
      const action = affected.has(row.id) && inferredConfirmation(row, prospective, now);
      return action ? [{ actionId: action.id, eventId: row.id, time: action.time }] : [];
    });
    const states = await db<{ key: string; value: Record<string, unknown> }[]>`SELECT key,value FROM monitor_state
      WHERE monitor_id=${definition.monitorId} ORDER BY key`;
    monitors.push({ definition, input, states, timePlan, inferred });
    await inMonitor(definition, async () => {
      for (const row of input.events) {
        const before = states.find(state => state.key === `webhook:event:${row.id}`)?.value;
        if (!before || before.historicalPending) continue;
        const withdrawn = row.withdrawn || !reduceEvent(row, timePlan.after);
        const fingerprints = new Set<string>();
        if (!withdrawn && before.fingerprint) {
          try {
            const oldScope = Object.keys(legacyFields(row)).length > 0 || states.some(state => state.key === legacyScopeBaselineKey);
            const legacy = oldScope ? legacyWebhookFingerprint(row, input, now, timePlan.after) : null;
            if (legacy) fingerprints.add(legacy);
            // The 0146–0153 tool rehashed raw events with their old times but the then-current scope projection.
            if (!oldScope || states.some(state => state.key === timeUpgradeKey && state.value.complete === true)) {
              const raw = beforeTimeProjection(row, input, timePlan.after, now);
              if (raw) fingerprints.add(sha256(stableJson(raw)));
            }
          } catch { /* A published fingerprint cannot be verified from invalid old time facts. */ }
        }
        if (before.withdrawn !== withdrawn || !withdrawn && typeof before.fingerprint === "string" && before.fingerprint && !fingerprints.has(before.fingerprint)) {
          unpublished.push({ monitorId: definition.monitorId, eventId: row.id });
        }
      }
    });
  }
  const deliveries = await db`SELECT d.id,d.status,n.monitor_id,n.event_id,n.revision
    FROM monitor_webhook_deliveries d JOIN monitor_webhook_notifications n ON n.id=d.notification_id
    WHERE d.status IN ('pending','sending','failed')
    ORDER BY d.id`;
  const pending = await db`SELECT monitor_id,key FROM monitor_state WHERE starts_with(key,'recognition:pending:') ORDER BY monitor_id,key`;
  const subscriptions = await db`SELECT platforms,count(*)::int AS count FROM monitor_webhook_subscriptions
    WHERE enabled GROUP BY platforms ORDER BY platforms`;
  const ids = definitions.map(definition => definition.monitorId);
  const unconfigured = await db`SELECT monitor_id,id FROM monitor_event_records WHERE NOT(monitor_id=ANY(${ids}::text[]))
    AND scope ?| ${[...retiredScopeFields]}::text[]
    UNION ALL SELECT monitor_id,'action:' || id FROM monitor_event_actions WHERE NOT(monitor_id=ANY(${ids}::text[]))
    UNION ALL SELECT monitor_id,'state:' || key AS id FROM monitor_state
    WHERE NOT(monitor_id=ANY(${ids}::text[])) AND key=${legacyScopeBaselineKey} ORDER BY monitor_id,id`;
  const notifications = await db`SELECT * FROM monitor_webhook_notifications ORDER BY id`;
  const allDeliveries = await db`SELECT * FROM monitor_webhook_deliveries ORDER BY id`;
  const allSubscriptions = await db`SELECT * FROM monitor_webhook_subscriptions ORDER BY id`;
  const allStates = await db`SELECT * FROM monitor_state ORDER BY monitor_id,key`;
  const settings = await db`SELECT key,value,updated_at FROM settings WHERE key='reset.review-notifications'`;
  const target = new URL(config.databaseUrl);
  target.username = ""; target.password = ""; target.search = ""; target.hash = "";
  const fingerprint = sha256(stableJson({ target: target.href, pending, deliveries, notifications, allDeliveries, allSubscriptions, allStates, settings, subscriptions, unconfigured, unpublished,
    monitors: monitors.map(({ definition, input, inferred }) => ({ monitor: definition.monitorId, inferred, ...input,
      standaloneFollowupIds: [...input.standaloneFollowupIds ?? []].sort(),
      invalidatedInferenceIds: [...input.invalidatedInferenceIds ?? []].sort(),
      manualConfirmationIds: [...input.manualConfirmationIds ?? []].sort() })) }));
  return { monitors, deliveries, pending, subscriptions, unconfigured, unpublished, fingerprint };
}

export async function inventoryScopeCutover(db: Db, definitions: readonly ResetMonitorBackendDefinition[], now = Date.now()) {
  const state = await snapshot(db, definitions, now);
  const events = state.monitors.flatMap(({ definition, input }) => input.events.filter(row => Object.keys(legacyFields(row)).length).map(row => ({
    monitorId: definition.monitorId, eventId: row.id, legacy: legacyFields(row), title: row.title, summary: row.summary,
    scope: { type: row.scope!.type, note: row.scope!.note }, reviewRequired: requiresReview(row),
    actions: input.actions.filter(action => action.event_id === row.id).map(action => ({ id: action.id, title: action.title,
      summary: action.summary, urls: action.sources.flatMap(({ postId }) => input.posts.find(post => post.id === postId)?.url ?? []) })),
  })));
  const times = state.monitors.flatMap(({ definition, input, timePlan }) => timePlan.changes.map(change => ({
    monitorId: definition.monitorId, ...change,
    sources: input.actions.find(action => action.id === change.actionId)!.sources.map(({ postId }) => {
      const post = input.posts.find(post => post.id === postId);
      let publishedAt: string | null = null;
      try { publishedAt = post ? sourceInstant(post.published_at) : null; } catch { /* Listed in timeProblems. */ }
      return { postId, url: post?.url ?? null, publishedAt };
    }),
  })));
  const affected = new Set(times.map(row => recordKey(row.monitorId, row.eventId)));
  return { fingerprint: state.fingerprint, fieldsToRemove: events.length, times,
    inferredConfirmations: state.monitors.flatMap(({ definition, inferred }) => inferred.map(action => ({ monitorId: definition.monitorId, ...action }))),
    timeDeliveriesToCancel: state.deliveries.filter(row => row.status === "failed" && affected.has(recordKey(row.monitor_id, row.event_id))).map(row => row.id),
    timeProblems: state.monitors.flatMap(({ definition, timePlan }) => timePlan.problems.map(problem => ({ monitorId: definition.monitorId, ...problem }))),
    pendingRecognition: state.pending, deliveries: state.deliveries, enabledSubscriptions: state.subscriptions, unconfigured: state.unconfigured,
    unpublishedEvents: state.unpublished,
    events, reviewTemplate: { fingerprint: state.fingerprint,
      times: times.map(({ monitorId, actionId }) => ({ monitorId, actionId, reviewed: false })), events: events.filter(row => row.reviewRequired)
      .map(({ monitorId, eventId }) => ({ monitorId, eventId, reviewed: false })) } };
}

/** One stopped-writer transaction. Callers must verify the backup before entering it. */
export async function executeScopeCutover(db: Db, definitions: readonly ResetMonitorBackendDefinition[], input: unknown, now = Date.now()) {
  const review = reviewSchema.parse(input);
  await db`SET LOCAL lock_timeout='5s'`;
  await db`LOCK TABLE monitor_event_records,monitor_event_actions,monitor_source_posts,monitor_state,
    monitor_webhook_subscriptions,monitor_webhook_notifications,monitor_webhook_deliveries,settings IN SHARE ROW EXCLUSIVE MODE`;
  const state = await snapshot(db, definitions, now);
  if (state.fingerprint !== review.fingerprint) throw new Error("Scope cutover input changed; review a fresh inventory");
  if (state.pending.length || state.deliveries.some(row => row.status !== "failed") || state.unconfigured.length || state.unpublished.length) {
    throw new Error("Resolve outstanding recognition, deliveries, unpublished changes and unconfigured events before switching contracts");
  }
  if (state.monitors.some(({ timePlan }) => timePlan.problems.length)) throw new Error("Resolve invalid time sources before switching contracts");
  const requiredTimes = new Set(state.monitors.flatMap(({ definition, timePlan }) => timePlan.changes.map(change => recordKey(definition.monitorId, change.actionId))));
  const reviewedTimes = new Set(review.times.map(row => recordKey(row.monitorId, row.actionId)));
  if (reviewedTimes.size !== review.times.length || reviewedTimes.size !== requiredTimes.size || [...requiredTimes].some(key => !reviewedTimes.has(key))) {
    throw new Error("Each time conversion requires exactly one reviewed entry");
  }
  await db`SELECT set_config('aihot.suppress_monitor_notifications','true',true)`;
  const reviewed = new Map(review.events.map(row => [recordKey(row.monitorId, row.eventId), row]));
  const eligible = new Set(state.monitors.flatMap(({ definition, input }) => input.events.filter(row => Object.keys(legacyFields(row)).length)
    .map(row => recordKey(definition.monitorId, row.id))));
  const required = state.monitors.flatMap(({ definition, input }) => input.events.filter(requiresReview).map(row => recordKey(definition.monitorId, row.id)));
  if (reviewed.size !== review.events.length || review.events.some(row => !eligible.has(recordKey(row.monitorId, row.eventId)))
    || required.some(key => !reviewed.has(key))) {
    throw new Error("Each event with retired scope facts requires exactly one reviewed entry");
  }
  let events = 0, actions = 0, inferred = 0;
  for (const { definition, input: before, states, timePlan, inferred: expectedInferred } of state.monitors) await inMonitor(definition, async () => {
    const changed = new Map<string, boolean>();
    const changedActions = new Set<string>();
    for (const change of timePlan.changes) {
      await db`UPDATE monitor_event_actions SET time=${db.json(change.after)},updated_at=clock_timestamp()
        WHERE monitor_id=${definition.monitorId} AND id=${change.actionId}`;
      changedActions.add(change.actionId);
      changed.set(change.eventId, false);
      for (const postId of change.reviewPostIds) {
        await db`UPDATE monitor_source_posts SET processing_status='needs_attention',filtered_out=false,
          review_reason=left(concat_ws('; ',${change.reason}::text,nullif(review_reason,'')),1000),updated_at=clock_timestamp()
          WHERE monitor_id=${definition.monitorId} AND id=${postId}`;
        await cancelReviewNotification(db, postId);
      }
    }
    for (const row of before.events) {
      if (!row.scope || !Object.keys(legacyFields(row)).length) continue;
      const entry = reviewed.get(recordKey(definition.monitorId, row.id));
      const remaining = Object.fromEntries(Object.entries(row.scope).filter(([key]) => !Object.hasOwn(legacyFields(row), key)));
      const { type, note } = editorialScopeSchema.parse(remaining);
      const completeNote = completeStandardScopeLabel(note);
      const normalizedNote = type === "unknown" && completeNote ? publicScopeLabel(type, completeNote) : note;
      const scope = entry?.scope ?? { type, note: normalizedNote };
      const summary = entry?.summary ?? row.summary;
      const eventActions = before.actions.filter(action => action.event_id === row.id);
      const corrections = entry?.actions ?? [];
      const sourcedActions = eventActions.filter(action => action.sources.length > 0);
      const eligibilityActions = sourcedActions.length ? sourcedActions : eventActions.filter(action => action.action === "confirm");
      if (entry && requiresReview(row)) {
        if (!eventActions.length) {
          if (!localizedTextSchema.safeParse(summary).success) {
            throw new Error(`Reviewed draft ${row.id} still has no complete event summary preserving the scope facts`);
          }
        } else if (!eligibilityActions.some(action => localizedTextSchema.safeParse(
          corrections.find(correction => correction.id === action.id)?.summary ?? action.summary).success)) {
          throw new Error(`Reviewed event ${row.id} still has no complete action summary preserving the scope facts`);
        }
      }
      const correctedIds = new Set<string>();
      for (const correction of corrections) {
        if (correctedIds.has(correction.id) || !eventActions.some(action => action.id === correction.id)) {
          throw new Error(`Reviewed action ${correction.id} is duplicate or does not belong to its event`);
        }
        await db`UPDATE monitor_event_actions SET summary=${db.json(correction.summary)},updated_at=clock_timestamp()
          WHERE monitor_id=${definition.monitorId} AND id=${correction.id}`;
        changedActions.add(correction.id);
        correctedIds.add(correction.id);
        actions++;
      }
      await db`UPDATE monitor_event_records SET scope=${db.json(scope)},summary=${summary ? db.json(summary) : null},updated_at=clock_timestamp()
        WHERE monitor_id=${definition.monitorId} AND id=${row.id}`;
      changed.set(row.id, Boolean(entry?.summary));
      events++;
    }
    const after = await loadActionInput(db);
    for (const row of after.events) if (changed.has(row.id)) {
      const previous = before.events.find(event => event.id === row.id)!;
      const status = legacyEditorialStatus(previous, before);
      if (changed.get(row.id) || status) await saveEditorialState(db, row, after, changed.get(row.id) ? "ready" : status!);
      else {
        const state = states.find(state => state.key === editorialKey(row.id));
        if (state && !["ready", "edited"].includes(String(state.value.status)) && state.value.version === legacyEditorialVersion(previous, before)) {
          await db`UPDATE monitor_state SET value=${db.json({ ...state.value, version: editorialVersion(row, after) } as never)},updated_at=clock_timestamp()
            WHERE monitor_id=${definition.monitorId} AND key=${state.key}`;
        }
      }
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
    const timeEvents = [...new Set(timePlan.changes.map(change => change.eventId))];
    const normalized = await loadActionInput(db);
    for (const expected of expectedInferred) {
      const row = normalized.events.find(row => row.id === expected.eventId)!;
      const confirmation = inferredConfirmation(row, normalized, now);
      if (confirmation?.id !== expected.actionId) throw new Error("Historical confirmation eligibility changed during cutover");
      await db`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,invalidates_event,title,summary,time,sources,created_at,updated_at)
        VALUES(${definition.monitorId},${confirmation.id},${row.id},${confirmation.sequence},'confirm',false,${db.json(confirmation.title)},
          ${confirmation.summary ? db.json(confirmation.summary) : null},${db.json(confirmation.time)},'[]'::jsonb,${confirmation.created_at},${confirmation.updated_at})`;
      await db`UPDATE monitor_event_records SET updated_at=clock_timestamp() WHERE monitor_id=${definition.monitorId} AND id=${row.id}`;
      inferred++;
    }
    const saved = await loadActionInput(db);
    const verified = planTimeCutover(saved);
    if (verified.changes.length || verified.problems.length) throw new Error("Time cutover did not reach a stable result");
    projectPublicV2(saved, definition, now);
    if (timeEvents.length) await db`UPDATE monitor_webhook_deliveries d SET status='cancelled',next_attempt_at=NULL,
      last_error='Time contract switched; historical payload will not be replayed',updated_at=clock_timestamp()
      FROM monitor_webhook_notifications n WHERE d.notification_id=n.id AND n.monitor_id=${definition.monitorId}
      AND n.event_id=ANY(${timeEvents}::text[]) AND d.status='failed'`;
    await rebaseScopeWebhookHistory(db, saved, now);
    // Refresh time-only monitors as well; preserve every existing revision and sent payload.
    for (const row of saved.events) await refreshWebhookBaseline(db, row.id);
  });
  await assertScopeCutoverComplete(db);
  await audit("operator", "reset_monitor.scope_cutover", "reset-monitors", "Normalize reviewed historical times and preserve eligibility text without sending historical notifications",
    { fingerprint: review.fingerprint }, { events, actions, times: requiredTimes.size, inferred }, { db });
  return { events, actions, ...(requiredTimes.size ? { times: requiredTimes.size } : {}), ...(inferred ? { inferred } : {}) };
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
      console.log(JSON.stringify({ eventsToReview: inventory.reviewTemplate.events.length, fieldsToRemove: inventory.fieldsToRemove,
        pendingRecognition: inventory.pendingRecognition.length, outstandingDeliveries: inventory.deliveries.filter(row => row.status !== "failed").length,
        unpublishedEvents: inventory.unpublishedEvents.length, timesToReview: inventory.times.length, timeProblems: inventory.timeProblems.length,
        inferredConfirmations: inventory.inferredConfirmations.length }));
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
