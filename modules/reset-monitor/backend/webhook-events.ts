import { randomUUID } from "node:crypto";
import { sql, type Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { inMonitor, monitor, monitorId, type ResetMonitorBackendDefinition } from "./context.ts";
import { loadPublicV2Input, projectPublicV2, type PublicV2Input, type PublicV2EventRow } from "./public-v2.ts";
import { reduceEvent, translated } from "../actions.ts";
import { webhookPayloadSchema, type WebhookPayload } from "../webhooks.ts";
import { queueWebhookDelivery } from "./webhooks.ts";
import { inferredConfirmation } from "./confirmation.ts";
import { lockActionRecords } from "./action-store.ts";
import { scopeReadyForPublication } from "./scope-labels.ts";

const initializedKey = "webhook:source-less-confirmations:v1";
const eventKey = (id: string) => `webhook:event:${id}`;
interface Baseline {
  revision: number; fingerprint: string | null; withdrawn: boolean; notified: boolean; historicalPending?: boolean;
}

function readyEvent(row: PublicV2EventRow, input: PublicV2Input, now = Date.now()): WebhookPayload["event"] {
  if (row.withdrawn) return null;
  const reduced = reduceEvent(row, input);
  if (!reduced || reduced.actions.some(({action}) => action.sources.length > 0 && (!translated(action.title) || action.summary && !translated(action.summary)))
    || row.title && !translated(row.title) || row.summary && !translated(row.summary)) return null;
  if (!scopeReadyForPublication(reduced.scope)) return null;
  const event = projectPublicV2({ ...input, events: [row] }, monitor(), now).events[0];
  if (!event) return null;
  return event;
}

async function saveBaseline(db: Db, id: string, value: Baseline) {
  await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${eventKey(id)},${db.json(value as never)})
    ON CONFLICT(monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
}

/** Serialize initial baseline and publication across API and worker processes without locking event rows. */
export async function lockWebhookMonitor(db: Db) {
  await db`SELECT pg_advisory_xact_lock(hashtext(${`webhook:${monitorId()}`}))`;
}

/** Existing events establish comparison state; starting the feature never sends historical content. */
export async function initializeWebhookBaselines(definitions: readonly ResetMonitorBackendDefinition[], now = Date.now()) {
  for (const definition of definitions) {
    if (!definition.publicV2) continue;
    // A cross-platform review may hold another monitor lock; never retain multiple baseline locks.
    await sql.begin(async tx => {
      await inMonitor(definition, async () => {
        const [done] = await tx`SELECT 1 FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${initializedKey}`;
        if (done) return;
        const initial = await loadPublicV2Input(tx);
        const candidates = initial.events.filter(row => inferredConfirmation(row, initial, now)).map(row => row.id);
        await lockActionRecords(tx, candidates, [], []);
        await lockWebhookMonitor(tx);
        const [existing] = await tx`SELECT 1 FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${initializedKey}`;
        if (existing) return;
        const input = await loadPublicV2Input(tx);
        await persistConfirmations(tx, input, now, new Set(candidates));
        for (const row of input.events) {
          const event = readyEvent(row, input, now);
          const [stored] = await tx<{value: Baseline}[]>`SELECT value FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${eventKey(row.id)}`;
          await saveBaseline(tx, row.id, { revision: stored?.value.revision ?? 0, fingerprint: event ? sha256(stableJson(event)) : null,
            withdrawn: row.withdrawn || !reduceEvent(row,input), notified: stored?.value.notified ?? false, historicalPending: !event && !!reduceEvent(row,input) });
        }
        await tx`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${initializedKey},'{"initialized":true}'::jsonb)`;
        await tx`DELETE FROM monitor_state WHERE monitor_id=${monitorId()} AND key IN ('webhook:initialized','webhook:confirmation-baseline:v1')`;
      });
    });
  }
}

/** Called with the event's business transaction. Queue records become visible only with that commit. */
export async function captureWebhookEvent(db: Db, id: string, savedInput?: PublicV2Input, now = Date.now()) {
  if (!monitor().publicV2) return;
  await lockWebhookMonitor(db);
  const [initialized] = await db`SELECT 1 FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${initializedKey}`;
  if (!initialized) return;
  const input = savedInput ?? await loadPublicV2Input(db), row = input.events.find(row => row.id === id);
  if (!row) return;
  const [stored] = await db<{ value: Baseline }[]>`SELECT value FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${eventKey(id)}`;
  const previous = stored?.value ?? { revision: 0, fingerprint: null, withdrawn: false, notified: false };
  const event = readyEvent(row, input, now);
  const fingerprint = event ? sha256(stableJson(event)) : previous.fingerprint;
  const withdrawn = row.withdrawn || !reduceEvent(row,input);
  const [mode] = await db`SELECT current_setting('aihot.suppress_monitor_notifications',true) AS suppressed`;
  if (mode?.suppressed === "true") {
    await saveBaseline(db, id, { ...previous, fingerprint, withdrawn, historicalPending: !event });
    return;
  }
  if (!row.withdrawn && reduceEvent(row,input) && !event) return;
  if (withdrawn ? previous.withdrawn : !previous.withdrawn && previous.fingerprint === fingerprint) return;
  if (previous.historicalPending) {
    await saveBaseline(db, id, { ...previous, fingerprint, withdrawn, historicalPending: !event });
    return;
  }
  if (withdrawn && !previous.notified) {
    await saveBaseline(db, id, { ...previous, fingerprint, withdrawn: true });
    return;
  }
  const revision = previous.revision + 1;
  const payload = webhookPayloadSchema.parse({ schemaVersion: 2, id: randomUUID(), occurredAt: new Date().toISOString(),
    platform: monitor().publicV2!.platform, eventId: id, revision,
    action: withdrawn ? "withdrawn" : previous.withdrawn && previous.fingerprint ? "restored" : previous.fingerprint ? "updated" : "created", event });
  const subscribers = await db<{ id: string; generation: number }[]>`SELECT id,generation FROM monitor_webhook_subscriptions
    WHERE enabled AND enabled_at <= ${payload.occurredAt} AND ${payload.platform}=ANY(platforms) ORDER BY id FOR SHARE`;
  if (subscribers.length) {
    await db`INSERT INTO monitor_webhook_notifications(id,monitor_id,event_id,revision,payload)
      VALUES(${payload.id},${monitorId()},${id},${revision},${db.json(payload)})`;
    for (const subscription of subscribers) {
      const deliveryId = randomUUID();
      await db`INSERT INTO monitor_webhook_deliveries(id,subscription_id,notification_id,generation)
        VALUES(${deliveryId},${subscription.id},${payload.id},${subscription.generation})`;
      await queueWebhookDelivery(db, deliveryId);
    }
  }
  await saveBaseline(db, id, { revision, fingerprint, withdrawn, notified: previous.notified || subscribers.length > 0 });
}

/** Time changes publication without new posts; use the same per-monitor lock and fingerprints. */
export async function sweepConfirmationResults(definitions: readonly ResetMonitorBackendDefinition[], now = Date.now()) {
  await initializeWebhookBaselines(definitions, now);
  let checked = 0;
  for (const definition of definitions) if (definition.publicV2) await inMonitor(definition, async () => {
    await sql.begin(async db => {
      const initial = await loadPublicV2Input(db);
      const candidates = initial.events.filter(row => inferredConfirmation(row, initial, now)).map(row => row.id);
      await lockActionRecords(db, candidates, [], []);
      await lockWebhookMonitor(db);
      const input = await loadPublicV2Input(db);
      await persistConfirmations(db, input, now, new Set(candidates));
      for (const event of input.events) { await captureWebhookEvent(db, event.id, input, now); checked++; }
    });
  });
  return { checked };
}

async function persistConfirmations(db: Db, input: PublicV2Input, now: number, candidates: Set<string>) {
  for (const event of input.events) {
    if (!candidates.has(event.id)) continue;
    const action = inferredConfirmation(event, input, now);
    if (!action) continue;
    const rows = await db`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,invalidates_event,title,summary,time,sources,created_at,updated_at)
      VALUES(${monitorId()},${action.id},${action.event_id},${action.sequence},'confirm',false,${db.json(action.title)},${action.summary ? db.json(action.summary) : null},${action.time},'[]'::jsonb,${action.created_at},${action.updated_at}) ON CONFLICT(monitor_id,id) DO NOTHING`;
    if (rows.count) {
      input.actions.push(action);
      await db`UPDATE monitor_event_records SET updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${event.id}`;
    }
  }
}
