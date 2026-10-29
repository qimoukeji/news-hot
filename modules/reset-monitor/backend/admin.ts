import { z } from "zod";
import { randomUUID } from "node:crypto";
import { sql } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { sha256 } from "@aihot/backend/lib/ids";
import { identityKeyForUrl, tweetIdFromUrl } from "@aihot/backend/lib/url";
import { monitorId, monitor, auditAction, auditSubject } from "./context.ts";
import {
  editorialTextSchema,
  defaultActionTime,
  editorialScopeSchema,
  reduceEvent,
  sourcedActions,
  iso,
  type ActionInput,
  type SourcePostRow,
  type EventRow,
} from "../actions.ts";
import { loadActionInput, rowVersion, validateScope, validateActionFacts, sourcePost, auditPost } from "./action-store.ts";
import { monitorEventDetail as reviewEventDetail } from "./manual-review.ts";
import { projectPublicV2 } from "./public-v2.ts";
import { eventStatuses, sourceUrlSchema, timestampSchema } from "../public-v2.ts";
import { enqueuePublicV2 } from "./public-v2-work.ts";
import { adminTimeFilter } from "./admin-time.ts";
export {
  monitorPostDetail,
  previewMonitorReview,
  submitMonitorReview,
  previewMonitorEventReview,
  submitMonitorEventReview,
} from "./manual-review.ts";
export function pagination(total: number, requested = 1) {
  const totalPages = Math.ceil(total / 10),
    page = Math.min(
      Math.max(1, Math.trunc(Number.isFinite(requested) ? requested : 1)),
      Math.max(1, totalPages),
    );
  return { page, pageSize: 10, total, totalPages };
}
const searchable = (value: unknown): string => {
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value)) return value.map(searchable).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(searchable).join(" ");
  return "";
};
const eventKinds = ["direct_reset", "reset_credit", "bonus_credit"] as const;
function postRow(post: SourcePostRow, input: ActionInput) {
  const actions = input.actions.filter(action => action.sources.some(source => source.postId === post.id));
  const events = input.events.filter(event => actions.some(action => action.event_id === event.id))
    .map(event => ({ id: event.id, title: event.title ?? sourcedActions(event, input).at(-1)?.action.title ?? null, type: event.type }));
  return { id: post.id, author: post.author, publishedAt: iso(post.published_at), title: post.title, summary: post.summary, url: post.url,
    replyTo: post.reply_to, filteredOut: post.filtered_out,
    processingStatus: post.processing_status, reviewReason: post.review_reason, events, actionCount: actions.length, version: rowVersion(post) };
}
function eventRows(input: ActionInput) {
  const published = projectPublicV2({ ...input, events: input.events.map(row => ({ ...row, withdrawn: false })) }, monitor()).events;
  return input.events.map(row => {
    const event = published.find(event => event.id === row.id), reduced = reduceEvent(row, input), actions = sourcedActions(row, input);
    const posts = [...new Map(actions.flatMap(action => action.posts).map(post => [post.id, post])).values()];
    const timeline = actions.map(({ action, posts, publishedAt }) => ({
      id: action.id, action: action.action, invalidatesEvent: action.invalidates_event, title: action.title, summary: action.summary, time: action.time ?? defaultActionTime(action.action, publishedAt), sequence: action.sequence,
      publishedAt, sources: posts.map(post => postRow(post, input)),
    })).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id));
    return { ...row, title: row.title ?? event?.title ?? actions.at(-1)?.action.title ?? null, summary: row.summary,
      version: rowVersion(row), status: reduced?.status ?? null, time: reduced?.time ?? null, scope: row.scope,
      visibility: row.withdrawn ? "withdrawn" as const : reduced ? "public" as const : "unpublished" as const,
      actionCount: actions.length, sourcePostCount: posts.length, timeline, latestAt: posts.map(post => iso(post.published_at)).sort().at(-1) ?? iso(row.created_at),
      updates: event?.updates ?? [], publishedAt: event?.publishedAt ?? iso(row.created_at), createdAt: row.created_at, updatedAt: row.updated_at,
      searchText: searchable([row.id, row.title, row.summary, row.scope, event?.title, actions.map(item => [item.action.title, item.action.summary]), posts.map(post => [post.id, post.title, post.summary, post.author, post.url, post.text, post.quoted_post?.text, post.review_reason])]),
    };
  });
}
function postRows(input: ActionInput) {
  return input.posts.filter(post => !post.context_only).map(post => {
    const row = postRow(post, input);
    return { ...row, searchText: searchable([post.id, post.author, post.title, post.summary, post.url, post.text, post.quoted_post?.text, post.review_reason, row.events]) };
  });
}
export async function monitorEventDetail(id: string) {
  const input = await loadActionInput();
  const detail = await reviewEventDetail(id, input);
  if (!detail) return null;
  const { searchText: _search, ...event } = eventRows(input).find(row => row.id === id)!;
  return { ...detail, event: { ...detail.event, ...event } };
}
const eventFilters = (opts: { type?: string; status?: string; visibility?: string }) => ({
  type: z.enum(["all", ...eventKinds]).parse(opts.type ?? "all"),
  status: z.enum(["all", ...eventStatuses]).parse(opts.status ?? "all"),
  visibility: z.enum(["all", "public", "withdrawn", "unpublished"]).parse(opts.visibility ?? "all"),
});
const collectionFilterSchema = z.enum(["normal", "filtered", "all"]);
function collectionMatches(post: { filteredOut: boolean; actionCount: number }, filter: z.infer<typeof collectionFilterSchema>) {
  const filtered = post.filteredOut && !post.actionCount;
  return filter === "all" || (filter === "filtered" ? filtered : !filtered);
}
export async function listMonitorPosts(opts: { page?: number; filter?: string; q?: string; collectionFilter?: string; association?: string; from?: string; to?: string } = {}) {
  const inRange = adminTimeFilter(opts);
  const input = await loadActionInput();
  const filter = z.enum(["all", "pending", "processed", "needs_attention", "failed"]).parse(opts.filter ?? "all");
  const query = z.string().trim().parse(opts.q ?? "").toLowerCase();
  const collectionFilter = collectionFilterSchema.parse(opts.collectionFilter ?? "normal");
  const association = z.enum(["all", "linked", "unlinked"]).parse(opts.association ?? "all");
  const all = postRows(input).filter(post => inRange(post.publishedAt) && collectionMatches(post, collectionFilter) && (association === "all" || (association === "linked" ? post.events.length > 0 : post.events.length === 0)) && (filter === "all" || post.processingStatus === filter) && (!query || post.searchText.includes(query)))
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime() || a.id.localeCompare(b.id));
  const meta = pagination(all.length, opts.page);
  return { ...meta, rows: all.slice((meta.page - 1) * 10, meta.page * 10).map(({ searchText: _search, ...row }) => row) };
}
const postTitle = editorialTextSchema.refine(value => !!value.zh?.trim(), "标题必须填写中文")
  .transform(value => ({ ...value, zh: value.zh!.trim() }));
