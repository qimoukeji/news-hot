import { sql, type Db } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { monitor, monitorId } from "./context.ts";
import { normalizeTweet } from "./providers/twitterapi.ts";
import { tweetText, type Tweet } from "./providers/collectors.ts";
import { embeddedQuote, replyTarget } from "./post-policy.ts";
import { storeCollectedPost, lockActionRecords } from "./action-store.ts";
import { verifyActionBackup } from "./backup.ts";
import type { ActionRow, EventRow, SourcePostRow } from "../actions.ts";

export interface ThreadRepairOptions { receiptIds: number[]; targetPostIds: string[] }
interface Receipt { id: number; service: string; purpose: string; status: string; response: { tweets?: unknown[] } | null }
export interface ThreadRepairSnapshot {
  monitorId: string;
  authors: string[];
  receipts: Receipt[];
  posts: SourcePostRow[];
  events: EventRow[];
  actions: ActionRow[];
}
interface RestoredPost { post: Tweet; receiptId: number; contextOnly: boolean }
const same = (a: string, b: string) => a.replace(/^@/, "").toLowerCase() === b.replace(/^@/, "").toLowerCase();
const ids = (values: string[]) => [...new Set(values)].sort();
function validateOptions(options: ThreadRepairOptions) {
  if (!options.receiptIds.length || options.receiptIds.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(options.receiptIds).size !== options.receiptIds.length) throw new Error("Select distinct positive receipt IDs");
  if (!options.targetPostIds.length || options.targetPostIds.some(id => !/^\d+$/.test(id))
    || new Set(options.targetPostIds).size !== options.targetPostIds.length) throw new Error("Select distinct numerical target post IDs");
}

