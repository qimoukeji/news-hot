import { sql, type Db } from "@aihot/backend/db";
import { monitor, monitorId } from "./context.ts";
import { captureWebhookEvent, lockWebhookMonitor } from "./webhook-events.ts";

export const publicV2PendingKey = (id: string) => `public_v2:pending:${id}`;

/** Durable work is recorded with facts, including facts committed just before a worker stops. */
export async function enqueuePublicV2(db: Db, ids: string[]) {
  if (!monitor().publicV2) return;
  // Cleanup captures before deleting pending work; take the same lock before touching its row.
  await lockWebhookMonitor(db);
  for (const id of [...new Set(ids)].sort()) {
    await db`INSERT INTO monitor_state(monitor_id,key,value)
      VALUES(${monitorId()},${publicV2PendingKey(id)},'{"status":"pending"}'::jsonb)
      ON CONFLICT(monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
    await captureWebhookEvent(db, id);
  }
}

export async function clearPublicV2Work(db: Db, id: string) {
  await captureWebhookEvent(db, id);
  await db`DELETE FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${publicV2PendingKey(id)}`;
}

/** Accepted facts remain successful; only the optional editorial work needs review. */
export async function publicV2WorkReview(id: string, error: unknown, version: string, receiptId?: number, db: Db = sql) {
  const reason = String(error).replace(/postgres(?:ql)?:\/\/\S+/gi, "[database]").slice(0, 1000);
  await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${publicV2PendingKey(id)},
    ${db.json({ status: "needs_review", reason, version, at: new Date().toISOString(), ...(receiptId !== undefined ? { receiptId } : {}) })})
    ON CONFLICT(monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
}

export async function publicV2WorkFailure(id: string, error: unknown) {
  const receiptId = error && typeof error === "object" && "receiptId" in error ? error.receiptId : undefined;
  const message = String(error).replace(/postgres(?:ql)?:\/\/\S+/gi, "[database]").slice(0, 1000);
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${publicV2PendingKey(id)},
    ${sql.json({ status: "failed", error: message, at: new Date().toISOString(), ...(typeof receiptId === "number" ? { receiptId } : {}) })})
    ON CONFLICT(monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
}
