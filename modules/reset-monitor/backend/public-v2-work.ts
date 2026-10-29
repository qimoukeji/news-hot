import { type Db } from "@aihot/backend/db";
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
