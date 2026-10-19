import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn } from "@aihot/backend/jobs/queue";
import { assertOutboundUrl, guardedFetch, type GuardedFetchOptions } from "@aihot/backend/lib/http-fetch";
import { stableJson } from "@aihot/backend/lib/ids";
import { webhookPlatforms, webhookPayloadSchema, type WebhookSubscription, type WebhookAdminData, type WebhookDelivery } from "../webhooks.ts";
import type { ResetMonitorBackendDefinition } from "./context.ts";
import { initializeWebhookBaselines } from "./webhook-events.ts";

const reasonSchema = z.string().trim().min(1).max(1000);
export const subscriptionInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120), url: z.string().trim().min(1).max(2048),
  platforms: z.array(z.enum(webhookPlatforms)).min(1).max(webhookPlatforms.length).refine(v => new Set(v).size === v.length, "平台不能重复"),
  enabled: z.boolean().default(false), reason: reasonSchema,
});
export const subscriptionPatchSchema = subscriptionInputSchema.partial().extend({ enabled:z.boolean().optional(), reason: reasonSchema });
export const webhookReasonSchema = z.strictObject({ reason: reasonSchema });
export const webhookPushEnabled = () => process.env.WEBHOOK_PUSH_ENABLED === "true";
const uuid = (id: string) => z.uuid().parse(id);
const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const iso = (v: unknown) => v == null ? null : new Date(v as string | Date).toISOString();
type Row = Record<string, unknown>;
function subscription(row: Row): WebhookSubscription {
  return { id: row.id as string, name: row.name as string, url: row.url as string,
    platforms: row.platforms as WebhookSubscription["platforms"], enabled: row.enabled as boolean,
    enabledAt: iso(row.enabled_at), generation: row.generation as number,
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)! };
}
const subscriptionColumns = sql`id,name,url,platforms,enabled,enabled_at,generation,created_at,updated_at`;
// Callback paths and queries can contain credentials; the audit records only the destination origin.
const auditSubscription = (row: WebhookSubscription | null) => row && { ...row, url: new URL(row.url).origin };
async function callbackUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid("回调地址必须是公开的 HTTPS 地址"); }
  if (url.protocol !== "https:" || url.username || url.password || value.includes("#")) throw invalid("回调地址必须是 HTTPS，且不能含用户凭据或片段");
  try { await assertOutboundUrl(url.href, { allowPrivateNetwork: false }); }
  catch (error) {
    if (/Blocked (?:private |proxy )?address|Blocked host/.test(String(error))) {
      throw invalid("回调地址解析到非公网 IP。若本机使用 Fake-IP 代理 DNS，请配置 EGRESS_PROXY_URL 使用代理解析。");
    }
    throw invalid("无法解析回调地址的域名，请检查域名拼写、DNS 或 EGRESS_PROXY_URL 代理是否可用。");
  }
  return url.href;
}
// Database errors may include bound secret parameters. Never let them reach the HTTP error logger.
async function secretWrite<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (error instanceof Conflict || error instanceof z.ZodError || (error as { statusCode?: number }).statusCode === 400) throw error;
    throw new Error("Webhook 操作失败");
  }
}

export async function listSubscriptions(): Promise<WebhookAdminData> {
  const rows = await sql`SELECT ${subscriptionColumns} FROM monitor_webhook_subscriptions ORDER BY created_at,id`;
  return { subscriptions: rows.map(subscription), pushEnabled: webhookPushEnabled() };
}

