import { randomUUID } from "node:crypto";
import { sql, type Db } from "@aihot/backend/db";
import { shutdownSignal } from "@aihot/backend/lib/shutdown";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { monitor, monitorId, isAuthor, purpose } from "./context.ts";
import { collectorName, cursorKey, watermarksKey } from "../config.ts";
import { searchTweets, lookupTweets, tweetText, type Tweet } from "./providers/collectors.ts";
import { storeCollectedPost, loadActionInput } from "./action-store.ts";
import { authorCollectionSince, prepareCollectionCoverage } from "./collection-coverage.ts";
import { collectionQuery, embeddedQuote, replyTarget } from "./post-policy.ts";
import { buildThreadGroups } from "./thread-groups.ts";

interface Cursor { checkpointVersion: 2; scannedThrough?: string }
export interface CollectionResult {
  stored: number; pages: number; returned: number; embedded: number; contextFetched: number; contextOnly: number; issues: number; contextLimitReached: boolean;
  paidPages: number; reusedPages: number; windowPages: number; collectionComplete: boolean; pageLimitReached: boolean;
}
interface AuthorProgress {
  handle: string; lower: number; query: string; cursor: string | null; visited: string[]; complete: boolean;
}
interface CollectionProgress { startedAt: string; authors: AuthorProgress[]; pages: number }
export const collectionProgressKey = (roundId: string) => `collection:progress:${collectorName()}:${roundId}`;
const keyForMissing = (id: string) => `context:missing:${collectorName()}:${id}`;
// A malformed ancestry chain must not consume the provider budget without a finite bound.
const MAX_CONTEXT_LOOKUPS = 64;
const authorKey = (value: string) => value.replace(/^@/, "").toLowerCase();

