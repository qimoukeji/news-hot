import { monitor as currentMonitor, monitorId, authorHandles, authorNameFor, purpose as requestPurpose, auditAction, auditSubject, type ResetMonitorBackendDefinition } from "./context.ts";
// Each round stores successful pages and advances coverage only after context and recognition finish.
import { randomUUID } from "node:crypto";
import { config } from "@aihot/backend/config";
import { sql, type Db } from "@aihot/backend/db";
import type { ResetMonitorContextPost } from "../contracts.ts";
import { SITE } from "@aihot/site";
import { shutdownSignal } from "@aihot/backend/lib/shutdown";
import { getTweet, searchTweets, tweetText, type Tweet as SdTweet } from "./providers/collectors.ts";
import type { SearchResult } from "@aihot/backend/providers/socialdata";
import { completeReceipt, retireMonitorUnknownReceipts } from "@aihot/backend/providers/receipts";
import { deliverContent } from "@aihot/backend/notify/deliver";
import { applyRecognition } from "./assemble.ts";
import { recognizePost, type ContextInput, type OpenEventInput } from "./recognize.ts";
import { bjIso, resetsSnapshot, monitorPageUrl } from "./read.ts";
import { cursorKey, watermarksKey } from "../config.ts";
import { sourceContentIssue, markIncompleteSource } from "./source-completeness.ts";
import { advanceInitialCollection, collectionQueries, collectionQueriesFor, initialCollection, initialCollectionKey } from "./initial-collection.ts";
import { authorCollectionSince, collectionSegments, prepareCollectionCoverage } from "./collection-coverage.ts";

const PUSH_MAX_AGE_MS = 36 * 3600_000;

