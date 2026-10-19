import { randomUUID } from "node:crypto";
import { sql, type Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { inMonitor, monitor, monitorId, type ResetMonitorBackendDefinition } from "./context.ts";
import { evidenceVersion, loadPublicV2Input, projectPublicV2, type PublicV2Input, type PublicV2EventRow } from "./public-v2.ts";
import { reviewedEventSchema } from "../public-v2.ts";
import { webhookPayloadSchema, type WebhookPayload } from "../webhooks.ts";
import { queueWebhookDelivery } from "./webhooks.ts";

const initializedKey = "webhook:initialized";
const eventKey = (id: string) => `webhook:event:${id}`;
interface Baseline {
  revision: number; fingerprint: string | null; withdrawn: boolean; notified: boolean; historicalPending?: boolean;
}

function readyEvent(row: PublicV2EventRow, input: PublicV2Input): WebhookPayload["event"] {
  if (row.withdrawn) return null;
  const review = reviewedEventSchema.safeParse(row.presentation?.publicV2);
  if (!review.success || review.data.evidenceVersion !== evidenceVersion(row, input)) return null;
  const event = projectPublicV2({ ...input, events: [row] }, monitor()).events[0]!;
  const { bonusCredit: _bonus, ...published } = event;
  return published;
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
export async function initializeWebhookBaselines(definitions: readonly ResetMonitorBackendDefinition[]) {
  for (const definition of definitions) {
    if (!definition.publicV2) continue;
    // A cross-platform review may hold another monitor lock; never retain multiple baseline locks.
    await sql.begin(async tx => {
      await inMonitor(definition, async () => {
        await lockWebhookMonitor(tx);
        const [existing] = await tx`SELECT 1 FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${initializedKey}`;
        if (existing) return;
        const input = await loadPublicV2Input(tx);
        for (const row of input.events) {
          const event = readyEvent(row, input);
          await saveBaseline(tx, row.id, { revision: 0, fingerprint: event ? sha256(stableJson(event)) : null,
            withdrawn: row.withdrawn, notified: false, historicalPending: !event });
        }
        await tx`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${initializedKey},'{"initialized":true}'::jsonb)`;
      });
    });
  }
}

/** Called with the event's business transaction. Queue records become visible only with that commit. */
export async function captureWebhookEvent(db: Db, id: string) {
  if (!monitor().publicV2) return;
  await lockWebhookMonitor(db);
  const [initialized] = await db`SELECT 1 FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${initializedKey}`;
  if (!initialized) return;
  const input = await loadPublicV2Input(db), row = input.events.find(row => row.id === id);
  if (!row) return;
  const [stored] = await db<{ value: Baseline }[]>`SELECT value FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${eventKey(id)}`;
  const previous = stored?.value ?? { revision: 0, fingerprint: null, withdrawn: false, notified: false };
  const event = readyEvent(row, input);
  if (!row.withdrawn && !event) return;
  const fingerprint = event ? sha256(stableJson(event)) : previous.fingerprint;
  if (row.withdrawn ? previous.withdrawn : !previous.withdrawn && previous.fingerprint === fingerprint) return;
  if (previous.historicalPending) {
    await saveBaseline(db, id, { ...previous, fingerprint, withdrawn: row.withdrawn, historicalPending: !event });
    return;
  }
  if (row.withdrawn && !previous.notified) {
    await saveBaseline(db, id, { ...previous, fingerprint, withdrawn: true });
    return;
  }
  const revision = previous.revision + 1;
  const payload = webhookPayloadSchema.parse({ schemaVersion: 1, id: randomUUID(), occurredAt: new Date().toISOString(),
    platform: monitor().publicV2!.platform, eventId: id, revision,
    action: row.withdrawn ? "withdrawn" : previous.withdrawn && previous.fingerprint ? "restored" : previous.fingerprint ? "updated" : "created", event });
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
  await saveBaseline(db, id, { revision, fingerprint, withdrawn: row.withdrawn, notified: previous.notified || subscribers.length > 0 });
}
