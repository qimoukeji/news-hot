// Each round stores successful pages and advances coverage only after context and recognition finish.
import { randomUUID } from "node:crypto";
import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import type { CodexResetContextPost } from "../contracts.ts";
import { SITE } from "@aihot/site";
import { shutdownSignal } from "@aihot/backend/lib/shutdown";
import { getTweet, searchTweets, tweetText, type Tweet as SdTweet } from "./providers/collectors.ts";
import { completeReceipt, retireMonitorUnknownReceipts } from "@aihot/backend/providers/receipts";
import { deliverContent } from "@aihot/backend/notify/deliver";
import { applyRecognition } from "./assemble.ts";
import { recognizePost, type ContextInput, type OpenEventInput } from "./recognize.ts";
import { bjIso, codexResetsSnapshot, MONITOR_PAGE_URL } from "./read.ts";
import { AUTHOR, cursorKey, watermarksKey } from "../config.ts";
export { AUTHOR };
const PUSH_MAX_AGE_MS = 36 * 3600_000;

async function getState<T>(key: string): Promise<T | null> {
  const [row] = await sql<{ value: T }[]>`SELECT value FROM monitor_state WHERE key = ${key}`;
  return row?.value ?? null;
}
async function setState(key: string, value: unknown) {
  await sql`INSERT INTO monitor_state (key, value) VALUES (${key}, ${sql.json(value as never)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
async function touchWatermarks(patch: Record<string, string>) {
  await sql`INSERT INTO monitor_state (key, value) VALUES (${watermarksKey()}, ${sql.json(patch)})
    ON CONFLICT (key) DO UPDATE SET value = monitor_state.value || EXCLUDED.value, updated_at = now()`;
}

interface Cursor { checkpointVersion: 2; scannedThrough?: string }
type ScanOptions = { lookbackHours?: number; initialRange?: { since: string; until: string }; startedAt?: Date; roundId?: string };

/** Remove obsolete control data without deleting paid history or business review decisions. */
export async function cleanupMonitorCollectionState() {
  await sql.begin(async tx => {
    const installed = await tx`INSERT INTO monitor_state (key, value) VALUES ('collection:cleanup:v2', '{"completed":true}'::jsonb)
      ON CONFLICT (key) DO NOTHING RETURNING key`;
    if (!installed.length) return;
    const legacy = await tx<{ key: string; value: { checkpointVersion?: number; scannedThrough?: string } }[]>`
      SELECT key, value FROM monitor_state WHERE key LIKE 'cursor:%' AND value->>'checkpointVersion' IS DISTINCT FROM '2' FOR UPDATE`;
    for (const row of legacy) {
      const [watermark] = await tx<{ value: { lastVerifiedAt?: string } }[]>`SELECT value FROM monitor_state WHERE key = ${row.key.replace('cursor:', 'watermarks:')}`;
      const verified = watermark?.value.lastVerifiedAt;
      await tx`UPDATE monitor_state SET value = ${tx.json({ checkpointVersion: 2, ...(verified && Number.isFinite(Date.parse(verified)) ? { scannedThrough: verified } : {}) })}, updated_at = now() WHERE key = ${row.key}`;
    }
    await tx`DELETE FROM monitor_state WHERE key LIKE 'context:%' OR key LIKE 'failures:%'`;
    await retireMonitorUnknownReceipts(tx);
  });
}

async function recordPostFailure(id: string, phase: "context" | "recognition", error: unknown) {
  const receiptId = error && typeof error === "object" && "receiptId" in error ? error.receiptId : null;
  await sql`UPDATE monitor_posts SET raw = coalesce(raw, '{}'::jsonb) || ${sql.json({ collectionFailure: {
    phase, at: new Date().toISOString(), error: String(error).slice(0, 1000), ...(typeof receiptId === "number" ? { receiptId } : {}),
  } })} WHERE id = ${id} AND processed_at IS NULL`;
}

async function contextOf(t: SdTweet, subject: string, withReplies = true, roundId?: string): Promise<Array<ContextInput & { url: string }>> {
  const out: Array<ContextInput & { url: string }> = [];
  const push = (x: SdTweet, relation: "reply" | "quote") =>
    out.push({ id: x.id_str, author: x.user.screen_name, relation, text: tweetText(x), publishedAt: new Date(x.tweet_created_at).toISOString(), url: `https://x.com/i/status/${x.id_str}` });
  if (t.quoted_status) push(t.quoted_status, "quote");
  let parentId = withReplies ? t.in_reply_to_status_id_str ?? null : null;
  for (let depth = 0; parentId && depth < 2; depth++) {
    const [stored] = await sql<{ tweet: SdTweet | null }[]>`SELECT raw->'tweet' AS tweet FROM monitor_posts WHERE id = ${parentId}`;
    const parent = stored?.tweet ?? await getTweet(parentId, { purpose: "monitor.context", subject, roundId });
    if (!parent) break; // a definitive missing post is valid unavailable context, not a transport failure
    push(parent, "reply");
    if (parent.quoted_status && depth === 0) push(parent.quoted_status, "quote");
    parentId = parent.in_reply_to_status_id_str ?? null;
  }
  return out;
}
async function storePost(t: SdTweet) {
  const context = await contextOf(t, `x:${t.id_str}`, false);
  const inserted = await sql`
    INSERT INTO monitor_posts (id, author, published_at, text, url, context, raw, origin)
    VALUES (${t.id_str}, ${t.user.screen_name}, ${new Date(t.tweet_created_at)}, ${tweetText(t)}, ${`https://x.com/${AUTHOR}/status/${t.id_str}`},
      ${sql.json(context.map(c => ({ id: c.id, author: c.author, relation: c.relation, text: null, originalText: c.text, url: c.url })) as never)},
      ${sql.json({ tweet: t, context, contextPending: !!t.in_reply_to_status_id_str } as never)}, 'live')
    ON CONFLICT (id) DO NOTHING`;
  return inserted.count;
}

/** A failure aborts context collection; the next scheduled round gets independent request keys. */
export async function collectPendingContext(limit = Infinity, roundId = randomUUID()): Promise<{ completed: number }> {
  const result = { completed: 0 };
  if (process.env.COLLECT_ENABLED !== "true") return result;
  const posts = await sql<{ id: string; raw: { tweet: SdTweet } }[]>`
    SELECT id, raw FROM monitor_posts
    WHERE author = ${AUTHOR} AND processed_at IS NULL AND raw->>'contextPending' = 'true'
    ORDER BY published_at, id ${Number.isFinite(limit) ? sql`LIMIT ${limit}` : sql``}`;
  for (const p of posts) {
    shutdownSignal.signal.throwIfAborted();
    let context: Array<ContextInput & { url: string }>;
    try { context = await contextOf(p.raw.tweet, `x:${p.id}`, true, roundId); }
    catch (error) { await recordPostFailure(p.id, "context", error); throw error; }
    await sql`UPDATE monitor_posts SET
      context = ${sql.json(context.map(c => ({ id: c.id, author: c.author, relation: c.relation, text: null, originalText: c.text, url: c.url })) as never)},
      raw = (raw - 'collectionFailure') || ${sql.json({ context, contextPending: false } as never)}
      WHERE id = ${p.id} AND processed_at IS NULL AND raw->>'contextPending' = 'true'`;
    result.completed++;
  }
  return result;
}

/** Collect every page within the fixed window. This function never advances successful coverage. */
export async function collectPosts(opts: ScanOptions = {}): Promise<{ stored: number; pages: number }> {
  if (process.env.COLLECT_ENABLED !== "true") return { stored: 0, pages: 0 };
  const started = opts.startedAt ?? new Date();
  const cursor = await getState<Cursor>(cursorKey());
  const checkpoint = cursor?.checkpointVersion === 2 ? cursor.scannedThrough : undefined;
  const range = opts.initialRange;
  if (range && (checkpoint || opts.lookbackHours !== undefined)) throw new Error("initialRange requires a new collector checkpoint and cannot be combined with lookback");
  if (range && (!Number.isFinite(Date.parse(range.since)) || !Number.isFinite(Date.parse(range.until))
    || Date.parse(range.since) >= Date.parse(range.until) || Date.parse(range.until) > started.getTime())) throw new Error("initialRange must be a valid past interval");
  if (opts.lookbackHours !== undefined && (!Number.isFinite(opts.lookbackHours) || opts.lookbackHours <= 0)) throw new Error("lookbackHours must be positive");
  if (!range && opts.lookbackHours === undefined && !checkpoint) {
    throw new Error("Monitor collection is not initialized; run npm run initialize -w @aihot/codex-reset -- --since <ISO> --until <ISO> before normal scanning");
  }
  if (checkpoint && (!Number.isFinite(Date.parse(checkpoint)) || Date.parse(checkpoint) > started.getTime())) throw new Error("Monitor success checkpoint must be a valid past time");
  const since = opts.lookbackHours !== undefined ? started.getTime() - opts.lookbackHours * 3600_000 : range ? Date.parse(range.since) : Date.parse(checkpoint!);
  const until = range ? Date.parse(range.until) : started.getTime();
  const query = `from:${AUTHOR} since_time:${Math.floor(since / 1000)} until_time:${Math.floor(until / 1000)}`;
  const roundId = opts.roundId ?? randomUUID();
  const purpose = opts.lookbackHours !== undefined ? "monitor.lookback" : "monitor.scan";
  let cursorPage: string | null = null;
  let stored = 0; let pages = 0;
  const visited = new Set<string>();
  do {
    shutdownSignal.signal.throwIfAborted();
    const res = await searchTweets(query, { purpose, subject: `x:${AUTHOR}`, window: roundId, cursor: cursorPage });
    pages++;
    for (const t of res.tweets) {
      if (!t.retweeted_status) stored += await storePost(t);
    }
    await completeReceipt(sql, res.receiptId);
    cursorPage = res.nextCursor;
    if (cursorPage && visited.has(cursorPage)) throw new Error("Collection returned a repeated page cursor; coverage remains incomplete");
    if (cursorPage) visited.add(cursorPage);
  } while (cursorPage);
  await touchWatermarks({ lastCollectedAt: started.toISOString() });
  return { stored, pages };
}

async function openEvents(before: Date, context: ContextInput[]): Promise<OpenEventInput[]> {
  const contextIds = [...new Set(context.map(post => post.id))];
  const fromContext = contextIds.length ? sql`EXISTS (
    SELECT 1 FROM monitor_event_posts source WHERE source.event_id = e.id AND source.post_id IN ${sql(contextIds)}
  )` : sql`false`;
  const rows = await sql<{ id: string; type: OpenEventInput["kind"]; status: OpenEventInput["status"]; schedule: { label: string } | null; scope: string | null; first_at: Date; excerpt: string }[]>`
    WITH candidates AS (
    SELECT e.id, e.type, e.status, e.schedule, e.presentation->>'scopeLabel' AS scope, min(p.published_at) AS first_at,
      (SELECT ep.original_text FROM monitor_event_posts ep JOIN monitor_posts pp ON pp.id = ep.post_id WHERE ep.event_id = e.id ORDER BY pp.published_at, pp.id LIMIT 1) AS excerpt,
      ${fromContext} AS from_context
    FROM monitor_events e JOIN monitor_event_posts l ON l.event_id = e.id JOIN monitor_posts p ON p.id = l.post_id
    WHERE NOT e.withdrawn AND e.created_at <= ${before} AND (${fromContext}
      OR ((e.status = 'announced' OR e.confirmation_basis = 'receipt_review' AND e.confirmed_at IS NULL) AND e.created_at >= ${new Date(before.getTime() - 72 * 3600_000)}
           OR e.confirmed_at >= ${new Date(before.getTime() - 48 * 3600_000)}))
    GROUP BY e.id)
    SELECT * FROM candidates WHERE from_context OR id IN (
      SELECT id FROM candidates WHERE NOT from_context ORDER BY first_at DESC, id LIMIT 8
    ) ORDER BY from_context DESC, first_at DESC, id`;
  return rows.map((r) => ({ id: r.id, kind: r.type, status: r.status, firstPostAt: r.first_at.toISOString(), excerpt: r.excerpt, schedule: r.schedule?.label ?? null, scope: r.scope }));
}

type NotifyAction = "announce" | "confirm" | "amend" | "withdraw";

const KIND_NAME = (type: string) => (type === "reset_credit" ? "重置卡发放" : "Codex 额度重置");
const HEADLINE: Record<NotifyAction, (kind: string) => string> = {
  announce: (k) => `${k}：Tibo 已宣布`,
  confirm: (k) => `${k}已完成（Tibo 确认）`,
  amend: (k) => `${k}：安排有更新`,
  withdraw: (k) => `${k}：Tibo 撤回了预告`,
};
const bjStamp = (iso: string) => `${iso.slice(5, 16).replace("T", " ")}`;
interface PushPost {
  post_id: string;
  published_at: Date;
  text: string;
  originalText: string;
  context: CodexResetContextPost[];
  notify: Array<{ eventId: string; action: NotifyAction }>;
}

/**
 * One card per post, however many resets it speaks of: the conclusion first, each reset's expected time
 * (or confirmation time, or withdrawal), the audience, the outage it follows, the question a short reply
 * answers, Tibo's words in Chinese and the links.
 */
function resetPostCard(post: PushPost, entries: Array<{ eventId: string; action: NotifyAction }>, snapshot: Awaited<ReturnType<typeof codexResetsSnapshot>>, withdrawn: Map<string, { type: string }>) {
  type Event = (typeof snapshot.events)[number];
  const described = entries.flatMap((n): Array<{ eventId: string; action: NotifyAction; type: string; e: Event | null }> => {
    const e = snapshot.events.find((x) => x.id === n.eventId);
    if (e) return [{ ...n, type: e.type, e }];
    const w = withdrawn.get(n.eventId);
    return n.action === "withdraw" && w ? [{ ...n, type: w.type, e: null }] : [];
  });
  if (!described.length) return null;
  const primary = described[0]!;
  const lines: string[] = [];
  for (const [i, d] of described.entries()) {
    if (i > 0) lines.push(`**${HEADLINE[d.action](KIND_NAME(d.type))}**`);
    const window = d.e?.estimate ?? d.e?.schedule;
    if ((d.action === "announce" || d.action === "amend") && window) lines.push(`**预计生效**：${window.label}${d.e?.estimate ? `（${SITE.name} 推算）` : ""}`);
    if (d.action === "confirm" && d.e?.confirmedAt) lines.push(`**确认时间**：北京时间 ${bjStamp(d.e.confirmedAt)}（确认帖时间，不是精确到账时间）`);
    if (d.action === "withdraw") lines.push("此前宣布的这次安排已撤回，以 Codex 内显示为准。");
  }
  const scoped = described.find((d) => d.e)?.e;
  if (scoped) lines.push(`**适用范围**：${scoped.presentation?.audienceZh ?? scoped.presentation?.scopeLabel ?? "未说明"}${scoped.presentation?.productsZh ? ` · ${scoped.presentation.productsZh}` : ""}`);
  const outage = snapshot.outage && described.some((d) => d.eventId === snapshot.outage!.resetEventId) ? snapshot.outage : null;
  if (outage?.publishedAt) lines.push(`**起因**：${bjStamp(outage.publishedAt)} Tibo 确认 Codex 故障${outage.recoveredAt ? `，${bjStamp(outage.recoveredAt).slice(6)} 恢复` : ""}`);
  const words = post.text;
  // A short reply needs the question it answers.
  const parent = post.originalText.length <= 120 ? post.context.find((c) => (c.text ?? c.originalText).replace(/[^\p{L}\p{N}]/gu, "").length >= 8) : undefined;
  const title = HEADLINE[primary.action](KIND_NAME(primary.type));
  const tone = primary.action === "confirm" ? "turquoise" : primary.action === "withdraw" ? "grey" : "orange";
  return {
    header: { title: { tag: "plain_text", content: title }, template: tone },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      parent ? { tag: "div", text: { tag: "lark_md", content: `${parent.relation === "quote" ? "引用" : "回复"} @${parent.author}：${(parent.text ?? parent.originalText).slice(0, 160)}` } } : null,
      words ? { tag: "div", text: { tag: "lark_md", content: `> ${words.replace(/\n/g, "\n> ")}` } } : null,
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "查看原帖" }, url: `https://x.com/${AUTHOR}/status/${post.post_id}`, type: "default" },
          { tag: "button", text: { tag: "plain_text", content: "打开重置监控" }, url: MONITOR_PAGE_URL, type: "primary" },
        ],
      },
    ].filter(Boolean),
  };
}

