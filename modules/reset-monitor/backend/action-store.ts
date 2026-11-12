import { randomUUID } from "node:crypto";
import { sql, type Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { Conflict } from "@aihot/backend/audit";
import { monitorId, monitor } from "./context.ts";
import { captureReviewNotification, cancelReviewNotification } from "./review-notifications.ts";
import {
  actionDraftSchema,
  replyToSchema,
  withoutPostOriginal,
  type ActionInput,
  type ActionDraft,
  type EditorialText,
  type SourcePostRow,
  type EventRow,
  type ActionRow,
  type EditorialScope,
  currentUnsourcedConfirmation,
  inferencesAfterAnnouncement,
  sourcedConfirmationTime,
} from "../actions.ts";
import { normalizePublicTime, sourceUrlSchema } from "../public-v2.ts";
import { enqueuePublicV2 } from "./public-v2-work.ts";
export type {
  ActionInput,
  ActionDraft,
  SourcePostRow,
  EventRow,
  ActionRow,
} from "../actions.ts";
export const rowVersion = (row: unknown) => sha256(stableJson(row));
const standaloneFollowupPrefix = "recognition:standalone-followup:";
const invalidatedInferencePrefix = "confirmation:invalidated:";
const manualConfirmationPrefix = "confirmation:manual:";
export async function loadManualConfirmationIds(db: Db, id = monitorId()) {
  const rows = await db<{ key: string }[]>`SELECT key FROM monitor_state WHERE monitor_id=${id} AND starts_with(key,${manualConfirmationPrefix})`;
  return new Set(rows.map(row => row.key.slice(manualConfirmationPrefix.length)));
}
export async function saveManualConfirmations(db: Db, ids: string[]) {
  for (const id of ids) await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${manualConfirmationPrefix + id},'true'::jsonb) ON CONFLICT(monitor_id,key) DO NOTHING`;
  if (ids.length) await db`UPDATE monitor_event_actions SET updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=ANY(${ids}::text[])`;
}
export async function removeManualConfirmations(db: Db, ids: string[]) {
  if (ids.length) await db`DELETE FROM monitor_state WHERE monitor_id=${monitorId()} AND key=ANY(${ids.map(id => manualConfirmationPrefix + id)}::text[])`;
}
export async function loadInvalidatedInferenceIds(db: Db, id = monitorId()) {
  const rows = await db<{ key: string }[]>`SELECT key FROM monitor_state WHERE monitor_id=${id} AND starts_with(key,${invalidatedInferencePrefix})`;
  return new Set(rows.map(row => row.key.slice(invalidatedInferencePrefix.length)));
}
export async function invalidateInferences(db: Db, ids: Iterable<string>) {
  for (const id of ids) await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${invalidatedInferencePrefix + id},'true'::jsonb) ON CONFLICT(monitor_id,key) DO NOTHING`;
}
export async function removeInvalidatedInferences(db: Db, ids: string[]) {
  if (ids.length) await db`DELETE FROM monitor_state WHERE monitor_id=${monitorId()} AND key=ANY(${ids.map(id => invalidatedInferencePrefix + id)}::text[])`;
}
export async function saveStandaloneFollowups(db: Db, ids: Iterable<string>) {
  for (const id of ids) await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${standaloneFollowupPrefix + id},'true'::jsonb) ON CONFLICT(monitor_id,key) DO NOTHING`;
}
export async function removeStandaloneFollowups(db: Db, ids: string[]) {
  if (ids.length) await db`DELETE FROM monitor_state WHERE monitor_id=${monitorId()} AND key=ANY(${ids.map(id => standaloneFollowupPrefix + id)}::text[])`;
}
const invalid = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });

export async function loadActionInput(db: Db = sql): Promise<ActionInput> {
  const events = await db<
    EventRow[]
  >`SELECT id,type,title,summary,scope,withdrawn,created_at,updated_at FROM monitor_event_records WHERE monitor_id=${monitorId()} ORDER BY id`;
  const posts = await db<
    SourcePostRow[]
  >`SELECT id,author,published_at,url,text,quoted_post,reply_to,context_only,filtered_out,title,summary,source_receipt_id,model_receipt_id,processing_status,review_reason,created_at,updated_at FROM monitor_source_posts WHERE monitor_id=${monitorId()} ORDER BY id`;
  const actions = await db<
    ActionRow[]
  >`SELECT id,event_id,sequence,action,invalidates_event,title,summary,time,sources,created_at,updated_at FROM monitor_event_actions WHERE monitor_id=${monitorId()} ORDER BY id`;
  const states = await db<{ key: string; value: NonNullable<ActionInput["editorials"]>[string] }[]>`SELECT key,value FROM monitor_state WHERE monitor_id=${monitorId()} AND key LIKE 'public_v2:overview:%'`;
  const standalone = await db<{ key: string }[]>`SELECT key FROM monitor_state WHERE monitor_id=${monitorId()} AND starts_with(key,${standaloneFollowupPrefix})`;
  return { events, posts, actions, editorials: Object.fromEntries(states.map(row => [row.key.slice("public_v2:overview:".length), row.value])),
    standaloneFollowupIds: new Set(standalone.map(row => row.key.slice(standaloneFollowupPrefix.length))),
    invalidatedInferenceIds: await loadInvalidatedInferenceIds(db), manualConfirmationIds: await loadManualConfirmationIds(db) };
}

export async function storeCollectedPost(
  post: {
    id: string;
    author: string;
    publishedAt: string | Date;
    url: string;
    receiptId: number | null;
    text?: string | null;
    quotedPost?: SourcePostRow["quoted_post"];
    replyTo?: SourcePostRow["reply_to"];
    contextOnly?: boolean;
  },
  db: Db = sql,
) {
  sourceUrlSchema.parse(post.url);
  const replyTo = post.replyTo == null ? null : replyToSchema.parse(post.replyTo);
  const existing = await sourcePost(post.id, db);
  if (existing && (existing.author.toLowerCase() !== post.author.toLowerCase()
    || new Date(existing.published_at).getTime() !== new Date(post.publishedAt).getTime()
    || existing.text?.trim() && post.text?.trim() && existing.text !== post.text
    || existing.reply_to?.postId && replyTo?.postId && existing.reply_to.postId !== replyTo.postId
    || existing.reply_to?.author && replyTo?.author && existing.reply_to.author.toLowerCase() !== replyTo.author.toLowerCase()
    || existing.quoted_post && post.quotedPost && (existing.quoted_post.author.toLowerCase() !== post.quotedPost.author.toLowerCase()
      || existing.quoted_post.publishedAt && post.quotedPost.publishedAt && Date.parse(existing.quoted_post.publishedAt) !== Date.parse(post.quotedPost.publishedAt)
      || existing.quoted_post.text?.trim() && post.quotedPost.text?.trim() && existing.quoted_post.text !== post.quotedPost.text
      || existing.quoted_post.replyTo?.postId && post.quotedPost.replyTo?.postId && existing.quoted_post.replyTo.postId !== post.quotedPost.replyTo.postId)
    || existing.quoted_post?.id && post.quotedPost?.id && existing.quoted_post.id !== post.quotedPost.id)) {
    throw new Conflict("Collected post conflicts with its saved source");
  }
  const mergedReply = existing?.reply_to && replyTo ? { postId: existing.reply_to.postId ?? replyTo.postId, author: existing.reply_to.author ?? replyTo.author } : replyTo;
  const quote = post.quotedPost && existing?.quoted_post ? { ...post.quotedPost, ...existing.quoted_post,
    text: existing.quoted_post.text?.trim() ? existing.quoted_post.text : post.quotedPost.text,
    publishedAt: existing.quoted_post.publishedAt ?? post.quotedPost.publishedAt,
    replyTo: existing.quoted_post.replyTo && post.quotedPost.replyTo ? { postId: existing.quoted_post.replyTo.postId ?? post.quotedPost.replyTo.postId, author: existing.quoted_post.replyTo.author ?? post.quotedPost.replyTo.author } : existing.quoted_post.replyTo ?? post.quotedPost.replyTo } : post.quotedPost;
  const rows = await db`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,quoted_post,reply_to,source_receipt_id,context_only)
    VALUES(${monitorId()},${post.id},${post.author},${post.publishedAt},${post.url},${post.text ?? null},${quote ? db.json(quote as never) : null},${mergedReply ? db.json(mergedReply) : null},${post.receiptId},${post.contextOnly ?? false})
    ON CONFLICT(monitor_id,id) DO UPDATE SET
      text=coalesce(nullif(monitor_source_posts.text,''),EXCLUDED.text),
      quoted_post=coalesce(EXCLUDED.quoted_post,monitor_source_posts.quoted_post),
      reply_to=coalesce(EXCLUDED.reply_to,monitor_source_posts.reply_to),
      source_receipt_id=coalesce(monitor_source_posts.source_receipt_id,EXCLUDED.source_receipt_id),
      context_only=monitor_source_posts.context_only AND EXCLUDED.context_only,
      processing_status=CASE WHEN monitor_source_posts.context_only AND NOT EXCLUDED.context_only THEN 'pending' ELSE monitor_source_posts.processing_status END,
      updated_at=clock_timestamp()
    WHERE monitor_source_posts.context_only AND NOT EXCLUDED.context_only
      OR (monitor_source_posts.text IS NULL OR monitor_source_posts.text='') AND EXCLUDED.text IS NOT NULL
      OR monitor_source_posts.quoted_post IS NULL AND EXCLUDED.quoted_post IS NOT NULL
      OR monitor_source_posts.reply_to IS DISTINCT FROM EXCLUDED.reply_to AND EXCLUDED.reply_to IS NOT NULL
      OR monitor_source_posts.quoted_post IS DISTINCT FROM EXCLUDED.quoted_post AND EXCLUDED.quoted_post IS NOT NULL`;
  return rows.count;
}
export async function sourcePost(id: string, db: Db = sql) {
  const [post] = await db<
    SourcePostRow[]
  >`SELECT id,author,published_at,url,text,quoted_post,reply_to,context_only,filtered_out,title,summary,source_receipt_id,model_receipt_id,processing_status,review_reason,created_at,updated_at FROM monitor_source_posts WHERE monitor_id=${monitorId()} AND id=${id}`;
  return post ? { ...post, version: rowVersion(post) } : null;
}
export class StalePostWork extends Conflict {}
export async function pendingPostVersion(id: string, expectedVersion: string, db: Db = sql) {
  await db`SELECT id FROM monitor_source_posts WHERE monitor_id=${monitorId()} AND id=${id} FOR UPDATE`;
  const post = await sourcePost(id, db);
  return post?.processing_status === "pending" && post.version === expectedVersion ? post : null;
}
export async function markPostReview(id: string, reason: string, expectedVersion: string, receiptId?: number, db: Db = sql, content?: { title: EditorialText; summary: EditorialText | null }) {
  const save = async (tx: Db) => {
    if (!await pendingPostVersion(id, expectedVersion, tx)) return false;
    await tx`UPDATE monitor_source_posts SET processing_status='needs_attention',filtered_out=false,review_reason=${reason.slice(0,1000)},model_receipt_id=coalesce(${receiptId ?? null},model_receipt_id),
      title=CASE WHEN ${!!content} THEN ${content ? tx.json(content.title) : null} ELSE title END,
      summary=CASE WHEN ${!!content} THEN ${content?.summary ? tx.json(content.summary) : null} ELSE summary END,updated_at=clock_timestamp()
      WHERE monitor_id=${monitorId()} AND id=${id} AND processing_status='pending'`;
    await captureReviewNotification(tx, id);
    return true;
  };
  return db === sql ? sql.begin(save) : save(db);
}
export async function markPostFailure(id: string, expectedVersion: string, receiptId?: number, db: Db = sql, reason = "处理失败，等待人工处理") {
  const save = async (tx: Db) => {
    if (!await pendingPostVersion(id, expectedVersion, tx)) return false;
    await tx`UPDATE monitor_source_posts SET processing_status='failed',filtered_out=false,review_reason=${reason.slice(0, 1000)},model_receipt_id=coalesce(${receiptId ?? null},model_receipt_id),updated_at=clock_timestamp()
      WHERE monitor_id=${monitorId()} AND id=${id} AND processing_status='pending'`;
    await captureReviewNotification(tx, id);
    return true;
  };
  return db === sql ? sql.begin(save) : save(db);
}
export function validateScope(scope: EditorialScope) {
  if (scope.type === "selected_users" && !scope.note)
    throw invalid("特定用户必须填写适用条件");
}
export function validateActionFacts(draft: ActionDraft) {
  if (draft.invalidatesEvent && draft.action !== "amend")
    throw invalid("只有修订动作可以标记事件失效");
}

/** Original bodies belong only to the admin post record, never to audit snapshots. */
export function auditPost(post: SourcePostRow | undefined) {
  if (!post) return null;
  return withoutPostOriginal(post);
}
export interface EventWrite {
  id: string;
  type?: EventRow["type"];
  title?: EditorialText | null;
  summary?: EditorialText | null;
  scope?: EditorialScope | null;
}
export interface ActionWriteOptions {
  events?: EventWrite[];
  replace?: boolean;
  editExisting?: boolean;
  newActionIds?: readonly (string | undefined)[];
  standaloneFollowups?: ReadonlySet<string>;
  /** INTERNAL: only verified refinements of these existing announcements may replace facts. */
  refineAnnouncementIds?: ReadonlySet<string>;
}
export async function lockActionRecords(db: Db, eventIds: Iterable<string>, actionIds: Iterable<string>, postIds: Iterable<string>) {
  const ordered = (ids: Iterable<string>) => [...new Set(ids)].sort();
  for (const id of ordered(eventIds)) await db`SELECT id FROM monitor_event_records WHERE monitor_id=${monitorId()} AND id=${id} FOR UPDATE`;
  for (const id of ordered(actionIds)) await db`SELECT id FROM monitor_event_actions WHERE monitor_id=${monitorId()} AND id=${id} FOR UPDATE`;
  for (const id of ordered(postIds)) await db`SELECT id FROM monitor_source_posts WHERE monitor_id=${monitorId()} AND id=${id} FOR UPDATE`;
}
export async function validateActionSources(db: Db, actions: Pick<ActionRow, "id" | "action" | "time" | "sources">[]) {
  for (const action of actions) {
    const ids = action.sources.map(source => source.postId);
    if (!ids.length) {
      if (action.action !== "confirm" || !action.time) throw invalid("只有填写明确生效时间的确认动作可以没有来源");
      continue;
    }
    if (new Set(ids).size !== ids.length || ids.some(id => !id)) throw invalid("动作必须有非重复来源");
    const valid = await db`SELECT id FROM monitor_source_posts WHERE monitor_id=${monitorId()} AND id=ANY(${ids}::text[]) AND NOT context_only`;
    if (valid.length !== ids.length) throw invalid("来源帖子不存在于当前监控");
  }
}
/** Automatic acceptance appends facts and sources; editorial commands use their own explicit planner. */
export async function writePostActions(db: Db, post: SourcePostRow, drafts: ActionDraft[], options: ActionWriteOptions = {}) {
  const normalized = drafts.map(raw => actionDraftSchema.parse(raw));
  if (normalized.some(draft => !draft.eventId)) throw invalid("动作必须明确所属事件");
  const previous = options.replace ? await db<ActionRow[]>`SELECT id,event_id,sequence,action,invalidates_event,title,summary,time,sources,created_at,updated_at FROM monitor_event_actions
    WHERE monitor_id=${monitorId()} AND sources @> ${db.json([{ postId: post.id }])}::jsonb` : [];
  const eventIds = [...new Set([...normalized.map(draft => draft.eventId!), ...(options.events ?? []).map(event => event.id), ...previous.map(action => action.event_id)])];
  await lockActionRecords(db, eventIds, [...normalized.flatMap(draft => draft.id ? [draft.id] : []), ...previous.map(action => action.id)], [post.id]);
  const actual = await sourcePost(post.id, db);
  if (!actual) throw invalid("来源帖子不存在于当前监控");
  if (actual.context_only) throw invalid("辅助上下文不能作为动作来源");
  for (const change of options.events ?? []) {
    if (change.scope) validateScope(change.scope);
    const [event] = await db<EventRow[]>`SELECT id,type,title,summary,scope,withdrawn,created_at,updated_at FROM monitor_event_records WHERE monitor_id=${monitorId()} AND id=${change.id}`;
    if (!event) {
      const startsEvent = normalized.some(action => action.eventId === change.id && ["announce", "confirm"].includes(action.action));
      if (!change.type || !monitor().eventKinds.includes(change.type) || (!startsEvent && !options.standaloneFollowups?.has(change.id)))
        throw invalid("新事件必须由有类型的预告或确认动作创建");
      const initial = normalized.find(action => action.eventId === change.id)!;
      await db`INSERT INTO monitor_event_records(monitor_id,id,type,title,summary,scope,created_at)
        VALUES(${monitorId()},${change.id},${change.type},${change.title ? db.json(change.title) : null},${change.summary === undefined ? initial.summary ? db.json(initial.summary) : null : change.summary ? db.json(change.summary) : null},${change.scope ? db.json(change.scope) : null},${post.published_at})`;
    } else {
      if (change.type && change.type !== event.type) throw invalid("事件类型修改必须通过事件编辑预览");
      if (!options.editExisting && normalized.filter(action => action.eventId === event.id).every(action => !!action.id)
        && stableJson({ title: change.title ?? event.title, summary: change.summary === undefined ? event.summary : change.summary, scope: change.scope === undefined ? event.scope : change.scope }) !== stableJson({ title: event.title, summary: event.summary, scope: event.scope }))
        throw invalid("补充来源不能修改事件事实或影响范围");
      await db`UPDATE monitor_event_records SET title=${change.title === undefined ? event.title ? db.json(event.title) : null : change.title ? db.json(change.title) : null},
        summary=${change.summary === undefined ? event.summary ? db.json(event.summary) : null : change.summary ? db.json(change.summary) : null},
        scope=${change.scope === undefined ? event.scope ? db.json(event.scope) : null : change.scope ? db.json(change.scope) : null},updated_at=clock_timestamp()
        WHERE monitor_id=${monitorId()} AND id=${event.id}`;
    }
  }
  if (options.replace) for (const action of previous) {
    const [latest] = await db<ActionRow[]>`SELECT id,sources FROM monitor_event_actions WHERE monitor_id=${monitorId()} AND id=${action.id}`;
    if (!latest) continue;
    const sources = latest.sources.filter(source => source.postId !== post.id);
    let time = action.time;
    if (action.action === "confirm" && sources.length && !normalized.some(draft => draft.id === action.id)) {
      const remaining = await db<Pick<SourcePostRow, "published_at">[]>`SELECT published_at FROM monitor_source_posts WHERE monitor_id=${monitorId()} AND id=ANY(${sources.map(source => source.postId)}::text[]) AND NOT context_only`;
      time = sourcedConfirmationTime(remaining, action.time) ?? action.time;
    }
    await db`UPDATE monitor_event_actions SET time=${db.json(time)},sources=${db.json(sources)},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${action.id}`;
  }
  for (const [index, draft] of normalized.entries()) {
    const [event] = await db<EventRow[]>`SELECT id,type,withdrawn FROM monitor_event_records WHERE monitor_id=${monitorId()} AND id=${draft.eventId!}`;
    if (!event) throw invalid("所属事件不存在");
    if (event.withdrawn && !previous.some(action => action.event_id === event.id)) throw invalid("已撤回事件不能新增来源");
    validateActionFacts(draft);
    let [existing] = draft.id ? await db<ActionRow[]>`SELECT id,event_id,sequence,action,invalidates_event,title,summary,time,sources,created_at,updated_at FROM monitor_event_actions WHERE monitor_id=${monitorId()} AND id=${draft.id}` : [];
    if (!draft.id && draft.action === "confirm") {
      const input = await loadActionInput(db);
      const current = currentUnsourcedConfirmation(input.events.find(row => row.id === event.id)!, input);
      if (current) existing = current;
    }
    const upgrading = existing?.action === "confirm" && existing.sources.length === 0 && draft.action === "confirm";
    if (draft.id && (!existing || existing.event_id !== event.id)) throw invalid("动作不属于目标事件");
    const refining = existing?.action === "announce" && draft.action === "announce" && options.refineAnnouncementIds?.has(existing.id);
    const draftTime = normalizePublicTime(draft.time);
    if (existing && !upgrading && !options.editExisting && (existing.action !== draft.action || existing.invalidates_event !== (draft.invalidatesEvent ?? false)
      || !refining && stableJson(existing.time) !== stableJson(draftTime))) throw invalid("补充来源不能修改已接受动作事实");
    const sources = existing ? [...existing.sources] : [];
    if (!sources.some(source => source.postId === post.id)) sources.push({ postId: post.id });
    sources.sort((a, b) => a.postId.localeCompare(b.postId));
    let time = draftTime;
    if (draft.action === "confirm") {
      const otherIds = sources.filter(source => source.postId !== post.id).map(source => source.postId);
      const others = otherIds.length ? await db<Pick<SourcePostRow, "published_at">[]>`SELECT published_at FROM monitor_source_posts WHERE monitor_id=${monitorId()} AND id=ANY(${otherIds}::text[]) AND NOT context_only` : [];
      time = sourcedConfirmationTime([actual, ...others], existing?.sources.length ? existing.time : undefined)!;
    }
    if (existing) {
      if (refining && stableJson(existing.time) !== stableJson(time)) {
        const actions = await db<Parameters<typeof inferencesAfterAnnouncement>[1]>`SELECT id,event_id,sequence,action,invalidates_event,sources FROM monitor_event_actions WHERE monitor_id=${monitorId()} AND event_id=${event.id}`;
        await invalidateInferences(db, inferencesAfterAnnouncement(existing, actions, await loadManualConfirmationIds(db)));
      }
      if (options.editExisting || upgrading) await db`UPDATE monitor_event_actions SET action=${draft.action},invalidates_event=${draft.invalidatesEvent ?? false},title=${db.json(draft.title)},summary=${draft.summary ? db.json(draft.summary) : null},time=${db.json(time)},sources=${db.json(sources)},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${existing.id}`;
      else await db`UPDATE monitor_event_actions SET time=${db.json(refining || draft.action === "confirm" ? time : existing.time)},sources=${db.json(sources)},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${existing.id}`;
      if (draft.action === "confirm") await removeManualConfirmations(db, [existing.id]);
    } else {
      const [max] = await db<{ sequence: number }[]>`SELECT coalesce(max(sequence),0)+1 AS sequence FROM monitor_event_actions WHERE monitor_id=${monitorId()} AND event_id=${event.id}`;
      const id = options.newActionIds?.[index] ?? randomUUID();
      await db`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,invalidates_event,title,summary,time,sources)
        VALUES(${monitorId()},${id},${event.id},${max!.sequence},${draft.action},${draft.invalidatesEvent ?? false},${db.json(draft.title)},${draft.summary ? db.json(draft.summary) : null},${db.json(time)},${db.json(sources)})`;
      if (max!.sequence === 1 && options.standaloneFollowups?.has(event.id)) {
        await saveStandaloneFollowups(db, [id]);
      }
    }
  }
  const removedIds = previous.map(action => action.id);
  if (removedIds.length) {
    const deleted = await db<{ id: string }[]>`DELETE FROM monitor_event_actions WHERE monitor_id=${monitorId()} AND id=ANY(${removedIds}::text[]) AND sources='[]'::jsonb RETURNING id`;
    await removeStandaloneFollowups(db, deleted.map(action => action.id));
    await removeInvalidatedInferences(db, deleted.map(action => action.id));
    await removeManualConfirmations(db, deleted.map(action => action.id));
  }
  const actions = await db<ActionRow[]>`SELECT id,action,time,sources FROM monitor_event_actions WHERE monitor_id=${monitorId()} AND event_id=ANY(${eventIds}::text[])`;
  await validateActionSources(db, actions);
  if (normalized.length) await db`UPDATE monitor_source_posts SET filtered_out=false,updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${post.id} AND filtered_out`;
  for (const id of eventIds) await db`UPDATE monitor_event_records SET updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${id}`;
  return eventIds;
}

export async function saveAcceptedPost(
  id: string,
  input: {
    title: EditorialText;
    summary: EditorialText | null;
    actions: ActionDraft[];
    receiptId: number | null;
    events?: EventWrite[];
    expectedVersion: string;
    filteredOut?: boolean;
    reviewReason?: string | null;
    standaloneFollowups?: ReadonlySet<string>;
    /** INTERNAL: supplied only after verifying a same-announcement explicit time reference. */
    refineAnnouncementIds?: ReadonlySet<string>;
  },
  db?: Db,
) {
  const save = async (tx: Db) => {
    await lockActionRecords(tx, [...input.actions.flatMap(action => action.eventId ? [action.eventId] : []), ...(input.events ?? []).map(event => event.id)], input.actions.flatMap(action => action.id ? [action.id] : []), [id]);
    const [post] = await tx<
      SourcePostRow[]
    >`SELECT id,author,published_at,url,text,quoted_post,reply_to,context_only,filtered_out,title,summary,source_receipt_id,model_receipt_id,processing_status,review_reason,created_at,updated_at FROM monitor_source_posts WHERE monitor_id=${monitorId()} AND id=${id} FOR UPDATE`;
    if (!post || post.processing_status !== "pending" || rowVersion(post) !== input.expectedVersion) throw new StalePostWork("帖子已变化，忽略过期识别结果");
    const affected = await writePostActions(tx, post, input.actions, { events: input.events, standaloneFollowups: input.standaloneFollowups, refineAnnouncementIds: input.refineAnnouncementIds });
    const [linked] = await tx`SELECT 1 FROM monitor_event_actions WHERE monitor_id=${monitorId()} AND sources @> ${tx.json([{ postId: id }])}::jsonb LIMIT 1`;
    await tx`UPDATE monitor_source_posts SET title=${tx.json(input.title)},summary=${input.summary ? tx.json(input.summary) : null},processing_status=${input.reviewReason ? "needs_attention" : "processed"},review_reason=${input.reviewReason?.slice(0, 1000) ?? null},model_receipt_id=${input.receiptId},filtered_out=${Boolean(input.filteredOut && !linked && !input.reviewReason)},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${id}`;
    if (input.reviewReason) await captureReviewNotification(tx, id);
    else await cancelReviewNotification(tx, id);
    const [historical] = await tx`SELECT 1 FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${`recognition:historical:${id}`}`;
    await tx`SELECT set_config('aihot.suppress_monitor_notifications',${historical ? "true" : "false"},true)`;
    await enqueuePublicV2(tx, affected);
    return affected;
  };
  return db ? save(db) : sql.begin(save);
}