/** Plans only explicitly selected targets and their existing reply/quote ancestors, never an account history. */
export function threadRepairPlan(snapshot: ThreadRepairSnapshot, options: ThreadRepairOptions) {
  validateOptions(options);
  const ambiguities: string[] = [], decoded = new Map<string, { post: Tweet; receiptId: number }>();
  const expectedPurpose = snapshot.monitorId === "codex" ? "monitor.scan" : `reset_monitor.${snapshot.monitorId}.scan`;
  for (const id of options.receiptIds) if (!snapshot.receipts.some(receipt => receipt.id === id)) ambiguities.push(`Receipt ${id} was not found`);
  function visit(post: Tweet, receiptId: number, seen: Set<string>) {
    if (seen.has(post.id_str)) { ambiguities.push(`Cyclic embedded post ${post.id_str}`); return; }
    if (!/^\d+$/.test(post.id_str) || !post.user?.screen_name || !Number.isFinite(Date.parse(post.tweet_created_at))) {
      ambiguities.push(`Receipt ${receiptId} has incomplete post identity`); return;
    }
    const previous = decoded.get(post.id_str);
    if (previous && (previous.post.user.screen_name.toLowerCase() !== post.user.screen_name.toLowerCase()
      || Date.parse(previous.post.tweet_created_at) !== Date.parse(post.tweet_created_at)
      || tweetText(previous.post) !== tweetText(post)
      || replyTarget(previous.post)?.postId && replyTarget(post)?.postId && replyTarget(previous.post)!.postId !== replyTarget(post)!.postId
      || previous.post.quoted_status?.id_str && post.quoted_status?.id_str && previous.post.quoted_status.id_str !== post.quoted_status.id_str)) ambiguities.push(`Conflicting receipt post ${post.id_str}`);
    if (!previous) decoded.set(post.id_str, { post, receiptId });
    if (post.quoted_status) visit(post.quoted_status, receiptId, new Set([...seen, post.id_str]));
  }
  for (const receipt of snapshot.receipts) {
    if (!options.receiptIds.includes(receipt.id)) continue;
    if (receipt.purpose !== expectedPurpose || !["received", "completed"].includes(receipt.status)
      || !["twitterapi_io", "socialdata"].includes(receipt.service)) {
      ambiguities.push(`Receipt ${receipt.id} is not an accepted collection response for ${snapshot.monitorId}`); continue;
    }
    for (const raw of receipt.response?.tweets ?? []) {
      try { visit(receipt.service === "twitterapi_io" ? normalizeTweet(raw) : raw as Tweet, receipt.id, new Set()); }
      catch { ambiguities.push(`Receipt ${receipt.id} contains an invalid source object`); }
    }
  }
  const saved = new Map(snapshot.posts.map(post => [post.id, post]));
  const selected = new Set(options.targetPostIds), related = new Set<string>(), pending = [...selected];
  const restored: RestoredPost[] = [], requeue: string[] = [], preserved: string[] = [];
  while (pending.length) {
    const id = pending.shift()!;
    if (related.has(id)) continue;
    related.add(id);
    const existing = saved.get(id), source = decoded.get(id);
    const author = existing?.author ?? source?.post.user.screen_name;
    if (selected.has(id) && author && !snapshot.authors.some(handle => same(handle, author))) {
      ambiguities.push(`Target ${id} is not authored by a configured monitor account`); continue;
    }
    if (!existing && !source) { ambiguities.push(`Source ${id} is absent from saved posts and selected receipts`); continue; }
    if (existing && source && (!same(existing.author, source.post.user.screen_name)
      || new Date(existing.published_at).getTime() !== Date.parse(source.post.tweet_created_at)
      || existing.text?.trim() && existing.text !== tweetText(source.post)
      || existing.reply_to?.postId && replyTarget(source.post)?.postId && existing.reply_to.postId !== replyTarget(source.post)?.postId)) {
      ambiguities.push(`Saved post ${id} conflicts with receipt evidence`); continue;
    }
    if (!existing && source) restored.push({ ...source, contextOnly: !selected.has(id) });
    else if (existing && selected.has(id)) {
      if (existing.context_only) ambiguities.push(`Target ${id} is context-only; promote it through normal collection before repair`);
      if (existing.processing_status === "needs_attention") requeue.push(id);
      else if (existing.processing_status === "pending" || existing.processing_status === "processed") preserved.push(id);
      else ambiguities.push(`Target ${id} has unsupported repair status ${existing.processing_status}`);
    }
    const parent = source ? replyTarget(source.post)?.postId : existing?.reply_to?.postId;
    const quote = source?.post.quoted_status?.id_str ?? existing?.quoted_post?.id;
    if (parent) pending.push(parent);
    // A quote is useful existing context. Do not require a complete unrelated quote's ancestors.
    if (quote && !selected.has(quote) && (saved.has(quote) || decoded.has(quote))) {
      related.add(quote);
      if (!saved.has(quote) && decoded.has(quote)) restored.push({ ...decoded.get(quote)!, contextOnly: !selected.has(quote) });
    }
    // Selected quoted targets still need traversal of their own reply relation.
    if (quote && selected.has(quote) && !related.has(quote)) pending.push(quote);
  }
  const parents = (id: string) => {
    const row = saved.get(id), source = decoded.get(id)?.post;
    return [source ? replyTarget(source)?.postId : row?.reply_to?.postId,
      source?.quoted_status?.id_str ?? row?.quoted_post?.id].filter((value): value is string => !!value && related.has(value));
  };
  const visiting = new Set<string>(), visited = new Set<string>();
  function checkRelations(id: string) {
    if (visiting.has(id)) { ambiguities.push(`Cyclic reply/quote relation at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    const date = (key: string) => saved.has(key) ? new Date(saved.get(key)!.published_at).getTime() : Date.parse(decoded.get(key)!.post.tweet_created_at);
    for (const parent of parents(id)) {
      if (!saved.has(parent) && !decoded.has(parent)) continue;
      if (date(parent) > date(id)) ambiguities.push(`Parent ${parent} is newer than child ${id}`);
      checkRelations(parent);
    }
    visiting.delete(id); visited.add(id);
  }
  for (const id of related) if (saved.has(id) || decoded.has(id)) checkRelations(id);
  const relevantActions = snapshot.actions.filter(action => action.sources.some(source => related.has(source.postId)));
  const relevantEvents = snapshot.events.filter(event => relevantActions.some(action => action.event_id === event.id));
  const relevantPosts = snapshot.posts.filter(post => related.has(post.id));
  const uniqueRestored = [...new Map(restored.map(row => [row.post.id_str, row])).values()];
  const fingerprint = sha256(stableJson({ monitorId: snapshot.monitorId, authors: snapshot.authors, options,
    receipts: snapshot.receipts.filter(receipt => options.receiptIds.includes(receipt.id)), posts: relevantPosts,
    events: relevantEvents, actions: relevantActions }));
  return { fingerprint, ambiguities: [...new Set(ambiguities)], monitorId: snapshot.monitorId,
    receiptIds: [...options.receiptIds].sort((a, b) => a - b), targetPostIds: ids(options.targetPostIds),
    relatedPostIds: ids([...related]), eventIds: relevantEvents.map(event => event.id).sort(),
    actionIds: relevantActions.map(action => action.id).sort(),
    changes: { insert: uniqueRestored.map(row => ({ postId: row.post.id_str, author: row.post.user.screen_name,
      sourceReceiptId: row.receiptId, contextOnly: row.contextOnly, replyTo: replyTarget(row.post),
      quoteId: row.post.quoted_status?.id_str ?? null })), requeue: ids(requeue), preserved: ids(preserved) },
    restored: uniqueRestored,
  };
}

export async function threadRepairSnapshot(options: ThreadRepairOptions, db: Db = sql): Promise<ThreadRepairSnapshot> {
  validateOptions(options);
  return { monitorId: monitorId(), authors: monitor().authors.map(author => author.handle),
    receipts: await db<Receipt[]>`SELECT id,service,purpose,status,response FROM receipts WHERE id=ANY(${options.receiptIds}::bigint[]) ORDER BY id`,
    posts: await db<SourcePostRow[]>`SELECT * FROM monitor_source_posts WHERE monitor_id=${monitorId()} ORDER BY id`,
    events: await db<EventRow[]>`SELECT * FROM monitor_event_records WHERE monitor_id=${monitorId()} ORDER BY id`,
    actions: await db<ActionRow[]>`SELECT * FROM monitor_event_actions WHERE monitor_id=${monitorId()} ORDER BY id` };
}
export async function previewThreadRepair(options: ThreadRepairOptions, db: Db = sql) {
  const { restored: _private, ...preview } = threadRepairPlan(await threadRepairSnapshot(options, db), options);
  return preview;
}

/** No paid calls and no success-cutoff writes. Application needs a reviewed fingerprint and complete backup. */
export async function applyThreadRepair(options: ThreadRepairOptions, fingerprint: string, backupPath: string) {
  await verifyActionBackup(backupPath);
  return sql.begin("read write", async tx => {
    await tx`SET LOCAL lock_timeout='5s'`;
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext(${monitor().names.tick})) AS acquired`;
    if (!lock?.acquired) throw new Error("Stop the monitor worker before applying a thread repair");
    const initial = threadRepairPlan(await threadRepairSnapshot(options, tx), options);
    await lockActionRecords(tx, initial.eventIds, initial.actionIds, initial.relatedPostIds);
    const plan = threadRepairPlan(await threadRepairSnapshot(options, tx), options);
    if (plan.fingerprint !== fingerprint) throw new Error("Thread repair evidence changed; review a fresh preview");
    if (plan.ambiguities.length) throw new Error("Resolve every thread repair ambiguity before applying");
    for (const { post, receiptId, contextOnly } of plan.restored) await storeCollectedPost({ id: post.id_str,
      author: post.user.screen_name, publishedAt: post.tweet_created_at,
      url: `https://x.com/${post.user.screen_name}/status/${post.id_str}`, text: tweetText(post),
      quotedPost: embeddedQuote(post)[0] ?? null, replyTo: replyTarget(post), receiptId, contextOnly }, tx);
    for (const id of plan.changes.requeue) await tx`UPDATE monitor_source_posts SET processing_status='pending',review_reason=NULL,updated_at=clock_timestamp()
      WHERE monitor_id=${monitorId()} AND id=${id} AND processing_status='needs_attention'`;
    for (const id of plan.targetPostIds.filter(id => !plan.changes.preserved.includes(id))) await tx`INSERT INTO monitor_state(monitor_id,key,value)
      VALUES(${monitorId()},${`recognition:historical:${id}`},'{"suppressNotifications":true}'::jsonb)
      ON CONFLICT(monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
    await audit("operator", "reset_monitor.thread.repair", `${monitorId()}:posts`, "Restore explicit reply/quote evidence from existing paid collection receipts",
      { fingerprint }, { targetPostIds: plan.targetPostIds, receiptIds: plan.receiptIds, changes: plan.changes, backupVerified: true }, { db: tx });
    const { restored: _private, ...result } = plan;
    return { ...result, applied: true, paidCalls: 0, checkpointChanged: false };
  });
}