/** Process all pending posts in publication order. Failed recognition aborts the round. */
export async function processPending(limit = Infinity, roundId = randomUUID()): Promise<{ processed: number; failed: number }> {
  if (!config.modelCallsEnabled) return { processed: 0, failed: 0 };
  const posts = await sql<{ id: string; text: string; published_at: Date; raw: { contextPending?: boolean; context?: Array<ContextInput & { url: string }> } | null }[]>`
    SELECT id, text, published_at, raw FROM monitor_posts WHERE processed_at IS NULL AND author = ${AUTHOR}
    ORDER BY published_at, id ${Number.isFinite(limit) ? sql`LIMIT ${limit}` : sql``}`;
  let processed = 0;
  for (const p of posts) {
    shutdownSignal.signal.throwIfAborted();
    if (p.raw?.contextPending) break;
    const [current] = await sql`SELECT 1 FROM monitor_posts WHERE id = ${p.id} AND processed_at IS NULL`;
    if (!current) continue; // manual review may have completed it while earlier posts were processed
    try {
      const rec = await recognizePost({ id: p.id, text: p.text, publishedAt: p.published_at.toISOString(), context: p.raw?.context ?? [], openEvents: await openEvents(p.published_at, p.raw?.context ?? []), roundId });
      await applyRecognition(p.id, rec);
    } catch (error) { await recordPostFailure(p.id, "recognition", error); throw error; }
    await sql`UPDATE monitor_posts SET raw = raw - 'collectionFailure' WHERE id = ${p.id} AND raw ? 'collectionFailure'`;
    processed++;
  }
  return { processed, failed: 0 };
}