export async function createSubscription(value: unknown, actor: string, definitions: readonly ResetMonitorBackendDefinition[] = []) {
  const input = subscriptionInputSchema.parse(value);
  const url = await callbackUrl(input.url);
  await initializeWebhookBaselines(definitions);
  const secret = randomBytes(32).toString("base64url");
  return secretWrite(() => sql.begin(async tx => {
    const [row] = await tx`INSERT INTO monitor_webhook_subscriptions(id,name,url,platforms,enabled,enabled_at,secret)
      VALUES(${randomUUID()},${input.name},${url},${input.platforms},${input.enabled},${input.enabled ? new Date() : null},${secret})
      RETURNING ${subscriptionColumns}`;
    const saved = subscription(row!);
    await audit(actor,"reset_webhook.create",`reset-subscription:${saved.id}`,input.reason,null,auditSubscription(saved),{db:tx});
    return { subscription: saved, secret };
  }) as Promise<{ subscription: WebhookSubscription; secret: string }>);
}

async function cancelOutstanding(db: Db, id: string) {
  await db`UPDATE monitor_webhook_deliveries SET status='cancelled',updated_at=now(),last_error=NULL
    WHERE subscription_id=${id} AND status IN ('pending','sending')`;
}

export async function updateSubscription(id: string, value: unknown, actor: string, definitions: readonly ResetMonitorBackendDefinition[] = []) {
  uuid(id);
  const input = subscriptionPatchSchema.parse(value);
  const url = input.url === undefined ? undefined : await callbackUrl(input.url);
  if (input.enabled === true) await initializeWebhookBaselines(definitions);
  return secretWrite(() => sql.begin(async tx => {
    const [before] = await tx`SELECT ${subscriptionColumns} FROM monitor_webhook_subscriptions WHERE id=${id} FOR UPDATE`;
    if (!before) return null;
    const old = subscription(before);
    const platforms = input.platforms ?? old.platforms;
    const enabled = input.enabled ?? old.enabled;
    const changed = (url !== undefined && url !== old.url) || stableJson([...platforms].sort()) !== stableJson([...old.platforms].sort());
    const invalidate = changed || enabled !== old.enabled;
    const [row] = await tx`UPDATE monitor_webhook_subscriptions SET name=${input.name ?? old.name},url=${url ?? old.url},
      platforms=${platforms},enabled=${enabled},enabled_at=${enabled ? ((!old.enabled || changed) ? new Date() : old.enabledAt) : null},
      generation=generation+${invalidate ? 1 : 0},updated_at=now() WHERE id=${id} RETURNING ${subscriptionColumns}`;
    if (invalidate) await cancelOutstanding(tx,id);
    const saved = subscription(row!);
    await audit(actor,"reset_webhook.update",`reset-subscription:${id}`,input.reason,auditSubscription(old),auditSubscription(saved),{db:tx});
    return saved;
  }) as Promise<WebhookSubscription | null>);
}

export async function rotateSubscriptionSecret(id: string, reason: string, actor: string) {
  uuid(id); reasonSchema.parse(reason);
  const secret = randomBytes(32).toString("base64url");
  return secretWrite(() => sql.begin(async tx => {
    const [row] = await tx`UPDATE monitor_webhook_subscriptions SET secret=${secret},generation=generation+1,updated_at=now()
      WHERE id=${id} RETURNING id,generation`;
    if (!row) return null;
    await cancelOutstanding(tx,id);
    await audit(actor,"reset_webhook.rotate_secret",`reset-subscription:${id}`,reason,null,{generation:row.generation},{db:tx});
    return { secret };
  }) as Promise<{secret:string} | null>);
}

export async function listWebhookDeliveries(id: string): Promise<{deliveries:WebhookDelivery[]} | null> {
  uuid(id);
  if (!(await sql`SELECT id FROM monitor_webhook_subscriptions WHERE id=${id}`).length) return null;
  const rows = await sql`SELECT d.*,n.monitor_id,n.event_id,n.revision,n.payload->>'platform' AS platform,n.payload->>'action' AS action
    FROM monitor_webhook_deliveries d JOIN monitor_webhook_notifications n ON n.id=d.notification_id
    WHERE d.subscription_id=${id} ORDER BY d.created_at DESC,d.id DESC LIMIT 100`;
  return { deliveries: rows.map(row => ({ id:row.id,subscriptionId:row.subscription_id,notificationId:row.notification_id,
    platform:row.platform,eventId:row.event_id,revision:row.revision,action:row.action,status:row.status,attempts:row.attempts,
    nextAttemptAt:row.status === "pending" ? iso(row.next_attempt_at) : null,lastStatus:row.last_status,lastError:row.last_error,
    createdAt:iso(row.created_at)!,sentAt:iso(row.sent_at) })) as WebhookDelivery[] };
}