const createPost = z.strictObject({
  author: z.string().trim().min(1), publishedAt: timestampSchema,
  url: z.string().trim().pipe(sourceUrlSchema), title: postTitle,
  summary: editorialTextSchema.nullable().optional().default(null), text: z.string().nullable().optional().default(null),
});
const editPost = z.strictObject({ version: z.string().min(1), patch: z.strictObject({ title: postTitle.optional(), summary: editorialTextSchema.nullable().optional() })
  .refine(value => Object.keys(value).length > 0, "请选择需要修改的帖子内容") });

/** Manual sources are already reviewed; only an explicit event action can publish them. */
export async function createMonitorPost(value: unknown, actor: string) {
  const input = createPost.parse(value);
  const author = monitor().authors.find(author => author.handle.toLowerCase() === input.author.replace(/^@/, "").toLowerCase());
  if (!author) throw Object.assign(new Error("请选择当前监控配置的作者"), { statusCode: 400 });
  const identity = identityKeyForUrl(input.url)!;
  const id = tweetIdFromUrl(input.url) ?? `manual-${sha256(identity)}`;
  return sql.begin(async tx => {
    const existing = await tx<{ id: string; url: string }[]>`SELECT id,url FROM monitor_source_posts WHERE monitor_id=${monitorId()}`;
    if (existing.some(post => post.id === id || identityKeyForUrl(post.url) === identity)) throw new Conflict("该帖子已存在，请在列表中编辑");
    const inserted = await tx`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,title,summary,processing_status,filtered_out)
      VALUES(${monitorId()},${id},${author.handle},${input.publishedAt},${input.url},${input.text},${tx.json(input.title)},${input.summary ? tx.json(input.summary) : null},'processed',false)
      ON CONFLICT(monitor_id,id) DO NOTHING`;
    if (!inserted.count) throw new Conflict("该帖子已存在，请在列表中编辑");
    const post = (await sourcePost(id, tx))!;
    const { version: _version, ...saved } = post;
    await audit(actor, auditAction("create-post"), auditSubject("post", id), "创建帖子", null, auditPost(saved), { db: tx });
    return postRow(saved, { events: [], actions: [], posts: [saved] });
  });
}