async function state<T>(key: string): Promise<T | null> {
  const [row] = await sql<{value:T}[]>`SELECT value FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${key}`;
  return row?.value ?? null;
}
async function markMissing(db: Db, id: string, receiptId: number) {
  await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${keyForMissing(id)},${db.json({ reason: "not_returned", receiptId })})
    ON CONFLICT(monitor_id,key) DO NOTHING`;
}
function validatePost(post: Tweet) {
  if (!/^\d+$/.test(post.id_str) || !/^[A-Za-z0-9_]{1,15}$/.test(post.user?.screen_name ?? "") || !Number.isFinite(Date.parse(post.tweet_created_at)))
    throw new Error("Collector returned a post with invalid identity or publication time");
}

/** Parse and persist all returned candidates before following ancestry or invoking any model. */
export async function collectPosts(opts: { startedAt?: Date; roundId?: string; resume?: boolean } = {}): Promise<CollectionResult> {
  const result: CollectionResult = { stored: 0, pages: 0, returned: 0, embedded: 0, contextFetched: 0, contextOnly: 0, issues: 0, contextLimitReached: false,
    paidPages: 0, reusedPages: 0, windowPages: 0, collectionComplete: false, pageLimitReached: false };
  if (process.env.COLLECT_ENABLED !== "true") return result;
  const started = opts.startedAt ?? new Date(), cursor = await state<Cursor>(cursorKey());
  if (cursor && (cursor.checkpointVersion !== 2 || !cursor.scannedThrough)) throw new Error("Monitor success checkpoint is incomplete");
  let since = cursor?.scannedThrough ? Date.parse(cursor.scannedThrough) : started.getTime();
  if (!Number.isFinite(since) || since > started.getTime()) throw new Error("Monitor success checkpoint must be a valid past time");
  const coverage = await prepareCollectionCoverage(started.toISOString(), new Date(since).toISOString());
  if (!cursor && coverage.scopeEffectiveAt) since = Date.parse(coverage.scopeEffectiveAt);
  if (since > started.getTime()) throw new Error("Monitor collection starting point must be a valid past time");
  const lowerByAuthor = new Map(monitor().authors.map(author => [authorKey(author.handle), authorCollectionSince(coverage, author.handle, since)]));
  const roundId = opts.roundId ?? randomUUID();
  const maxPagesPerRun = monitor().collection.maxPagesPerRun;
  const progressKey = collectionProgressKey(roundId);
  let progress = await state<CollectionProgress>(progressKey);
  const plannedAuthors = monitor().authors.map(author => {
    const lower = lowerByAuthor.get(authorKey(author.handle))!;
    return { handle: author.handle, lower, query: collectionQuery(author.handle, lower, started.getTime(), monitor().collection) };
  });
  if (progress && (progress.startedAt !== started.toISOString() || progress.authors.length !== plannedAuthors.length
    || progress.authors.some((author, index) => author.handle !== plannedAuthors[index].handle || author.lower !== plannedAuthors[index].lower || author.query !== plannedAuthors[index].query))) {
    throw new Error("Collection window configuration changed; review its saved progress before continuing");
  }
  if (!progress) {
    progress = { startedAt: started.toISOString(), pages: 0, authors: plannedAuthors.map(author => ({ ...author, cursor: null, visited: [], complete: author.lower >= started.getTime() })) };
    await saveProgress();
  }
  result.windowPages = progress.pages;
  const seen = new Map<string, Tweet>(), ingested = new Set<string>(), touched = new Set<string>();
  const before = await loadActionInput();
  const old = new Map(before.posts.map(post => [post.id, post]));
  function business(post: Tweet) {
    const lower = lowerByAuthor.get(authorKey(post.user.screen_name)), at = Date.parse(post.tweet_created_at);
    return lower !== undefined && at >= lower && at <= started.getTime();
  }
  async function save(post: Tweet, receiptId: number | null, embedded = false) {
    validatePost(post);
    const previous = seen.get(post.id_str);
    if (previous && (authorKey(previous.user.screen_name) !== authorKey(post.user.screen_name)
      || Date.parse(previous.tweet_created_at) !== Date.parse(post.tweet_created_at)
      || tweetText(previous).trim() && tweetText(post).trim() && tweetText(previous) !== tweetText(post)))
      throw new Error(`Collector returned conflicting versions of post ${post.id_str}`);
    seen.set(post.id_str, post);
    touched.add(post.id_str);
    const contextOnly = !business(post);
    const inserted = await storeCollectedPost({ id: post.id_str, author: post.user.screen_name,
      publishedAt: new Date(post.tweet_created_at).toISOString(), url: `https://x.com/${post.user.screen_name}/status/${post.id_str}`,
      text: tweetText(post), quotedPost: embeddedQuote(post)[0] ?? null, replyTo: replyTarget(post), receiptId, contextOnly });
    if (!ingested.has(post.id_str)) {
      if (inserted && !contextOnly && (!old.has(post.id_str) || old.get(post.id_str)?.context_only)) result.stored++;
      if (inserted && contextOnly && !old.has(post.id_str)) result.contextOnly++;
      if (embedded && inserted && !contextOnly && !old.has(post.id_str)) result.embedded++;
      ingested.add(post.id_str);
    }
    if (post.quoted_status && post.quoted_status.id_str !== post.id_str) {
      if (!seen.has(post.quoted_status.id_str)) await save(post.quoted_status, receiptId, true);
    }
  }
  for (const author of progress.authors) {
    while (!author.complete) {
      shutdownSignal.signal.throwIfAborted();
      if (maxPagesPerRun !== undefined && result.paidPages >= maxPagesPerRun) {
        result.pageLimitReached = true;
        return result;
      }
      const response = await searchTweets(author.query, { purpose: purpose("scan"), subject: `x:${author.handle.toLowerCase()}`, window: roundId, cursor: author.cursor, resume: opts.resume });
      result.pages++; result.returned += response.tweets.length;
      if (response.reused) result.reusedPages++;
      else result.paidPages++;
      for (const post of response.tweets) {
        validatePost(post);
        if (authorKey(post.user.screen_name) !== authorKey(author.handle)
          || Date.parse(post.tweet_created_at) < author.lower || Date.parse(post.tweet_created_at) > started.getTime())
          throw new Error(`Collector returned post ${post.id_str} outside the requested author or window`);
        await save(post, response.receiptId);
      }
      if (response.nextCursor && author.visited.includes(response.nextCursor)) throw new Error("Collection returned a repeated page cursor; coverage remains incomplete");
      author.cursor = response.nextCursor;
      author.complete = !response.nextCursor;
      if (response.nextCursor) author.visited.push(response.nextCursor);
      progress.pages++;
      await sql.begin(async tx => { await completeReceipt(tx, response.receiptId); await saveProgress(tx); });
      result.windowPages = progress.pages;
    }
  }
  result.collectionComplete = true;
  await fillContext();
  const final = await loadActionInput();
  result.issues = buildThreadGroups(final.posts, monitor().authors.map(author => author.handle)).reduce((count, group) => count + group.issues.length, 0);
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${watermarksKey()},${sql.json({lastCollectedAt:started.toISOString()})})
    ON CONFLICT(monitor_id,key) DO UPDATE SET value=monitor_state.value || EXCLUDED.value,updated_at=now()`;
  return result;

  async function saveProgress(db: Db = sql) {
    await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${progressKey},${db.json(progress as never)})
      ON CONFLICT(monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
  }

  async function fillContext() {
    const input = await loadActionInput(), saved = new Map(input.posts.map(post => [post.id, post]));
    const pending = [...new Set([...touched, ...input.posts.filter(post => !post.context_only && post.processing_status === "pending" && isAuthor(post.author)).map(post => post.id)])];
    const visited = new Set<string>();
    let requested = 0;
    for (let index = 0; index < pending.length; index++) {
      shutdownSignal.signal.throwIfAborted();
      const id = pending[index];
      if (visited.has(id)) continue;
      visited.add(id);
      const child = saved.get(id);
      if (!child || !isAuthor(child.author)) continue;
      if (child.quoted_post && !saved.has(child.quoted_post.id) && child.quoted_post.text.trim() && child.quoted_post.publishedAt) {
        const quote = child.quoted_post;
        await save({id_str:quote.id,user:{screen_name:quote.author,name:quote.author},tweet_created_at:quote.publishedAt!,full_text:quote.text,
          ...(quote.replyTo ? {is_reply:true,in_reply_to_status_id_str:quote.replyTo.postId,in_reply_to_screen_name:quote.replyTo.author} : {})}, child.source_receipt_id, true);
        const refreshed = await loadActionInput();
        for (const post of refreshed.posts) saved.set(post.id,post);
      }
      const ids = [...new Set([child.reply_to?.postId, child.quoted_post?.id].filter((value): value is string => !!value))];
      for (const ancestorId of ids) {
        const known = saved.get(ancestorId);
        if (known?.text?.trim()) { pending.push(ancestorId); continue; }
        if (await state(keyForMissing(ancestorId))) continue;
        if (requested >= MAX_CONTEXT_LOOKUPS) { result.contextLimitReached = true; continue; }
        requested++;
        const lookup = await lookupTweets([ancestorId], {purpose:purpose("context"),subject:`x:${ancestorId}`});
        result.contextFetched += lookup.tweets.length;
        for (const post of lookup.tweets) await save(post, lookup.receiptById[post.id_str]);
        await sql.begin(async tx => {
          for (const missing of lookup.missingIds) await markMissing(tx,missing,lookup.receiptById[missing]);
          for (const receiptId of lookup.receiptIds) await completeReceipt(tx,receiptId);
        });
        const refreshed = await loadActionInput();
        for (const post of refreshed.posts) saved.set(post.id,post);
        if (saved.has(ancestorId)) pending.push(ancestorId);
      }
    }
  }
}
