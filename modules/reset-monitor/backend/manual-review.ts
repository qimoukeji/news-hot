import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { monitorId, monitor, auditAction, auditSubject } from "./context.ts";
import { actionDraftSchema, editorialTextSchema, editorialScopeSchema, reduceEvent, sourcedActions, currentUnsourcedConfirmation, type ActionInput, type ActionRow } from "../actions.ts";
import { loadActionInput, rowVersion, validateActionFacts, validateScope, lockActionRecords, validateActionSources, auditPost } from "./action-store.ts";
import { enqueuePublicV2 } from "./public-v2-work.ts";
import { normalizePublicTime } from "../public-v2.ts";
import { postContext } from "./post-context.ts";
const id = z.string().min(1);
const eventCreate = z.strictObject({ localKey: id, type: z.enum(["direct_reset", "reset_credit", "bonus_credit"]), title: editorialTextSchema.nullable().optional(), summary: editorialTextSchema.nullable().optional(), scope: editorialScopeSchema.nullable().optional() });
const { id: _id, eventId: _eventId, ...actionShape } = actionDraftSchema.shape;
const actionFields = z.strictObject(actionShape);
const actionCreate = actionFields.extend({ localKey: id, eventId: id.optional(), eventKey: id.optional() });
const sourceAdd = z.strictObject({ actionId: id.optional(), actionKey: id.optional(), postId: id });
const versionsSchema = z.strictObject({ events: z.record(z.string(), z.string()), actions: z.record(z.string(), z.string()), posts: z.record(z.string(), z.string()) });
const commandsSchema = z.strictObject({
  completeProcessing: z.boolean().optional(),
  keepPost: z.literal(true).optional(),
  version: id, versions: versionsSchema.optional(), reason: z.string().trim().min(1).optional(), previewToken: z.string().optional(),
  events: z.strictObject({ create: z.array(eventCreate).max(100).default([]), update: z.array(z.strictObject({ id, scope: editorialScopeSchema.nullable() })).max(100).default([]) }).default({ create: [], update: [] }),
  actions: z.strictObject({ create: z.array(actionCreate).max(100).default([]), update: z.array(actionFields.extend({ id })).max(100).default([]) }).default({ create: [], update: [] }),
  sources: z.strictObject({ add: z.array(sourceAdd).max(200).default([]), remove: z.array(z.strictObject({ actionId: id, postId: id })).max(200).default([]) }).default({ add: [], remove: [] }),
  orders: z.array(z.strictObject({ eventId: id, actionIds: z.array(id).max(200) })).max(100).default([]),
  post: z.strictObject({ title: editorialTextSchema.optional(), summary: editorialTextSchema.nullable().optional() }).optional(),
});
type Commands = z.infer<typeof commandsSchema>;
type Origin = { kind: "post" | "event"; id: string };
const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
function baseIds(input: ActionInput, origin: Origin) {
  const eventIds = new Set(origin.kind === "event" ? [origin.id] : input.actions.filter(action => action.sources.some(source => source.postId === origin.id)).map(action => action.event_id));
  return relatedIds(input, eventIds, origin.kind === "post" ? [origin.id] : []);
}
function relatedIds(input: ActionInput, eventIds: Iterable<string>, extraPosts: Iterable<string> = []) {
  const events = new Set(eventIds), actions = input.actions.filter(action => events.has(action.event_id));
  return { events: [...events].sort(), actions: actions.map(action => action.id).sort(), posts: [...new Set([...extraPosts, ...actions.flatMap(action => action.sources.map(source => source.postId))])].sort() };
}
function subset(input: ActionInput, ids: ReturnType<typeof relatedIds>) {
  return { events: input.events.filter(event => ids.events.includes(event.id)), actions: input.actions.filter(action => ids.actions.includes(action.id)), posts: input.posts.filter(post => ids.posts.includes(post.id)) };
}
const originExists = (input: ActionInput, origin: Origin) => origin.kind === "post" ? input.posts.some(post => post.id === origin.id && !post.context_only) : input.events.some(event => event.id === origin.id);
const baseVersion = (input: ActionInput, origin: Origin) => rowVersion(subset(input, baseIds(input, origin)));
function options(input: ActionInput) {
  return {
    events: input.events.map(event => {
      const reduced = reduceEvent(event, input), actions = sourcedActions(event, input);
      return { ...event, status: reduced?.status ?? null, time: reduced?.time ?? null,
        unsourcedConfirmationId: currentUnsourcedConfirmation(event, input)?.id ?? null,
        actionCount: actions.length, sourcePostCount: new Set(actions.flatMap(action => action.posts.map(post => post.id))).size,
        createdAt: event.created_at, updatedAt: event.updated_at, version: rowVersion(event) };
    }),
    actions: input.actions.map(action => ({ ...action, invalidatesEvent: action.invalidates_event, eventId: action.event_id, sources: action.sources, version: rowVersion(action) })),
    posts: input.posts.filter(post => !post.context_only).map(post => ({ id: post.id, author: post.author, publishedAt: post.published_at, url: post.url, title: post.title, summary: post.summary, text: post.text, quotedPost: post.quoted_post, replyTo: post.reply_to, filteredOut: post.filtered_out, processingStatus: post.processing_status, reviewReason: post.review_reason, version: rowVersion(post) })),
  };
}
async function detail(origin: Origin, savedInput?: ActionInput) {
  const input = savedInput ?? await loadActionInput();
  if (!originExists(input, origin)) return null;
  const all = options(input), related = baseIds(input, origin);
  const post = origin.kind === "post" ? all.posts.find(post => post.id === origin.id) : undefined;
  const event = origin.kind === "event" ? all.events.find(event => event.id === origin.id) : undefined;
  return { version: baseVersion(input, origin), ...(post ? { post, context: postContext(input.posts.find(row => row.id === post.id)!, input.posts) } : {}), ...(event ? { event } : {}),
    events: all.events.filter(event => related.events.includes(event.id)), actions: all.actions.filter(action => related.actions.includes(action.id)), posts: all.posts.filter(post => related.posts.includes(post.id)),
    options: all, versions: Object.fromEntries(["events", "actions", "posts"].map(kind => [kind, Object.fromEntries(input[kind as keyof ActionInput].map(row => [row.id, rowVersion(row)]))])) };
}
export const monitorPostDetail = (id: string) => detail({ kind: "post", id });
export const monitorEventDetail = (id: string, input?: ActionInput) => detail({ kind: "event", id }, input);
function unique(values: string[], name: string) { if (new Set(values).size !== values.length) throw invalid(name + "不能重复"); }
function prepare(state: ActionInput, origin: Origin, value: unknown) {
  const parsed = commandsSchema.parse(value);
  const relationChanges = parsed.events.create.length + parsed.events.update.length + parsed.actions.create.length + parsed.actions.update.length
    + parsed.sources.add.length + parsed.sources.remove.length + parsed.orders.length;
  if (!parsed.reason && origin.kind === "post" && (parsed.post || parsed.completeProcessing !== undefined || parsed.keepPost || !relationChanges)) throw invalid("帖子复核必须填写理由");
  const command = { ...parsed, reason: parsed.reason ?? (origin.kind === "post" ? "后台帖子关联" : "后台动作管理") };
  if (!originExists(state, origin)) return null;
  if (baseVersion(state, origin) !== command.version) throw new Conflict("当前帖子或事件的关联记录已变化，请刷新后预览");
  if ((command.post || command.completeProcessing || command.keepPost) && origin.kind !== "post") throw invalid("只有帖子复核可以编辑或保留帖子");
  unique(command.events.create.map(item => item.localKey), "新事件标识"); unique(command.actions.create.map(item => item.localKey), "新动作标识");
  unique(command.events.update.map(item => item.id), "事件修改"); unique(command.actions.update.map(item => item.id), "动作更正"); unique(command.orders.map(item => item.eventId), "事件排序");
  unique(command.sources.add.map(item => `${item.actionId ?? "key:" + item.actionKey}:${item.postId}`), "新增来源"); unique(command.sources.remove.map(item => `${item.actionId}:${item.postId}`), "移除来源");
  const identity = rowVersion({ origin, version: command.version, events: command.events.create.map(item => item.localKey), actions: command.actions.create.map(item => item.localKey) });
  const eventKeys = new Map(command.events.create.map((item, index) => [item.localKey, `manual-event-${identity}-${index}`]));
  const actionKeys = new Map(command.actions.create.map((item, index) => [item.localKey, `manual-action-${identity}-${index}`]));
  const eventRef = (item: { eventId?: string; eventKey?: string }) => {
    if (Boolean(item.eventId) === Boolean(item.eventKey)) throw invalid("动作必须选择一个现有事件或新事件");
    const target = item.eventId ?? eventKeys.get(item.eventKey!); if (!target) throw invalid("新事件标识不存在"); return target;
  };
  const actionRef = (item: { actionId?: string; actionKey?: string }) => {
    if (Boolean(item.actionId) === Boolean(item.actionKey)) throw invalid("来源必须选择一个现有动作或新动作");
    const target = item.actionId ?? actionKeys.get(item.actionKey!); if (!target) throw invalid("新动作标识不存在"); return target;
  };
  const affected = new Set<string>(command.events.update.map(item => item.id));
  const explicitPostIds = new Set<string>(origin.kind === "post" ? [origin.id] : []);
  for (const item of command.actions.create) affected.add(eventRef(item));
  for (const item of [...command.actions.update.map(item => ({ actionId: item.id })), ...command.sources.add, ...command.sources.remove]) {
    const target = actionRef(item), existing = state.actions.find(action => action.id === target);
    if (existing) affected.add(existing.event_id);
    else if (![...actionKeys.values()].includes(target)) throw invalid("动作不存在于当前监控");
  }
  for (const item of command.orders) affected.add(item.eventId);
  for (const item of [...command.sources.add, ...command.sources.remove]) explicitPostIds.add(item.postId);
  const related = relatedIds(state, affected, explicitPostIds);
  const baseline = baseIds(state, origin);
  const selected = subset(state, related);
  for (const kind of ["events", "actions", "posts"] as const) for (const row of selected[kind]) {
    const expected = command.versions?.[kind][row.id];
    if (expected ? expected !== rowVersion(row) : !baseline[kind].includes(row.id)) throw new Conflict("新选择的记录已变化，请刷新选项后重新预览");
  }
  const after = structuredClone(state), createdAt = new Date(origin.kind === "post" ? state.posts.find(post => post.id === origin.id)!.published_at : state.events.find(event => event.id === origin.id)!.updated_at).toISOString();
  const findEvent = (id: string) => { const event = after.events.find(event => event.id === id); if (!event) throw invalid("事件不存在于当前监控"); return event; };
  const findAction = (id: string) => { const action = after.actions.find(action => action.id === id); if (!action) throw invalid("动作不存在于当前监控"); return action; };
  for (const item of command.events.create) {
    if (!monitor().eventKinds.includes(item.type)) throw invalid("当前监控不支持事件类型");
    if (item.scope) validateScope(item.scope);
    const id = eventKeys.get(item.localKey)!; affected.add(id);
    const sourceDate = origin.kind === "post" ? state.posts.find(post => post.id === origin.id)!.published_at : createdAt;
    after.events.push({ id, type: item.type, title: item.title ?? null, summary: item.summary ?? null, scope: item.scope ?? null, withdrawn: false, created_at: sourceDate, updated_at: sourceDate });
  }
  for (const item of command.events.update) { if (item.scope) validateScope(item.scope); findEvent(item.id).scope = item.scope; }
  for (const item of command.actions.create) {
    const event = findEvent(eventRef(item)); if (event.withdrawn) throw invalid("已撤回事件不能新增动作");
    if (!after.actions.some(action => action.event_id === event.id && ["announce", "confirm"].includes(action.action)) && !["announce", "confirm"].includes(item.action)) throw invalid("事件首个动作必须为预告或确认");
    const draft = { eventId: event.id, action: item.action, invalidatesEvent: item.invalidatesEvent, title: item.title, summary: item.summary, time: item.time ? normalizePublicTime(item.time) : null };
    validateActionFacts(draft);
    // Planned official sources must participate in replay before later actions choose an upgrade target.
    const plannedSources = command.sources.add.filter(source => source.actionKey === item.localKey).map(source => ({ postId: source.postId }));
    const current = item.action === "confirm" ? currentUnsourcedConfirmation(event, after) : null;
    if (current) {
      Object.assign(current, { title: draft.title, summary: draft.summary, time: draft.time, sources: plannedSources });
      actionKeys.set(item.localKey, current.id);
      continue;
    }
    const sequence = Math.max(0, ...after.actions.filter(action => action.event_id === event.id).map(action => action.sequence)) + 1;
    after.actions.push({ action: draft.action, title: draft.title, summary: draft.summary, time: draft.time, id: actionKeys.get(item.localKey)!, event_id: event.id, invalidates_event: item.invalidatesEvent ?? false, sequence, sources: plannedSources, created_at: createdAt, updated_at: createdAt });
  }
  for (const item of command.actions.update) {
    const action = findAction(item.id), event = findEvent(action.event_id);
    validateActionFacts({ ...item, eventId: event.id });
    Object.assign(action, { action: item.action, invalidates_event: item.invalidatesEvent ?? false, title: item.title, summary: item.summary, time: item.time ? normalizePublicTime(item.time) : null });
  }
  for (const item of command.sources.remove) {
    const action = findAction(item.actionId);
    if (!state.actions.find(prior => prior.id === action.id)?.sources.some(source => source.postId === item.postId)) throw invalid("要移除的来源不属于该动作");
    action.sources = action.sources.filter(source => source.postId !== item.postId);
  }
  for (const item of command.sources.add) {
    if (!state.posts.some(post => post.id === item.postId && !post.context_only)) throw invalid("来源帖子不存在或仅为辅助上下文");
    const action = findAction(actionRef(item));
    if (findEvent(action.event_id).withdrawn && !action.sources.some(source => source.postId === item.postId)) throw invalid("已撤回事件不能新增来源");
    if (!action.sources.some(source => source.postId === item.postId)) action.sources.push({ postId: item.postId });
    action.sources.sort((a, b) => a.postId.localeCompare(b.postId));
  }
  const lastSourceRemovals = after.actions.filter(action => !action.sources.length && state.actions.some(prior => prior.id === action.id && prior.sources.length > 0)).map(action => ({ actionId: action.id, eventId: action.event_id, message: "最后一条来源移除后删除动作，请核对事件当前影响范围" }));
  const deleted = new Set(lastSourceRemovals.map(action => action.actionId));
  after.actions = after.actions.filter(action => !deleted.has(action.id));
  if (after.actions.some(action => !action.sources.length && (action.action !== "confirm" || !action.time))) throw invalid("只有填写明确生效时间的确认动作可以没有来源");
  for (const action of after.actions.filter(action => !action.sources.length)) {
    const time = action.time!, today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    if (time.length === 10 ? time > today : Date.parse(time.split("/").at(-1)!) > Date.now()) throw invalid("实际生效时间不能在未来");
  }
  const planCorrections: string[] = [];
  for (const item of command.actions.update) {
    const prior = state.actions.find(action => action.id === item.id)!;
    const next = after.actions.find(action => action.id === item.id);
    const event = findEvent(prior.event_id);
    if (!next || !["announce", "amend"].includes(prior.action) || prior.time === next.time
      || !currentUnsourcedConfirmation(event, state) || !next.sources.length) continue;
    const revisionId = `plan-correction-${rowVersion({ identity, action: next.id, time: next.time })}`;
    const sequence = Math.max(0, ...after.actions.filter(action => action.event_id === event.id).map(action => action.sequence)) + 1;
    after.actions.push({ ...next, id: revisionId, sequence, action: next.time ? "amend" : "progress", invalidates_event: false, created_at: createdAt, updated_at: createdAt });
    planCorrections.push(revisionId);
  }
  const retainedPostIds = new Set(command.sources.add.map(source => source.postId));
  for (const post of after.posts) if (retainedPostIds.has(post.id)) post.filtered_out = false;
  const orderChanges = [];
  for (const item of command.orders) {
    findEvent(item.eventId);
    const actionIds = item.actionIds.map(id => id.startsWith("actionKey:") ? actionKeys.get(id.slice(10)) ?? "" : id);
    actionIds.push(...planCorrections.filter(id => findAction(id).event_id === item.eventId && !actionIds.includes(id)));
    unique(actionIds, "排序动作");
    const rows = after.actions.filter(action => action.event_id === item.eventId);
    if (actionIds.length !== rows.length || rows.some(action => !actionIds.includes(action.id))) throw invalid("排序必须包含该事件全部有效动作");
    const before = [...rows].sort((a, b) => a.sequence - b.sequence).map(action => action.id);
    actionIds.forEach((id, index) => { findAction(id).sequence = index + 1; });
    orderChanges.push({ eventId: item.eventId, before, after: actionIds });
  }
  for (const eventId of eventKeys.values()) {
    const rows = after.actions.filter(action => action.event_id === eventId).sort((a, b) => a.sequence - b.sequence);
    if (!rows.length || !["announce", "confirm"].includes(rows[0]!.action)) throw invalid("新事件必须从有效预告或确认动作创建");
  }
  const snapshot = (eventId: string, input: ActionInput) => {
    const event = input.events.find(event => event.id === eventId); if (!event) return null;
    const reduced = reduceEvent(event, input);
    return { type: event.type, title: event.title, summary: event.summary, scope: event.scope, status: reduced?.status ?? null, time: reduced?.time ?? null,
      actions: input.actions.filter(action => action.event_id === eventId).sort((a, b) => a.sequence - b.sequence).map(action => ({ ...action })) };
  };
  const changes = [...affected].sort().map(eventId => ({ eventId, before: snapshot(eventId, state), after: snapshot(eventId, after) }));
  const allActionIds = [...new Set([...state.actions, ...after.actions].filter(action => affected.has(action.event_id)).map(action => action.id))];
  const actionChanges = allActionIds.flatMap(actionId => {
    const before = state.actions.find(action => action.id === actionId) ?? null, next = after.actions.find(action => action.id === actionId) ?? null;
    if (rowVersion(before) === rowVersion(next)) return [];
    return [{ actionId, eventId: (next ?? before)!.event_id, before, after: next }];
  });
  const sourceChanges = actionChanges.filter(change => rowVersion(change.before?.sources ?? []) !== rowVersion(change.after?.sources ?? [])).map(change => ({ actionId: change.actionId, eventId: change.eventId, before: change.before?.sources.map(source => source.postId) ?? [], after: change.after?.sources.map(source => source.postId) ?? [] }));
  const post = origin.kind === "post" ? after.posts.find(post => post.id === origin.id)! : null;
  const originalPost = origin.kind === "post" ? state.posts.find(post => post.id === origin.id)! : null;
  const createdEventIds = new Set(eventKeys.values());
  const completesPost = Boolean(command.completeProcessing || post && after.actions.some(action => createdEventIds.has(action.event_id)
    && ["announce", "confirm"].includes(action.action) && action.sources.some(source => source.postId === post.id)));
  if (post && command.post) Object.assign(post, command.post);
  if (post && completesPost) Object.assign(post, { processing_status: "processed", review_reason: null });
  if (post && command.keepPost) post.filtered_out = false;
  const postChange = post ? { before: { title: originalPost!.title, summary: originalPost!.summary, filteredOut: originalPost!.filtered_out, processingStatus: originalPost!.processing_status, reviewReason: originalPost!.review_reason }, after: { title: post.title, summary: post.summary, filteredOut: post.filtered_out, processingStatus: post.processing_status, reviewReason: post.review_reason } } : null;
  // Only selected records contribute to the token; unrelated option changes never invalidate an edit.
  const fingerprint = rowVersion(subset(state, related));
  const previewToken = rowVersion({ origin, command: { ...command, previewToken: undefined, versions: undefined }, fingerprint, changes, postChange, sourceChanges, orderChanges, lastSourceRemovals });
  return { command, related, affected: [...affected].sort(), after, changes, actionChanges, sourceChanges, orderChanges, lastSourceRemovals, postChange, completesPost, previewToken };
}
async function preview(origin: Origin, value: unknown) {
  return sql.begin("isolation level repeatable read read only", async db => {
    const planned = prepare(await loadActionInput(db), origin, value);
    if (!planned) return null;
    const { previewToken, changes, actionChanges, sourceChanges, orderChanges, lastSourceRemovals, postChange } = planned;
    return { previewToken, changes, actionChanges, sourceChanges, orderChanges, lastSourceRemovals, postChange };
  });
}
async function submit(origin: Origin, value: unknown, actor: string) {
  return sql.begin(async db => {
    const initial = prepare(await loadActionInput(db), origin, value); if (!initial) return null;
    await lockActionRecords(db, initial.related.events, initial.related.actions, initial.related.posts);
    const state = await loadActionInput(db), planned = prepare(state, origin, value);
    if (!planned || planned.command.previewToken !== planned.previewToken) throw new Conflict("请先预览当前改动");
    for (const eventId of planned.affected) {
      const next = planned.after.events.find(event => event.id === eventId)!;
      const before = state.events.find(event => event.id === eventId);
      if (!before) await db`INSERT INTO monitor_event_records(monitor_id,id,type,title,summary,scope,withdrawn,created_at) VALUES(${monitorId()},${next.id},${next.type},${next.title ? db.json(next.title) : null},${next.summary ? db.json(next.summary) : null},${next.scope ? db.json(next.scope) : null},${next.withdrawn},${next.created_at})`;
      else if (rowVersion(before) !== rowVersion(next)) {
        await db`UPDATE monitor_event_records SET scope=${next.scope ? db.json(next.scope) : null},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${eventId}`;
      }
    }
    const reordered = new Set([...planned.command.orders.map(order => order.eventId), ...planned.actionChanges.filter(change => !change.before && change.after).map(change => change.eventId)]);
    for (const eventId of reordered) {
      const maximum = Math.max(0, ...state.actions.filter(action => action.event_id === eventId).map(action => action.sequence), ...planned.after.actions.filter(action => action.event_id === eventId).map(action => action.sequence));
      await db`UPDATE monitor_event_actions SET sequence=sequence+${maximum + 1} WHERE monitor_id=${monitorId()} AND event_id=${eventId}`;
    }
    for (const change of planned.actionChanges) {
      const next = change.after;
      if (!next) await db`DELETE FROM monitor_event_actions WHERE monitor_id=${monitorId()} AND id=${change.actionId}`;
      else if (!change.before) await db`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,invalidates_event,title,summary,time,sources) VALUES(${monitorId()},${next.id},${next.event_id},${next.sequence},${next.action},${next.invalidates_event},${db.json(next.title)},${next.summary ? db.json(next.summary) : null},${next.time},${db.json(next.sources)})`;
      else await db`UPDATE monitor_event_actions SET sequence=${next.sequence},action=${next.action},invalidates_event=${next.invalidates_event},title=${db.json(next.title)},summary=${next.summary ? db.json(next.summary) : null},time=${next.time},sources=${db.json(next.sources)},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${next.id}`;
    }
    for (const action of planned.after.actions.filter(action => reordered.has(action.event_id))) await db`UPDATE monitor_event_actions SET sequence=${action.sequence} WHERE monitor_id=${monitorId()} AND id=${action.id}`;
    await validateActionSources(db, planned.after.actions.filter(action => planned.affected.includes(action.event_id)));
    for (const post of planned.after.posts) if (state.posts.find(before => before.id === post.id)?.filtered_out !== post.filtered_out) {
      await db`UPDATE monitor_source_posts SET filtered_out=${post.filtered_out},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${post.id}`;
    }
    if (origin.kind === "post" && (planned.command.post || planned.completesPost)) {
      const post = planned.after.posts.find(post => post.id === origin.id)!;
      await db`UPDATE monitor_source_posts SET title=${post.title ? db.json(post.title) : null},summary=${post.summary ? db.json(post.summary) : null},processing_status=${post.processing_status},review_reason=${post.review_reason},updated_at=clock_timestamp() WHERE monitor_id=${monitorId()} AND id=${origin.id}`;
    }
    await audit(actor, auditAction("review"), auditSubject(origin.kind, origin.id), planned.command.reason,
      { post: origin.kind === "post" ? auditPost(state.posts.find(post => post.id === origin.id)) : null, events: planned.changes.map(change => ({ id: change.eventId, before: change.before })), actions: planned.actionChanges.map(change => ({ id: change.actionId, before: change.before })) },
      { post: origin.kind === "post" ? auditPost(planned.after.posts.find(post => post.id === origin.id)) : null, events: planned.changes.map(change => ({ id: change.eventId, after: change.after })), actions: planned.actionChanges.map(change => ({ id: change.actionId, after: change.after })), lastSourceRemovals: planned.lastSourceRemovals }, { db });
    await enqueuePublicV2(db, planned.affected);
    return { saved: true };
  });
}
export const previewMonitorReview = (id: string, value: unknown) => preview({ kind: "post", id }, value);
export const submitMonitorReview = (id: string, value: unknown, actor: string) => submit({ kind: "post", id }, value, actor);
export const previewMonitorEventReview = (id: string, value: unknown) => preview({ kind: "event", id }, value);
export const submitMonitorEventReview = (id: string, value: unknown, actor: string) => submit({ kind: "event", id }, value, actor);