export async function retryWebhookDelivery(subscriptionId: string, deliveryId: string, reason: string, actor: string) {
  uuid(subscriptionId); uuid(deliveryId); reasonSchema.parse(reason);
  return sql.begin(async tx => {
    const [sub] = await tx`SELECT id,enabled,generation FROM monitor_webhook_subscriptions WHERE id=${subscriptionId} FOR SHARE`;
    if (!sub) return null;
    const [row] = await tx`SELECT id,status,generation FROM monitor_webhook_deliveries WHERE id=${deliveryId} AND subscription_id=${subscriptionId} FOR UPDATE`;
    if (!row) return null;
    if (!sub.enabled || row.status !== "failed" || row.generation !== sub.generation) throw new Conflict("仅可重发当前启用订阅的失败投递");
    await tx`UPDATE monitor_webhook_deliveries SET status='pending',attempts=0,next_attempt_at=now(),last_status=NULL,last_error=NULL,updated_at=now()
      WHERE id=${deliveryId}`;
    await queueWebhookDelivery(tx,deliveryId);
    await audit(actor,"reset_webhook.retry",`reset-subscription:${subscriptionId}`,reason,{deliveryId,status:"failed"},{deliveryId,status:"pending"},{db:tx});
    return { ok:true };
  }) as Promise<{ok:boolean} | null>;
}

export function webhookSignature(secret: string, timestamp: string, body: string) {
  return `v1=${createHmac("sha256",secret).update(`${timestamp}.${body}`).digest("hex")}`;
}
export const webhookRetryDelays = [30,120,600,3600] as const;
export type WebhookTransport = (url: string, options: GuardedFetchOptions) => Promise<{status:number}>;
export const webhookDeliveryQueue = defineQueue<{deliveryId:string}>({
  name:"reset-subscriptions.deliver",options:{policy:"short",retryLimit:0,expireInSeconds:60},worker:{batchSize:1},
  run:async data => { for (const job of data) await deliverWebhook(job.deliveryId); },
});

export async function queueWebhookDelivery(db: Db, deliveryId: string, startAfter?: Date) {
  const [row] = await db`SELECT generation,attempts FROM monitor_webhook_deliveries WHERE id=${deliveryId}`;
  if (!row) return null;
  // A retry must coexist with the active previous attempt, while sweeps deduplicate that same retry.
  const singletonKey = `${deliveryId}:${row.generation}:${row.attempts}`;
  return enqueueOn(webhookDeliveryQueue,{deliveryId},{singletonKey,...(startAfter ? {startAfter} : {})},db);
}