/**
 * Sends the pushes processed posts owe (stored with their recognition), oldest first: after a normal
 * recognition, and after a stop between recognizing a post and delivering its push. One card per post
 * and group slot (the key of its first push, as earlier cards were keyed), so nothing is sent twice;
 * a change or withdrawal is told only where the announcement itself went out; pushes older than 36
 * hours are dropped.
 */
export async function flushResetPushes(): Promise<number> {
  const posts = await sql<PushPost[]>`
    SELECT p.id AS post_id, p.published_at, p.recognition->'notify' AS notify,
      coalesce(p.translation, p.text) AS text, p.text AS "originalText", p.context
    FROM monitor_posts p
    WHERE p.processed_at IS NOT NULL AND p.author = ${AUTHOR} AND p.published_at > ${new Date(Date.now() - PUSH_MAX_AGE_MS)}
      AND jsonb_array_length(coalesce(p.recognition->'notify', '[]'::jsonb)) > 0
    ORDER BY p.published_at, p.id`;
  if (!posts.length) return 0;
  let snapshot: Awaited<ReturnType<typeof codexResetsSnapshot>> | null = null;
  let pushed = 0;
  const targets = await sql<{ key: string; enabled_at: Date | null }[]>`SELECT key, enabled_at FROM notify_targets WHERE purpose = 'content' AND enabled`;
  for (const p of posts) {
    for (const target of targets) {
      if (target.enabled_at && p.published_at < target.enabled_at) continue;
      const entries: Array<{ eventId: string; action: NotifyAction }> = [];
      for (const n of p.notify) {
        if (n.action === "amend" || n.action === "withdraw") {
          // A post can announce several events in one card, whose subject is only the first event.
          // Its saved recognition preserves the others. Corrections in that post do not establish
          // delivery: they may have been omitted for a group that never received the announcement.
          const [told] = await sql`
            SELECT 1 FROM deliveries d LEFT JOIN monitor_posts original ON original.id = split_part(d.dedupe_key, ':', 2)
            WHERE d.subject_kind = 'codex_reset' AND d.target_key = ${target.key}
              AND d.status IN ('sent', 'unknown', 'sending') AND d.dedupe_key NOT LIKE ${`codex:${p.post_id}:%`}
              AND (d.subject_id = ${n.eventId} OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(coalesce(original.recognition->'notify', '[]'::jsonb)) entry
                WHERE entry->>'eventId' = ${n.eventId} AND entry->>'action' IN ('announce', 'confirm')
              )) LIMIT 1`;
          if (!told) continue;
        }
        entries.push(n);
      }
      if (!entries.length) continue;
      const dedupeKey = `codex:${p.post_id}:${entries[0]!.eventId}:${entries[0]!.action}`;
      const [delivered] = await sql`SELECT 1 FROM deliveries WHERE target_key = ${target.key} AND dedupe_key = ${dedupeKey}`;
      if (delivered) continue;
      snapshot ??= await codexResetsSnapshot();
      const gone = entries.filter((e) => e.action === "withdraw").map((e) => e.eventId);
      const withdrawn = new Map(gone.length ? (await sql<{ id: string; type: string }[]>`SELECT id, type FROM monitor_events WHERE id IN ${sql(gone)}`).map((r) => [r.id, r]) : []);
      const card = resetPostCard(p, entries, snapshot, withdrawn);
      if (!card) continue;
      const results = await deliverContent({ subjectKind: "codex_reset", subjectId: entries[0]!.eventId, dedupeKey, contentAt: p.published_at, card, targetKey: target.key });
      pushed += results.filter((r) => r.status === "sent").length;
    }
  }
  return pushed;
}

