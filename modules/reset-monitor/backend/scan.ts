import { randomUUID } from "node:crypto";
import { config } from "@aihot/backend/config";
import { sql, type Db } from "@aihot/backend/db";
import { deliverContent } from "@aihot/backend/notify/deliver";
import { monitor, monitorId, authorHandles } from "./context.ts";
import { publicV2Snapshot } from "./public-v2.ts";
import { cursorKey, watermarksKey, collectorName } from "../config.ts";
import { collectPosts, collectionProgressKey } from "./collection.ts";
import { processPending } from "./thread-processing.ts";

const PUSH_MAX_AGE_MS = 36 * 3600_000;
interface Cursor { checkpointVersion: 2; scannedThrough?: string }
async function getState<T>(key: string): Promise<T | null> {
  const [row] = await sql<{ value: T }[]>`SELECT value FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${key}`;
  return row?.value ?? null;
}
async function setState(key: string, value: unknown, db: Db = sql) {
  await db`INSERT INTO monitor_state (monitor_id,key,value) VALUES (${monitorId()},${key},${db.json(value as never)})
    ON CONFLICT (monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
}
async function touchWatermarks(patch: Record<string, string>, db: Db = sql) {
  await db`INSERT INTO monitor_state (monitor_id,key,value) VALUES (${monitorId()},${watermarksKey()},${db.json(patch)})
    ON CONFLICT (monitor_id,key) DO UPDATE SET value=monitor_state.value || EXCLUDED.value,updated_at=now()`;
}
async function pendingPosts(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM monitor_source_posts WHERE monitor_id=${monitorId()}
    AND NOT context_only AND processing_status IN ('pending','failed') AND lower(author)=ANY(${authorHandles()}::text[])`;
  return row?.n ?? 0;
}
export { collectPosts } from "./collection.ts";
export { openEvents } from "./open-events.ts";
export { processPending } from "./thread-processing.ts";

/** Notifications use exactly the accepted v2 action timeline, with a stable action delivery key. */
export async function flushResetPushes(): Promise<number> {
  const snapshot = await publicV2Snapshot();
  const baseline = await getState<{ convertedBefore: string }>("actions:notification_baseline");
  const targets = await sql<{ key: string; enabled_at: Date | null }[]>`SELECT key,enabled_at FROM notify_targets WHERE purpose='content' AND enabled`;
  const historical = new Set((await sql<{ key: string }[]>`SELECT key FROM monitor_state WHERE monitor_id=${monitorId()} AND key LIKE 'recognition:historical:%'`).map(row => row.key.slice("recognition:historical:".length)));
  let pushed = 0;
  for (const event of snapshot.events) for (const update of event.updates) {
    if (update.sources.some(source => historical.has(source.postId))) continue;
    const at = new Date(update.publishedAt);
    if (at.getTime() <= Date.now() - PUSH_MAX_AGE_MS || baseline && at.getTime() <= Date.parse(baseline.convertedBefore)) continue;
    for (const target of targets) {
      if (target.enabled_at && at < target.enabled_at) continue;
      if (["amend", "progress"].includes(update.action)) {
        const [told] = await sql`SELECT 1 FROM deliveries WHERE subject_kind=${monitor().names.deliveryKind} AND subject_id=${event.id}
          AND target_key=${target.key} AND status IN ('sent','unknown','sending') LIMIT 1`;
        if (!told) continue;
      }
      const dedupeKey = `${monitor().names.deliveryPrefix}:action:${update.id}`;
      const [delivered] = await sql`SELECT 1 FROM deliveries WHERE target_key=${target.key} AND dedupe_key=${dedupeKey}`;
      if (delivered) continue;
      const card = {
        header: { title: { tag: "plain_text", content: update.title.zh ?? update.title.en }, template: update.invalidatesEvent ? "grey" : update.action === "confirm" ? "turquoise" : "orange" },
        elements: [
          { tag: "div", text: { tag: "lark_md", content: [update.summary?.zh ?? update.summary?.en, `**事件时间**：${event.time}`,
            `**影响范围**：${event.scope.note?.zh ?? event.scope.note?.en ?? "所有用户"}`,
            event.type === "bonus_credit" ? "活动可领取不表示个人已到账。" : null].filter(Boolean).join("\n") } },
          { tag: "action", actions: [
            ...update.sources.map((source, index) => ({ tag: "button", text: { tag: "plain_text", content: `原帖 ${index + 1}` }, url: source.url, type: "default" })),
            { tag: "button", text: { tag: "plain_text", content: monitor().title }, url: `${config.siteUrl}${monitor().pagePath}`, type: "primary" },
          ] },
        ],
      };
      const results = await deliverContent({ subjectKind: monitor().names.deliveryKind, subjectId: event.id, dedupeKey, contentAt: at, card, targetKey: target.key });
      pushed += results.filter(result => result.status === "sent").length;
    }
  }
  return pushed;
}

export async function monitorTick() {
  if (process.env.COLLECT_ENABLED !== "true" || !config.modelCallsEnabled) return { skipped: true, reason: "automatic_processing_disabled" };
  const connection = await sql.reserve();
  try {
    const [lock] = await connection<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${monitor().names.tick})) AS acquired`;
    if (!lock?.acquired) return { skipped: true, reason: "busy" };
    try { return await tick(); }
    finally { await connection`SELECT pg_advisory_unlock(hashtext(${monitor().names.tick}))`; }
  } finally { connection.release(); }
}
async function tick() {
  const windowKey = `collection:window:${collectorName()}`;
  let window = await getState<{ startedAt: string; roundId: string }>(windowKey);
  const resume = window !== null;
  if (!window) {
    window = { startedAt: new Date().toISOString(), roundId: randomUUID() };
    await setState(windowKey, window);
  }
  const started = new Date(window.startedAt);
  await touchWatermarks({ lastAttemptAt: started.toISOString() });
  const collected = await collectPosts({ startedAt: started, roundId: window.roundId, resume });
  if (!collected.collectionComplete) return { ...collected, outcome: "partial", complete: false, reason: "page_limit", processed: 0, failed: 0, groups: 0, modelCalls: 0, reviewed: 0, schemaFailures: 0, pushed: 0, pending: await pendingPosts() };
  const result = await processPending();
  const pending = await pendingPosts();
  if (pending) throw new Error(`Monitor round incomplete: ${pending} posts pending or failed`);
  await sql.begin(async db => {
    await setState(cursorKey(), { checkpointVersion: 2, scannedThrough: started.toISOString() }, db);
    await touchWatermarks({ lastVerifiedAt: started.toISOString() }, db);
    await db`DELETE FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${windowKey}`;
    await db`DELETE FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${collectionProgressKey(window.roundId)}`;
  });
  return { ...collected, ...result, outcome: result.reviewed ? "needs_review" : "completed", complete: true, pushed: await flushResetPushes(), pending: 0, verifiedAt: started.toISOString() };
}