async function getState<T>(key: string): Promise<T | null> {
  const [row] = await sql<{ value: T }[]>`SELECT value FROM (SELECT * FROM monitor_state WHERE monitor_id = ${monitorId()}) AS monitor_state WHERE key = ${key}`;
  return row?.value ?? null;
}
async function setState(key: string, value: unknown, db: Db = sql) {
  await db`INSERT INTO monitor_state (monitor_id, key, value) VALUES (${monitorId()}, ${key}, ${db.json(value as never)}) ON CONFLICT (monitor_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
async function touchWatermarks(patch: Record<string, string>, db: Db = sql) {
  await db`INSERT INTO monitor_state (monitor_id, key, value) VALUES (${monitorId()}, ${watermarksKey()}, ${db.json(patch)})
    ON CONFLICT (monitor_id, key) DO UPDATE SET value = monitor_state.value || EXCLUDED.value, updated_at = now()`;
}

interface Cursor { checkpointVersion: 2; scannedThrough?: string }
type ScanOptions = { lookbackHours?: number; initialRange?: { since: string; until: string }; startedAt?: Date; roundId?: string };

/** Remove obsolete control data without deleting paid history or business review decisions. */
export async function cleanupMonitorCollectionState() {
  await sql.begin(async tx => {
    const installed = await tx`INSERT INTO monitor_state (monitor_id, key, value) VALUES (${monitorId()}, 'collection:cleanup:v2', '{"completed":true}'::jsonb)
      ON CONFLICT (monitor_id, key) DO NOTHING RETURNING key`;
    if (!installed.length) return;
    const legacy = await tx<{ key: string; value: { checkpointVersion?: number; scannedThrough?: string } }[]>`
      SELECT key, value FROM (SELECT * FROM monitor_state WHERE monitor_id = ${monitorId()}) AS monitor_state WHERE key LIKE 'cursor:%' AND value->>'checkpointVersion' IS DISTINCT FROM '2' FOR UPDATE`;
    for (const row of legacy) {
      const [watermark] = await tx<{ value: { lastVerifiedAt?: string } }[]>`SELECT value FROM (SELECT * FROM monitor_state WHERE monitor_id = ${monitorId()}) AS monitor_state WHERE key = ${row.key.replace('cursor:', 'watermarks:')}`;
      const verified = watermark?.value.lastVerifiedAt;
      await tx`UPDATE monitor_state SET value = ${tx.json({ checkpointVersion: 2, ...(verified && Number.isFinite(Date.parse(verified)) ? { scannedThrough: verified } : {}) })}, updated_at = now() WHERE monitor_id = ${monitorId()} AND (key = ${row.key}) `;
    }
    await tx`DELETE FROM monitor_state WHERE monitor_id = ${monitorId()} AND (key LIKE 'context:%' OR key LIKE 'failures:%') `;
    await retireMonitorUnknownReceipts(tx, [requestPurpose("scan"), requestPurpose("lookback"), requestPurpose("context"), requestPurpose("recognize")]);
  });
}

async function recordPostFailure(id: string, phase: "context" | "recognition", error: unknown) {
  const receiptId = error && typeof error === "object" && "receiptId" in error ? error.receiptId : null;
  await sql`UPDATE monitor_posts SET raw = coalesce(raw, '{}'::jsonb) || ${sql.json({ collectionFailure: {
    phase, at: new Date().toISOString(), error: String(error).slice(0, 1000), ...(typeof receiptId === "number" ? { receiptId } : {}),
  } })} WHERE monitor_id = ${monitorId()} AND (id = ${id} AND processed_at IS NULL) `;
}

async function contextOf(t: SdTweet, subject: string, withReplies = true, roundId?: string, resume = false): Promise<Array<ContextInput & { url: string }>> {
  const out: Array<ContextInput & { url: string }> = [];
  const push = (x: SdTweet, relation: "reply" | "quote") =>
    out.push({ id: x.id_str, author: x.user.screen_name, relation, text: tweetText(x), publishedAt: new Date(x.tweet_created_at).toISOString(), url: `https://x.com/i/status/${x.id_str}` });
  if (t.quoted_status) push(t.quoted_status, "quote");
  let parentId = withReplies ? t.in_reply_to_status_id_str ?? null : null;
  for (let depth = 0; parentId && depth < 2; depth++) {
    const [stored] = await sql<{ tweet: SdTweet | null }[]>`SELECT raw->'tweet' AS tweet FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts WHERE id = ${parentId}`;
    const parent = stored?.tweet ?? await getTweet(parentId, { purpose: requestPurpose("context"), subject, roundId, resume });
    if (!parent) break; // a definitive missing post is valid unavailable context, not a transport failure
    push(parent, "reply");
    if (parent.quoted_status && depth === 0) push(parent.quoted_status, "quote");
    parentId = parent.in_reply_to_status_id_str ?? null;
  }
  return out;
}
async function storePost(t: SdTweet, db: Db = sql, filter: ResetMonitorBackendDefinition["collectionFilter"] | null = currentMonitor().collectionFilter) {
  if (!includedInCollection(t, filter)) return 0;
  const context = await contextOf(t, `x:${t.id_str}`, false);
  const handle = currentMonitor().authors.find((a) => a.handle.toLowerCase() === t.user.screen_name.toLowerCase())!.handle;
  const inserted = await db`
    INSERT INTO monitor_posts (monitor_id, id, author, published_at, text, url, context, raw, origin)
    VALUES (${monitorId()}, ${t.id_str}, ${handle}, ${new Date(t.tweet_created_at)}, ${tweetText(t)}, ${`https://x.com/${handle}/status/${t.id_str}`},
      ${db.json(context.map(c => ({ id: c.id, author: c.author, relation: c.relation, text: null, originalText: c.text, url: c.url })) as never)},
      ${db.json({ tweet: t, context, contextPending: !!t.in_reply_to_status_id_str,
        collectionFilter: { version: filter?.version ?? null, signature: filter?.signature ?? null, accepted: true } } as never)}, 'live')
    ON CONFLICT (monitor_id, id) DO NOTHING`;
  return inserted.count;
}

function includedInCollection(t: SdTweet, filter: ResetMonitorBackendDefinition["collectionFilter"] | null = currentMonitor().collectionFilter): boolean {
  return filter?.accepts({ text: tweetText(t), isReply: !!(t.in_reply_to_status_id_str || t.in_reply_to_screen_name) }) ?? true;
}

/** Preserve posts collected before an operator narrowed the scope, without buying their context or recognition. */
export async function screenPendingPosts(): Promise<number> {
  const filter = currentMonitor().collectionFilter;
  if (!filter) return 0;
  const posts = await sql<{ id: string; raw: { tweet?: SdTweet } | null }[]>`SELECT id,raw FROM monitor_posts
    WHERE monitor_id = ${monitorId()} AND lower(author) = ANY(${authorHandles()}::text[]) AND processed_at IS NULL
      AND recognition IS NULL AND NOT coalesce(raw,'{}'::jsonb) ? 'collectionFilter'`;
  const excluded = posts.filter(p => p.raw?.tweet && !includedInCollection(p.raw.tweet)).map(p => p.id);
  if (!excluded.length) return 0;
  const basis = { version: filter.version, reason: filter.reason, accepted: false };
  const changed = await sql`UPDATE monitor_posts SET
    recognition = ${sql.json({ relevant: false, needsReview: false, propositions: [], collectionFilter: basis })},
    raw = (coalesce(raw,'{}'::jsonb) - 'collectionFailure') || ${sql.json({ contextPending: false, collectionFilter: basis })},
    processed_at = now()
    WHERE monitor_id = ${monitorId()} AND id IN ${sql(excluded)} AND processed_at IS NULL
      AND recognition IS NULL AND NOT coalesce(raw,'{}'::jsonb) ? 'collectionFilter'`;
  return changed.count;
}

/** A failure aborts context collection; the next scheduled round gets independent request keys. */
export async function collectPendingContext(limit = Infinity, roundId: string = randomUUID(), resume = false): Promise<{ completed: number }> {
  const result = { completed: 0 };
  if (process.env.COLLECT_ENABLED !== "true") return result;
  const posts = await sql<{ id: string; raw: { tweet: SdTweet } }[]>`
    SELECT id, raw FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts
    WHERE lower(author) = ANY(${authorHandles()}::text[]) AND processed_at IS NULL AND raw->>'contextPending' = 'true'
    ORDER BY published_at, id ${Number.isFinite(limit) ? sql`LIMIT ${limit}` : sql``}`;
  for (const p of posts) {
    shutdownSignal.signal.throwIfAborted();
    let context: Array<ContextInput & { url: string }>;
    try { context = await contextOf(p.raw.tweet, `x:${p.id}`, true, roundId, resume); }
    catch (error) { await recordPostFailure(p.id, "context", error); throw error; }
    await sql`UPDATE monitor_posts SET
      context = ${sql.json(context.map(c => ({ id: c.id, author: c.author, relation: c.relation, text: null, originalText: c.text, url: c.url })) as never)},
      raw = (raw - 'collectionFailure') || ${sql.json({ context, contextPending: false } as never)}
      WHERE monitor_id = ${monitorId()} AND (id = ${p.id} AND processed_at IS NULL AND raw->>'contextPending' = 'true') `;
    result.completed++;
  }
  return result;
}

/** Collect every page within the fixed window. This function never advances successful coverage. */
export async function collectPosts(opts: ScanOptions = {}): Promise<{ stored: number; pages: number }> {
  if (!opts.initialRange) {
    const [unfinished] = await sql`SELECT key FROM monitor_state WHERE monitor_id=${monitorId()} AND key LIKE 'initial:%' LIMIT 1`;
    if (unfinished) throw new Error("Monitor has unfinished initialization; complete the original range and configuration before scanning or lookback");
  }
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
    throw new Error(`Monitor collection is not initialized; run npm run initialize -w @aihot/${currentMonitor().moduleName} -- --since <ISO> --until <ISO> before normal scanning`);
  }
  if (checkpoint && (!Number.isFinite(Date.parse(checkpoint)) || Date.parse(checkpoint) > started.getTime())) throw new Error("Monitor success checkpoint must be a valid past time");
  const since = opts.lookbackHours !== undefined ? started.getTime() - opts.lookbackHours * 3600_000 : range ? Date.parse(range.since) : Date.parse(checkpoint!);
  const until = range ? Date.parse(range.until) : started.getTime();
  const roundId = opts.roundId ?? randomUUID();
  const purpose = opts.lookbackHours !== undefined ? requestPurpose("lookback") : requestPurpose("scan");
  // Explicit initialization owns its requested historical range. Scheduled scans observe
  // configuration changes first, so new accounts and scopes cannot backfill silently.
  // Legacy checkpoints are a successful upper bound, not a historical lower bound:
  // preserve their 24-hour lookback instead of claiming a known collection start.
  const coverage = range ? null : await prepareCollectionCoverage(started.toISOString(), null, checkpoint);
  const originalQueries = range ? collectionQueries(since, until) : [];
  const supplementalQueries = range ? collectionQueries(since, until, true) : [];
  let progress = range ? initialCollection(originalQueries, await getState(initialCollectionKey()), supplementalQueries) : null;
  type QueryScope = { query: string; since: number; until: number; filter: ResetMonitorBackendDefinition["collectionFilter"]; historical: boolean };
  const jobs: QueryScope[] = progress ? progress.queries.map(query => ({ query, since, until, filter: currentMonitor().collectionFilter, historical: false }))
    : currentMonitor().authors.flatMap(author => collectionSegments(coverage!, authorCollectionSince(coverage!, author.handle, since), until)
      // Search boundaries have second precision. Round the upper bound outwards and
      // enforce the exact segment locally so a subsecond scope change cannot leave a gap.
      .flatMap(segment => [false, true].flatMap(supplemental => collectionQueriesFor(segment.filter, [author], segment.since, Math.ceil(segment.until / 1000) * 1000, supplemental)
        .map(query => ({ ...segment, query, historical: segment.until < until })))));
  if (progress) {
    await prepareCollectionCoverage(started.toISOString(), new Date(since).toISOString(), undefined, true);
    await setState(initialCollectionKey(), progress);
  }
  let stored = 0; let pages = 0;
  for (let index = progress?.queryIndex ?? 0; index < jobs.length; index++) {
      const job = jobs[index]!; const query = job.query;
      const handle = query.split(" ")[0]!.slice(5);
      let cursorPage: string | null = progress?.cursor ?? null;
      const visited = new Set<string>();
      do {
        shutdownSignal.signal.throwIfAborted();
        const res = await searchTweets(query, { purpose, subject: `x:${handle}`, window: progress?.pageWindow ?? roundId, cursor: cursorPage, resume: !!progress });
        pages++;
        const posts = res.tweets.filter(t => !t.retweeted_status && t.user.screen_name.toLowerCase() === handle
          && (range || Date.parse(t.tweet_created_at) >= job.since
            && (job.historical ? Date.parse(t.tweet_created_at) < job.until : Date.parse(t.tweet_created_at) <= job.until)));
        if (progress) {
          const next = advanceInitialCollection(progress, res.nextCursor);
          const inserted = await sql.begin(async tx => {
            let count = 0;
            for (const t of posts) count += await storePost(t, tx, job.filter ?? null);
            await completeReceipt(tx, res.receiptId);
            await setState(initialCollectionKey(), next, tx);
            return count;
          });
          stored += inserted;
          progress = next;
        } else {
          for (const t of posts) stored += await storePost(t, sql, job.filter ?? null);
          await completeReceipt(sql, res.receiptId);
        }
        cursorPage = res.nextCursor;
        if (cursorPage && visited.has(cursorPage)) throw new Error("Collection returned a repeated page cursor; coverage remains incomplete");
        if (cursorPage) visited.add(cursorPage);
      } while (cursorPage);
  }
  await touchWatermarks({ lastCollectedAt: started.toISOString() });
  return { stored, pages };
}

export async function openEvents(before: Date, context: ContextInput[]): Promise<OpenEventInput[]> {
  const contextIds = [...new Set(context.map(post => post.id))];
  const fromContext = contextIds.length ? sql`EXISTS (
    SELECT 1 FROM monitor_event_posts source WHERE source.monitor_id = ${monitorId()} AND source.event_id = e.id AND source.post_id IN ${sql(contextIds)}
  )` : sql`false`;
  const rows = await sql<{ id: string; type: OpenEventInput["kind"]; status: OpenEventInput["status"]; schedule: { label: string } | null; scope: string | null; products: string | null; bonus_credit: OpenEventInput["bonusCredit"]; first_at: Date; first_author: string; excerpt: string }[]>`
    WITH candidates AS (
    SELECT e.id, e.type, e.status, e.schedule, e.presentation->>'scopeLabel' AS scope, e.presentation->>'productsZh' AS products, e.presentation->'bonusCredit' AS bonus_credit, min(p.published_at) AS first_at,
      (SELECT ep.original_text FROM (SELECT * FROM monitor_event_posts WHERE monitor_id = ${monitorId()}) AS ep JOIN (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS pp ON pp.id = ep.post_id WHERE ep.event_id = e.id ORDER BY pp.published_at, pp.id LIMIT 1) AS excerpt,
      (array_agg(p.author ORDER BY p.published_at,p.id))[1] AS first_author,
      ${fromContext} AS from_context
    FROM (SELECT * FROM monitor_events WHERE monitor_id = ${monitorId()}) AS e JOIN (SELECT * FROM monitor_event_posts WHERE monitor_id = ${monitorId()}) AS l ON l.event_id = e.id JOIN (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS p ON p.id = l.post_id
    WHERE NOT e.withdrawn AND e.created_at <= ${before} AND (${fromContext}
      OR (e.type='bonus_credit' AND (e.status='announced' OR e.confirmation_basis='source_post')
        AND (e.presentation->'bonusCredit'->'claimDeadline'->>'at' IS NULL OR (e.presentation->'bonusCredit'->'claimDeadline'->>'at')::timestamptz > ${before})
        AND (e.presentation->'bonusCredit'->'expiresAt'->>'at' IS NULL OR (e.presentation->'bonusCredit'->'expiresAt'->>'at')::timestamptz > ${before}))
      OR e.type='reset_credit'
      OR ((e.status = 'announced' OR e.confirmation_basis = 'receipt_review' AND e.confirmed_at IS NULL) AND e.created_at >= ${new Date(before.getTime() - 72 * 3600_000)}
           OR e.confirmed_at >= ${new Date(before.getTime() - 48 * 3600_000)}))
    GROUP BY e.id, e.type, e.status, e.schedule, e.presentation)
    SELECT * FROM candidates WHERE from_context OR id IN (
      SELECT id FROM candidates WHERE NOT from_context ORDER BY (type='bonus_credit') DESC, first_at DESC, id LIMIT 8
    ) ORDER BY from_context DESC, (type='bonus_credit') DESC, first_at DESC, id`;
  return rows.map((r) => ({ id: r.id, kind: r.type, status: r.status, firstPostAt: r.first_at.toISOString(), firstPostAuthor: r.first_author, excerpt: r.excerpt, schedule: r.schedule?.label ?? null, scope: r.scope, productsZh: r.products,
    ...(r.type === "bonus_credit" ? { bonusCredit: r.bonus_credit } : {}) }));
}

type NotifyAction = "announce" | "confirm" | "amend" | "withdraw";

const KIND_NAME = (type: string) => (type === "reset_credit" ? "重置卡发放" : `${currentMonitor().product} 额度重置`);
const bonusHeadline: Record<NotifyAction, string> = { announce: "奖励额度活动：官方已宣布", confirm: "奖励额度活动可领取（不表示个人已到账）", amend: "奖励额度活动：条件有更新", withdraw: "奖励额度活动：官方已撤回" };
const headline = (action: NotifyAction, type: string, status?: string, author?: string) => type === "bonus_credit"
  ? action !== "withdraw" && status === "expired" ? "奖励额度活动：奖励已到期" : action !== "withdraw" && status === "claim_closed" ? "奖励额度活动：领取已截止" : action === "confirm" && status !== "available" ? "奖励额度活动：开放依据待核实" : bonusHeadline[action]
  : HEADLINE[action](KIND_NAME(type), author ? authorNameFor(author) : currentMonitor().authorName);
const HEADLINE: Record<NotifyAction, (kind: string, author: string) => string> = {
  announce: (k, author) => `${k}：${author} 已宣布`,
  confirm: (k, author) => `${k}已完成（${author} 确认）`,
  amend: (k) => `${k}：安排有更新`,
  withdraw: (k, author) => `${k}：${author} 撤回了预告`,
};
const bjStamp = (iso: string) => `${iso.slice(5, 16).replace("T", " ")}`;
interface PushPost {
  post_id: string;
  author: string;
  url: string;
  published_at: Date;
  text: string;
  originalText: string;
  context: ResetMonitorContextPost[];
  notify: Array<{ eventId: string; action: NotifyAction }>;
}

/**
 * One card per post, however many resets it speaks of: the conclusion first, each reset's expected time
 * (or confirmation time, or withdrawal), the audience, the outage it follows, the question a short reply
 * answers, ${currentMonitor().authorName}'s words in Chinese and the links.
 */
function resetPostCard(post: PushPost, entries: Array<{ eventId: string; action: NotifyAction }>, snapshot: Awaited<ReturnType<typeof resetsSnapshot>>, withdrawn: Map<string, { type: string }>) {
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
    if (i > 0) lines.push(`**${headline(d.action, d.type, d.e?.presentation?.status, post.author)}**`);
    if (d.type === "bonus_credit") {
      const bonus = d.e?.presentation?.bonusCredit;
      if (d.action === "confirm") lines.push(`**活动状态**：${d.e?.presentation?.status === "expired" ? "奖励已到期" : d.e?.presentation?.status === "claim_closed" ? "领取已截止" : d.e?.presentation?.status === "available" ? "符合资格者可领取" : "开放依据待核实"}，不表示个人已领取或到账。`);
      if (bonus?.amount) lines.push(`**奖励额度**：${bonus.amount}`);
      if (bonus?.eligibility) lines.push(`**资格条件**：${bonus.eligibility}`);
      if (bonus?.claimMethod) lines.push(`**领取方式**：${bonus.claimMethod}`);
      for (const [label, time] of [["领取截止", bonus?.claimDeadline], ["奖励到期", bonus?.expiresAt]] as const) lines.push(`**${label}**：${time?.at ? `北京时间 ${bjStamp(time.at)}（${time.source}）` : `${time?.source ?? "原帖未说明"}；时间未说明`}`);
      if (d.action === "withdraw") lines.push("此前宣布的奖励活动已撤回。");
      continue;
    }
    const window = d.e?.estimate ?? d.e?.schedule;
    if ((d.action === "announce" || d.action === "amend") && window) lines.push(`**预计生效**：${window.label}${d.e?.estimate ? `（${SITE.name} 推算）` : ""}`);
    if (d.action === "confirm" && d.e?.confirmedAt) lines.push(`**确认时间**：北京时间 ${bjStamp(d.e.confirmedAt)}（确认帖时间，不是精确到账时间）`);
    if (d.action === "withdraw") lines.push(`此前宣布的这次安排已撤回，以 ${currentMonitor().product} 内显示为准。`);
  }
  const scoped = described.find((d) => d.e)?.e;
  if (scoped) lines.push(`**适用范围**：${scoped.presentation?.audienceZh ?? scoped.presentation?.scopeLabel ?? "未说明"}${scoped.presentation?.productsZh ? ` · ${scoped.presentation.productsZh}` : ""}`);
  const outage = snapshot.outage && described.some((d) => d.eventId === snapshot.outage!.resetEventId) ? snapshot.outage : null;
  if (outage?.publishedAt) lines.push(`**起因**：${bjStamp(outage.publishedAt)} 官方确认 ${currentMonitor().product} 故障${outage.recoveredAt ? `，${bjStamp(outage.recoveredAt).slice(6)} 恢复` : ""}`);
  const words = post.text;
  // A short reply needs the question it answers.
  const parent = post.originalText.length <= 120 ? post.context.find((c) => (c.text ?? c.originalText).replace(/[^\p{L}\p{N}]/gu, "").length >= 8) : undefined;
  const title = headline(primary.action, primary.type, primary.e?.presentation?.status, post.author);
  const tone = primary.action === "confirm" ? "turquoise" : primary.action === "withdraw" ? "grey" : "orange";
  return {
    header: { title: { tag: "plain_text", content: title }, template: tone },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      parent ? { tag: "div", text: { tag: "lark_md", content: `${parent.relation === "quote" ? "引用" : "回复"} @${parent.author}：${(parent.text ?? parent.originalText).slice(0, 160)}` } } : null,
      words ? { tag: "div", text: { tag: "lark_md", content: `@${post.author}：\n> ${words.replace(/\n/g, "\n> ")}` } } : null,
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "查看原帖" }, url: post.url, type: "default" },
          { tag: "button", text: { tag: "plain_text", content: currentMonitor().title ? `打开${currentMonitor().title}` : "打开重置监控" }, url: monitorPageUrl(), type: "primary" },
        ],
      },
    ].filter(Boolean),
  };
}

/** Process all pending posts in publication order. Failed recognition aborts the round. */
export async function processPending(limit = Infinity, roundId: string = randomUUID(), resume = false): Promise<{ processed: number; failed: number }> {
  if (!config.modelCallsEnabled) return { processed: 0, failed: 0 };
  const posts = await sql<{ id: string; author: string; text: string; published_at: Date; raw: { contextPending?: boolean; context?: Array<ContextInput & { url: string }> } | null }[]>`
    SELECT id, author, text, published_at, raw FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts WHERE processed_at IS NULL AND lower(author) = ANY(${authorHandles()}::text[])
    ORDER BY published_at, id ${Number.isFinite(limit) ? sql`LIMIT ${limit}` : sql``}`;
  let processed = 0;
  for (const p of posts) {
    shutdownSignal.signal.throwIfAborted();
    if (p.raw?.contextPending) break;
    const [current] = await sql`SELECT 1 FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts WHERE id = ${p.id} AND processed_at IS NULL`;
    if (!current) continue; // manual review may have completed it while earlier posts were processed
    if (sourceContentIssue(p.text)) {
      await markIncompleteSource(p.id);
      processed++;
      continue;
    }
    try {
      const rec = await recognizePost({ id: p.id, author: p.author, text: p.text, publishedAt: p.published_at.toISOString(), context: p.raw?.context ?? [], openEvents: await openEvents(p.published_at, p.raw?.context ?? []), roundId, resume });
      await applyRecognition(p.id, rec);
    } catch (error) { await recordPostFailure(p.id, "recognition", error); throw error; }
    await sql`UPDATE monitor_posts SET raw = raw - 'collectionFailure' WHERE monitor_id = ${monitorId()} AND (id = ${p.id} AND raw ? 'collectionFailure') `;
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
    SELECT p.id AS post_id, p.author, p.url, p.published_at, p.recognition->'notify' AS notify,
      coalesce(p.translation, p.text) AS text, p.text AS "originalText", p.context
    FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS p
    WHERE p.processed_at IS NOT NULL AND lower(p.author) = ANY(${authorHandles()}::text[]) AND p.published_at > ${new Date(Date.now() - PUSH_MAX_AGE_MS)}
      AND jsonb_array_length(coalesce(p.recognition->'notify', '[]'::jsonb)) > 0
    ORDER BY p.published_at, p.id`;
  if (!posts.length) return 0;
  let snapshot: Awaited<ReturnType<typeof resetsSnapshot>> | null = null;
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
            SELECT 1 FROM deliveries d LEFT JOIN (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS original ON original.id = split_part(d.dedupe_key, ':', 2)
            WHERE d.subject_kind = ${currentMonitor().names.deliveryKind} AND d.target_key = ${target.key}
              AND d.status IN ('sent', 'unknown', 'sending') AND d.dedupe_key NOT LIKE ${`${currentMonitor().names.deliveryPrefix}:${p.post_id}:%`}
              AND (d.subject_id = ${n.eventId} OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(coalesce(original.recognition->'notify', '[]'::jsonb)) entry
                WHERE entry->>'eventId' = ${n.eventId} AND entry->>'action' IN ('announce', 'confirm')
              )) LIMIT 1`;
          if (!told) continue;
        }
        entries.push(n);
      }
      if (!entries.length) continue;
      const dedupeKey = `${currentMonitor().names.deliveryPrefix}:${p.post_id}:${entries[0]!.eventId}:${entries[0]!.action}`;
      const [delivered] = await sql`SELECT 1 FROM deliveries WHERE target_key = ${target.key} AND dedupe_key = ${dedupeKey}`;
      if (delivered) continue;
      snapshot ??= await resetsSnapshot();
      const gone = entries.filter((e) => e.action === "withdraw").map((e) => e.eventId);
      const withdrawn = new Map(gone.length ? (await sql<{ id: string; type: string }[]>`SELECT id, type FROM (SELECT * FROM monitor_events WHERE monitor_id = ${monitorId()}) AS monitor_events WHERE id IN ${sql(gone)}`).map((r) => [r.id, r]) : []);
      const card = resetPostCard(p, entries, snapshot, withdrawn);
      if (!card) continue;
      const results = await deliverContent({ subjectKind: currentMonitor().names.deliveryKind, subjectId: entries[0]!.eventId, dedupeKey, contentAt: p.published_at, card, targetKey: target.key });
      pushed += results.filter((r) => r.status === "sent").length;
    }
  }
  return pushed;
}

/** One scheduled run owns the checkpoint; a concurrent trigger skips instead of queuing. */
export async function monitorTick(opts: { lookbackHours?: number; initialRange?: { since: string; until: string }; collectOnly?: boolean } = {}) {
  if (opts.collectOnly && !opts.initialRange) throw new Error("collectOnly requires a finite initialization range");
  const connection = await sql.reserve();
  try {
    const [lock] = await connection<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${currentMonitor().names.tick})) AS acquired`;
    if (!lock?.acquired) return { skipped: true, reason: "busy" };
    try { return await tick(opts); }
    finally { await connection`SELECT pg_advisory_unlock(hashtext(${currentMonitor().names.tick}))`; }
  } finally { connection.release(); }
}
async function tick(opts: { lookbackHours?: number; initialRange?: { since: string; until: string }; collectOnly?: boolean }) {
  const started = new Date(); const roundId = randomUUID();
  await cleanupMonitorCollectionState();
  await touchWatermarks({ lastAttemptAt: started.toISOString() });
  const collected = await collectPosts({ ...opts, startedAt: started, roundId });
  const screened = await screenPendingPosts();
  if (opts.collectOnly) return { ...collected, screened, collectOnly: true, verifiedAt: null };
  const progress = opts.initialRange ? await getState<{ processingWindow: string }>(initialCollectionKey()) : null;
  const processingWindow = progress?.processingWindow ?? roundId;
  const context = await collectPendingContext(Infinity, processingWindow, !!opts.initialRange);
  const result = await processPending(Infinity, processingWindow, !!opts.initialRange);
  const [pending] = await sql<{ n: number }[]>`SELECT count(*) FILTER (WHERE processed_at IS NULL)::int AS n FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts WHERE lower(author) = ANY(${authorHandles()}::text[])`;
  const complete = process.env.COLLECT_ENABLED === "true" && config.modelCallsEnabled && !pending?.n;
  if (!complete) throw new Error(`Monitor round incomplete: ${pending?.n ?? 0} posts pending; collection and model calls must be enabled`);
  // Business review does not mean the transport or recognition failed.
  if (opts.lookbackHours === undefined) {
    const through = opts.initialRange ? new Date(Math.floor(Date.parse(opts.initialRange.until) / 1000) * 1000).toISOString() : started.toISOString();
    await sql.begin(async tx => {
      await setState(cursorKey(), { checkpointVersion: 2, scannedThrough: through }, tx);
      await touchWatermarks({ lastVerifiedAt: started.toISOString() }, tx);
      if (opts.initialRange) await tx`DELETE FROM monitor_state WHERE monitor_id = ${monitorId()} AND key = ${initialCollectionKey()}`;
    });
  }
  const pushed = await flushResetPushes();
  return { ...collected, ...result, ...(screened ? { screened } : {}), context, pushed, pending: 0, verifiedAt: opts.lookbackHours === undefined ? bjIso(started) : null };
}