/** Source identity and recognition progress stay unchanged when correcting display text. */
export async function updateMonitorPost(id: string, value: unknown, actor: string) {
  const input = editPost.parse(value);
  return sql.begin(async tx => {
    await tx`SELECT id FROM monitor_source_posts WHERE monitor_id=${monitorId()} AND id=${id} FOR UPDATE`;
    const current = await sourcePost(id, tx);
    if (!current || current.context_only) return null;
    if (current.version !== input.version) throw new Conflict("帖子已变化，请重新读取后编辑");
    const { version: _version, ...before } = current;
    const title = input.patch.title ?? current.title;
    const summary = input.patch.summary === undefined ? current.summary : input.patch.summary;
    await tx`UPDATE monitor_source_posts SET title=${title ? tx.json(title) : null},summary=${summary ? tx.json(summary) : null},updated_at=clock_timestamp()
      WHERE monitor_id=${monitorId()} AND id=${id}`;
    const { version: _afterVersion, ...after } = (await sourcePost(id, tx))!;
    await audit(actor, auditAction("update-post"), auditSubject("post", id), "编辑帖子", auditPost(before), auditPost(after), { db: tx });
    const data = await loadActionInput(tx);
    return postRow(after, data);
  });
}
export async function listMonitorEntries(opts: { page?: number; q?: string; type?: string; status?: string; visibility?: string; filter?: string; kind?: string; collectionFilter?: string; from?: string; to?: string } = {}) {
  const inRange = adminTimeFilter(opts);
  const query = z.string().trim().parse(opts.q ?? "").toLowerCase();
  const { type, status, visibility } = eventFilters(opts);
  const filter = z.enum(["all", "pending", "processed", "needs_attention", "failed"]).parse(opts.filter ?? "all");
  const kind = z.enum(["all", "events", "posts"]).parse(opts.kind ?? "all");
  const collectionFilter = collectionFilterSchema.parse(opts.collectionFilter ?? "normal");
  const input = await loadActionInput();
  type Entry = { kind: "event"; event: Omit<ReturnType<typeof eventRows>[number], "searchText">; latestAt: string }
    | { kind: "post"; post: Omit<ReturnType<typeof postRows>[number], "searchText">; latestAt: string };
  const rows: Entry[] = [];
  if (kind !== "posts" && collectionFilter !== "filtered") for (const { searchText, ...event } of eventRows(input)) {
    if (inRange(event.latestAt) && (type === "all" || event.type === type) && (status === "all" || event.status === status)
      && (visibility === "all" || event.visibility === visibility) && (!query || searchText.includes(query))
      && (filter === "all" || event.timeline.some(action => action.sources.some(post => post.processingStatus === filter)))) {
      rows.push({ kind: "event", event, latestAt: event.latestAt });
    }
  }
  if (kind !== "events" && type === "all" && status === "all" && visibility === "all") for (const { searchText, ...post } of postRows(input)) {
    if (inRange(post.publishedAt) && !post.actionCount && collectionMatches(post, collectionFilter) && (filter === "all" || post.processingStatus === filter) && (!query || searchText.includes(query)))
      rows.push({ kind: "post", post, latestAt: post.publishedAt });
  }
  rows.sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt)
    || `${a.kind}:${a.kind === "event" ? a.event.id : a.post.id}`.localeCompare(`${b.kind}:${b.kind === "event" ? b.event.id : b.post.id}`));
  const meta = pagination(rows.length, opts.page);
  return { ...meta, rows: rows.slice((meta.page - 1) * meta.pageSize, meta.page * meta.pageSize) };
}
const eventFields = {
  type: z.enum(eventKinds),
  title: editorialTextSchema,
  summary: editorialTextSchema.nullable(),
  scope: editorialScopeSchema,
};
const create = z.strictObject({
  ...eventFields,
  title: eventFields.title.refine(value => !!value.zh?.trim(), "标题必须填写中文").transform(value => ({ ...value, zh: value.zh!.trim() })),
  summary: eventFields.summary.optional().default(null),
  scope: eventFields.scope.nullable().optional().default(null),
});
const edit = z.strictObject({
  version: z.string().min(1),
  reason: z.string().trim().min(1).optional(),
  previewToken: z.string().optional(),
  patch: z.strictObject(eventFields).partial(),
});
function eventEditToken(before: EventRow, patch: z.infer<typeof edit>["patch"], data: Awaited<ReturnType<typeof loadActionInput>>) {
  const actions = data.actions.filter(action => action.event_id === before.id),
    postIds = new Set(actions.flatMap(action => action.sources.map(source => source.postId)));
  return rowVersion({ before, patch, actions, posts: data.posts.filter(post => postIds.has(post.id)) });
}
function prepareEventEdit(before: EventRow, patch: z.infer<typeof edit>["patch"], data: Awaited<ReturnType<typeof loadActionInput>>) {
  const next = { ...before, ...patch };
  if (next.scope) validateScope(next.scope);
  if (!monitor().eventKinds.includes(next.type))
    throw Object.assign(new Error("当前监控不支持事件类型"), { statusCode: 400 });
  for (const action of data.actions.filter(action => action.event_id === before.id)) {
    validateActionFacts({ eventId: before.id, action: action.action, title: action.title, summary: action.summary,
      time: action.time, invalidatesEvent: action.invalidates_event });
  }
  return { next, previous: reduceEvent(before, data), result: reduceEvent(next, data) };
}