/** Transport injection keeps tests local; normal requests always force the guarded public connection. */
export async function deliverWebhook(id: string, dependencies: {transport?:WebhookTransport; pushEnabled?:()=>boolean} = {}) {
  const enabled = dependencies.pushEnabled ?? webhookPushEnabled;
  if (!enabled()) return;
  const claimed = await sql.begin(async tx => {
    const [sub] = await tx`SELECT s.id,s.enabled,s.generation FROM monitor_webhook_subscriptions s
      JOIN monitor_webhook_deliveries d ON d.subscription_id=s.id WHERE d.id=${id} FOR SHARE OF s`;
    if (!sub || !sub.enabled) return null;
    const [row] = await tx`UPDATE monitor_webhook_deliveries SET status='sending',attempts=attempts+1,updated_at=now()
      WHERE id=${id} AND generation=${sub.generation} AND attempts<5 AND next_attempt_at<=now()
      AND (status='pending' OR (status='sending' AND updated_at<now()-interval '2 minutes')) RETURNING *,updated_at::text AS claim_token`;
    return row ?? null;
  });
  if (!claimed) return;
  let retryAt: Date | undefined;
  await secretWrite(() => sql.begin(async tx => {
    // A management change waits for a request already in progress, then cancels all older work.
    const [sub] = await tx`SELECT s.id,s.url,s.secret,s.enabled,s.generation FROM monitor_webhook_subscriptions s WHERE s.id=${claimed.subscription_id} FOR SHARE`;
    if (!sub || !sub.enabled || sub.generation !== claimed.generation) return;
    // Keep the claim as text: postgres.js serializes timestamp parameters through Date, losing microseconds.
    const [row] = await tx`SELECT d.*,n.payload FROM monitor_webhook_deliveries d JOIN monitor_webhook_notifications n ON n.id=d.notification_id
      WHERE d.id=${id} AND d.status='sending' AND d.attempts=${claimed.attempts} AND d.updated_at::text=${claimed.claim_token}::text FOR UPDATE OF d`;
    if (!row) return;
    if (!enabled()) {
      await tx`UPDATE monitor_webhook_deliveries SET status='pending',attempts=attempts-1,updated_at=now() WHERE id=${id}`;
      return;
    }
    const payload = webhookPayloadSchema.parse(row.payload);
    const body = stableJson(payload);
    const timestamp = String(Math.floor(Date.now()/1000));
    let status: number | null = null;
    let error: string | null = null;
    try {
      const result = await (dependencies.transport ?? guardedFetch)(sub.url as string,{
        method:"POST",body,route:"egress",timeoutMs:10_000,maxRedirects:0,maxBytes:64*1024,allowPrivateNetwork:false,
        headers:{"Content-Type":"application/json","X-Webhook-Id":payload.id,"X-Webhook-Timestamp":timestamp,
          "X-Webhook-Signature":webhookSignature(sub.secret as string,timestamp,body)},
      });
      status = result.status;
      if (status<200 || status>=300) error = `HTTP ${status}`;
    } catch { error = "回调请求失败（网络、地址校验或超时）"; }
    if (!error) {
      await tx`UPDATE monitor_webhook_deliveries SET status='sent',last_status=${status},last_error=NULL,sent_at=now(),updated_at=now() WHERE id=${id}`;
    } else {
      const delay = webhookRetryDelays[(row.attempts as number)-1];
      retryAt = delay === undefined ? undefined : new Date(Date.now()+delay*1000);
      await tx`UPDATE monitor_webhook_deliveries SET status=${retryAt ? "pending" : "failed"},last_status=${status},last_error=${error},
        next_attempt_at=${retryAt ?? new Date()},updated_at=now() WHERE id=${id}`;
    }
  }));
  if (retryAt) await queueWebhookDelivery(sql,id,retryAt);
}

export async function sweepWebhookDeliveries() {
  if (!webhookPushEnabled()) return { queued:0 };
  return sql.begin(async tx => {
    // A worker can die after persisting the attempt and before recording its result.
    await tx`UPDATE monitor_webhook_deliveries SET status='failed',last_error='请求结果未知，已用完重试次数',updated_at=now()
      WHERE status='sending' AND attempts>=5 AND updated_at<now()-interval '2 minutes'`;
    const rows = await tx`SELECT d.id FROM monitor_webhook_deliveries d JOIN monitor_webhook_subscriptions s ON s.id=d.subscription_id
      WHERE s.enabled AND d.generation=s.generation AND d.next_attempt_at<=now() AND d.attempts<5
      AND (d.status='pending' OR (d.status='sending' AND d.updated_at<now()-interval '2 minutes'))
      ORDER BY d.next_attempt_at,d.id LIMIT 200 FOR UPDATE OF d SKIP LOCKED`;
    for (const row of rows) await queueWebhookDelivery(tx,row.id as string);
    return {queued:rows.length};
  });
}