/** One scheduled run owns the checkpoint; a concurrent trigger skips instead of queuing. */
export async function monitorTick(opts: { lookbackHours?: number; initialRange?: { since: string; until: string } } = {}) {
  const connection = await sql.reserve();
  try {
    const [lock] = await connection<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('monitor.tick')) AS acquired`;
    if (!lock?.acquired) return { skipped: true, reason: "busy" };
    try { return await tick(opts); }
    finally { await connection`SELECT pg_advisory_unlock(hashtext('monitor.tick'))`; }
  } finally { connection.release(); }
}
async function tick(opts: { lookbackHours?: number; initialRange?: { since: string; until: string } }) {
  const started = new Date(); const roundId = randomUUID();
  await cleanupMonitorCollectionState();
  await touchWatermarks({ lastAttemptAt: started.toISOString() });
  const collected = await collectPosts({ ...opts, startedAt: started, roundId });
  const context = await collectPendingContext(Infinity, roundId);
  const result = await processPending(Infinity, roundId);
  const [pending] = await sql<{ n: number }[]>`SELECT count(*) FILTER (WHERE processed_at IS NULL)::int AS n FROM monitor_posts WHERE author = ${AUTHOR}`;
  const complete = process.env.COLLECT_ENABLED === "true" && config.modelCallsEnabled && !pending?.n;
  if (!complete) throw new Error(`Monitor round incomplete: ${pending?.n ?? 0} posts pending; collection and model calls must be enabled`);
  // Business review does not mean the transport or recognition failed.
  if (opts.lookbackHours === undefined) {
    const through = opts.initialRange ? new Date(Math.floor(Date.parse(opts.initialRange.until) / 1000) * 1000).toISOString() : started.toISOString();
    await setState(cursorKey(), { checkpointVersion: 2, scannedThrough: through });
    await touchWatermarks({ lastVerifiedAt: started.toISOString() });
  }
  const pushed = await flushResetPushes();
  return { ...collected, ...result, context, pushed, pending: 0, verifiedAt: opts.lookbackHours === undefined ? bjIso(started) : null };
}