/** A manual event stays private until an initial action supplies its business facts. */
export async function createMonitorEvent(value: unknown, actor: string) {
  const input = create.parse(value);
  return sql.begin(async tx => {
    const at = new Date().toISOString();
    const event: EventRow = { id: randomUUID(), ...input, withdrawn: false, created_at: at, updated_at: at };
    prepareEventEdit(event, {}, { events: [event], actions: [], posts: [] });
    const [saved] = await tx<EventRow[]>`INSERT INTO monitor_event_records(monitor_id,id,type,title,summary,scope,withdrawn,created_at,updated_at)
      VALUES(${monitorId()},${event.id},${event.type},${tx.json(event.title!)},${event.summary ? tx.json(event.summary) : null},${event.scope ? tx.json(event.scope) : null},false,${at},${at})
      RETURNING id,type,title,summary,scope,withdrawn,created_at,updated_at`;
    await audit(actor, auditAction("create"), auditSubject("event", saved!.id), "创建事件", null, saved, { db: tx });
    await enqueuePublicV2(tx, [saved!.id]);
    return { ...saved!, version: rowVersion(saved), createdAt: iso(saved!.created_at), updatedAt: iso(saved!.updated_at) };
  });
}

/** Display reclassification is previewed through the same action validation and reducer used at commit. */
export async function previewMonitorEvent(id: string, value: unknown) {
  const input = edit.parse(value);
  return sql.begin("isolation level repeatable read read only", async tx => {
    const data = await loadActionInput(tx), before = data.events.find(event => event.id === id);
    if (!before) return null;
    if (rowVersion(before) !== input.version) throw new Conflict("事件已变化，请重新预览");
    const { next, previous, result } = prepareEventEdit(before, input.patch, data);
    return { eventId: id, version: input.version, previewToken: eventEditToken(before, input.patch, data),
      before: { ...before, status: previous?.status ?? null, time: previous?.time ?? null },
      after: { ...next, status: result?.status ?? null, time: result?.time ?? null, scope: result?.scope ?? next.scope } };
  });
}
export async function updateMonitorEvent(
  id: string,
  value: unknown,
  actor: string,
) {
  const input = edit.parse(value);
  return sql.begin(async (tx) => {
    const [before] = await tx<
      EventRow[]
    >`SELECT id,type,title,summary,scope,withdrawn,created_at,updated_at FROM monitor_event_records WHERE monitor_id=${monitorId()} AND id=${id} FOR UPDATE`;
    if (!before) return null;
    if (rowVersion(before) !== input.version)
      throw new Conflict("事件已变化，请重新预览");
    const data = await loadActionInput(tx);
    const { next } = prepareEventEdit(before, input.patch, data);
    if (next.type !== before.type && input.previewToken !== eventEditToken(before, input.patch, data))
      throw new Conflict("请先预览事件类型调整；事件或动作变化后须重新预览");
    const [after] =
      await tx`UPDATE monitor_event_records SET type=${next.type},title=${next.title ? tx.json(next.title) : null},summary=${next.summary ? tx.json(next.summary) : null},scope=${next.scope ? tx.json(next.scope) : null},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${id} RETURNING *`;
    await audit(
      actor,
      auditAction("update"),
      auditSubject("event", id),
      input.reason ?? "编辑事件",
      before,
      after,
      { db: tx },
    );
    await enqueuePublicV2(tx, [id]);
    return after;
  });
}
export async function setWithdrawn(id: string, value: unknown, actor: string) {
  const input = z
    .strictObject({
      version: z.string().min(1),
      reason: z.string().trim().min(1),
      withdrawn: z.boolean(),
    })
    .parse(value);
  return sql.begin(async (tx) => {
    const [before] = await tx<
      EventRow[]
    >`SELECT id,type,title,summary,scope,withdrawn,created_at,updated_at FROM monitor_event_records WHERE monitor_id=${monitorId()} AND id=${id} FOR UPDATE`;
    if (!before) return null;
    if (rowVersion(before) !== input.version)
      throw new Conflict("事件已变化，请刷新");
    if (!input.withdrawn && !reduceEvent(before, await loadActionInput(tx)))
      throw Object.assign(new Error("没有有效预告或确认动作，不能恢复公开"), {
        statusCode: 400,
      });
    const [after] =
      await tx`UPDATE monitor_event_records SET withdrawn=${input.withdrawn},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${id} RETURNING *`;
    await audit(
      actor,
      auditAction(input.withdrawn ? "withdraw" : "restore"),
      auditSubject("event", id),
      input.reason,
      before,
      after,
      { db: tx },
    );
    await enqueuePublicV2(tx, [id]);
    return after;
  });
}
