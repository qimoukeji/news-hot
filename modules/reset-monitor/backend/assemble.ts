import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { sql, type Db } from "@aihot/backend/db";
import { stableJson } from "@aihot/backend/lib/ids";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { monitor, isAuthor } from "./context.ts";
import { sourcePost, loadActionInput, saveAcceptedPost, markPostReview, StalePostWork, lockActionRecords, rowVersion, type ActionDraft, type EventWrite } from "./action-store.ts";
import { actionEvidence, quotedInPost, confirmsCompletedAction } from "./evidence.ts";
export { quotedInPost } from "./evidence.ts";
import { recognizedScope, scopeSummary } from "./recognition-scope.ts";
import { relatedContextEvents, uniqueContextEvent } from "./context-association.ts";
import { reduceEvent, type ActionKind, type ActionInput, type SourcePostRow } from "../actions.ts";
import { serializeEventTime } from "../public-v2.ts";
import { resolveEventExpression } from "./public-v2-time.ts";
import { actionRecognitionSchema, type ActionRecognition, type ActionRecognitionBody, type Proposition, type ThreadRecognition } from "./recognize.ts";
import { postContext, needsReplyContext } from "./post-context.ts";

export interface Applied {
  eventIds: string[];
  notify: Array<{ eventId: string; action: ActionKind; postId: string }>;
}

function policyProposition(claim: ActionRecognition["actions"][number]): Proposition {
  return {
    kind: claim.kind, kindExplicit: claim.kindExplicit, action: claim.action,
    real: claim.real, role: claim.role, eventId: claim.eventId, excerpt: claim.excerpt,
    timeExcerpt: claim.timeExcerpt, scope: claim.rawScope,
  };
}

function explicitLifecycle(claim: ActionRecognition["actions"][number]) {
  if (!claim.invalidatesEvent) return true;
  if (claim.invalidatesEvent && claim.action !== "amend") return false;
  const text = claim.excerpt;
  if (/\?|\b(?:if|unless|will|soon|tomorrow|might|maybe|not|never|my|your)\b|如果|尚未|还未|我的|你的/i.test(text)) return false;
  return /\b(?:cancelled|canceled|withdrawn|scrapped|no (?:reset|credits?)|won['’]t (?:reset|grant|issue))\b|取消|撤回|不再发放|不再發放/i.test(text);
}

/** All accepted state changes enter through an action with this post as evidence. */
export async function applyRecognition(postId: string, recognition: ActionRecognition, expectedVersion: string): Promise<Applied> {
  return applyRecognitionBody(postId, recognition, expectedVersion, recognition.receiptId);
}

/** Browser evidence has no paid receipt. Its claims still pass every production fact check. */
export async function applyOfflineRecognition(postId: string, body: unknown, expectedVersion: string): Promise<Applied> {
  return applyRecognitionBody(postId, actionRecognitionSchema.parse(body), expectedVersion, null);
}

/** One model response is committed with all of its target posts and exact input revisions. */
export async function applyRecognitionGroup(targets: SourcePostRow[], context: SourcePostRow[], baseline: ActionInput, recognition: ThreadRecognition,
  options: { db?: Db; preserveReceipt?: boolean } = {}): Promise<Applied> {
  const targetIds = new Set(targets.map(post => post.id));
  if (recognition.posts.length !== targetIds.size || new Set(recognition.posts.map(post => post.postId)).size !== targetIds.size
    || recognition.posts.some(post => !targetIds.has(post.postId))) throw Object.assign(new Error("识别组目标不完整"), { statusCode: 400 });
  for (const post of recognition.posts) for (const claim of post.actions) {
    if (claim.eventId && !baseline.events.some(event => event.id === claim.eventId)
      || claim.existingActionId && !baseline.actions.some(action => action.id === claim.existingActionId)) {
      throw Object.assign(new Error("识别结果引用了输入之外的事件或动作"), { statusCode: 400 });
    }
  }
  const save = async (tx: Db) => {
    const relatedIds = new Set(baseline.events.map(event => event.id));
    await lockActionRecords(tx, relatedIds, baseline.actions.map(action => action.id), [...targets, ...context].map(post => post.id));
    const current = await loadActionInput(tx);
    for (const post of [...targets, ...context]) {
      const saved = current.posts.find(row => row.id === post.id);
      if (!saved || rowVersion(saved) !== rowVersion(post)) throw new StalePostWork("识别组来源已变化，忽略过期结果");
    }
    for (const event of baseline.events) {
      if (rowVersion(current.events.find(row => row.id === event.id)) !== rowVersion(event)) throw new StalePostWork("识别组事件已变化");
      if (rowVersion(current.actions.filter(row => row.event_id === event.id)) !== rowVersion(baseline.actions.filter(row => row.event_id === event.id))) throw new StalePostWork("识别组动作已变化");
    }
    const events = new Set<string>(), localEvents = new Map<string, string>();
    for (const post of targets) {
      const result = recognition.posts.find(result => result.postId === post.id)!;
      const affected = await applyRecognitionBody(post.id, result, rowVersion(post), recognition.receiptId, tx, localEvents, result.reviewReason, !options.preserveReceipt);
      for (const id of affected.eventIds) events.add(id);
    }
    if (!options.preserveReceipt) await completeReceipt(tx, recognition.receiptId);
    return { eventIds: [...events], notify: [] };
  };
  return options.db ? save(options.db) : sql.begin(save);
}

async function applyRecognitionBody(postId: string, recognition: ActionRecognitionBody, expectedVersion: string, receiptId: number | null, db: Db = sql, sharedEvents?: Map<string, string>, reviewDetail?: string | null, completePaidReceipt = true): Promise<Applied> {
  const transaction = <T>(run: (tx: Db) => Promise<T>): Promise<T> => db === sql ? sql.begin(run) as Promise<T> : run(db);
  const finish = (db: Db) => receiptId === null || !completePaidReceipt ? Promise.resolve() : completeReceipt(db, receiptId);
  const empty: Applied = { eventIds: [], notify: [] };
  const post = await sourcePost(postId, db);
  const version = expectedVersion;
  if (!post || post.context_only || post.processing_status !== "pending" || post.version !== version) {
    if (db !== sql) throw new StalePostWork("识别组帖子已变化");
    await transaction(finish);
    return empty;
  }
  if (!post.text?.trim()) {
    await transaction(async db => {
      await markPostReview(post.id, "资料不完整：缺少原帖正文", version, receiptId ?? undefined, db, recognition);
      await finish(db);
    });
    return empty;
  }
  const text = post.text;
  const input = await loadActionInput(db);
  const context = postContext(post, input.posts);
  const drafts: ActionDraft[] = [], localEvents = new Map<string, string>(sharedEvents), acceptedClaims: Proposition[] = [], events = new Map<string, EventWrite>();
  const reasons: string[] = needsReplyContext(post, context) ? ["回复缺少可核验的父帖或引用上下文"] : [];
  const blockedPost = reasons.length > 0 || !recognition.relevant && recognition.actions.length > 0;
  if (recognition.needsReview && reviewDetail) reasons.push(reviewDetail);
  for (const original of recognition.actions) {
    const claim = structuredClone(original);
    if (claim.localEventKey && localEvents.has(claim.localEventKey) && input.events.some(event => event.id === localEvents.get(claim.localEventKey!))) {
      claim.eventId = localEvents.get(claim.localEventKey)!; claim.localEventKey = null;
    }
    const followup = claim.action !== "announce" || !/\b(?:resets?|banked|quota|credits?|usage|limits?)\b|重置|额度|額度/i.test(claim.excerpt);
    const related = followup ? relatedContextEvents(post, input, claim.kind) : [];
    const contextual = followup ? uniqueContextEvent(post, input, claim.kind) : null;
    if (related.length > 1) { reasons.push("上下文存在多个可能事件，需人工确定目标"); continue; }
    if (!claim.eventId && related.length && (!contextual || related.length !== 1)) {
      reasons.push("上下文关联不唯一或事件已取消、撤回"); continue;
    }
    if (claim.eventId && related.length && !related.some(event => event.id === claim.eventId)) {
      reasons.push("识别目标与原帖上下文关联冲突"); continue;
    }
    if (!claim.eventId && contextual) {
      claim.eventId = contextual.id;
      claim.localEventKey = null;
    }
    const proposition = policyProposition(claim);
    const target = claim.eventId ? input.events.find(event => event.id === claim.eventId) : undefined;
    if (target && followup && recognition.needsReview && contextual?.id !== target.id) { reasons.push("待复核的已有事件关联缺少唯一原帖关系"); continue; }
    if (target && ["announce", "confirm"].includes(claim.action) && !/\b(?:reset(?:s|ting)?|banked|quota|credits?|usage|limits?)\b|重置|额度|額度/i.test(claim.excerpt) && contextual?.id !== target.id) {
      reasons.push("泛指动作与目标事件缺少唯一可核验的上下文关联"); continue;
    }
    const exclusion = !monitor().eventKinds.includes(claim.kind) ? "此监控未启用该类型" : monitor().excludeProposition?.(proposition, text,
      { trustedEventKinds: target ? [target.type] : [] });
    if (exclusion) continue;
    const evidence = actionEvidence(proposition, context, acceptedClaims);
    if (!claim.real || evidence === "related") continue;
    if (evidence !== "action" || !quotedInPost(claim.excerpt, text)) {
      reasons.push("动作缺少本帖明确依据"); continue;
    }
    if (!explicitLifecycle(claim)) { reasons.push("活动结果缺少明确整体状态依据"); continue; }
    if (claim.action === "confirm" && !confirmsCompletedAction(claim.excerpt)) {
      reasons.push("预期或否定不能确认完成"); continue;
    }
    const samePostEvent = claim.localEventKey && localEvents.has(claim.localEventKey);
    if (samePostEvent && events.get(localEvents.get(claim.localEventKey!)!)?.type !== claim.kind) {
      reasons.push("同帖分组包含不同事件类型"); continue;
    }
    if (claim.action === "confirm" && !target && !samePostEvent && claim.kind !== "bonus_credit" && !/\b(?:resets?|restored?|banked)\b|重置|恢复额度|恢復額度/i.test(claim.excerpt)) {
      reasons.push("独立确认缺少明确额度动作对象"); continue;
    }
    if (claim.scopeExcerpt && !quotedInPost(claim.scopeExcerpt, text)) { reasons.push("范围不在本帖中"); continue; }
    const scopeLiteral = [claim.rawScope.audienceSource, claim.rawScope.productsZh, ...(claim.rawScope.plans ?? [])].filter(Boolean);
    if (scopeLiteral.length && !claim.scopeExcerpt) { reasons.push("明确范围缺少来源引文"); continue; }
    const inherited = (target ? events.get(target.id)?.scope ?? target.scope : null) ?? (claim.localEventKey ? events.get(localEvents.get(claim.localEventKey) ?? "")?.scope : null);
    const resolvedScope = recognizedScope(claim, text, post.author, inherited);
    if (resolvedScope.issue) { reasons.push(resolvedScope.issue); continue; }
    claim.scope = resolvedScope.scope;
    if (claim.scope.type === "unknown" || claim.scope.productCodes.length === 0 || /\bhourly\b/i.test(claim.scopeExcerpt ?? claim.excerpt)) claim.summary = scopeSummary(claim);
    if (claim.eventId && (!target || target.withdrawn || target.type !== claim.kind || reduceEvent(target, input)?.status === "cancelled")) { reasons.push("事件关联不存在、已取消或类型冲突"); continue; }
    if (post.reply_to && target && !/\b(?:reset(?:s|ting)?|banked|quota|credits?|usage|limits?)\b|重置|额度|額度/i.test(claim.excerpt)) {
      const linked = new Set(input.actions.filter(action => action.event_id === target.id).flatMap(action => action.sources.map(source => source.postId)));
      if (!context.some(source => linked.has(source.id))) { reasons.push("泛指回复与目标事件缺少可核验的上下文关联"); continue; }
    }
    if (target && monitor().requireCrossAuthorEvidence) {
      const linked = new Set(input.actions.filter(action => action.event_id === target.id).flatMap(action => action.sources.map(source => source.postId)));
      const sources = input.posts.filter(source => linked.has(source.id));
      const explicit = contextual?.id === target.id && sources.some(source => isAuthor(source.author) && context.some(ancestor => ancestor.id === source.id)) || sources.some(source => source.author.toLowerCase() === post.author.toLowerCase()
        || context.some(quote => quote.id === source.id && isAuthor(quote.author) && quote.author.toLowerCase() === source.author.toLowerCase()
          && quote.publishedAt && Date.parse(quote.publishedAt) === new Date(source.published_at).getTime())
        || (text.match(/https?:\/\/[^\s<>"']+/g) ?? []).some(value => {
          try {
            const linked = new URL(value.replace(/[),.;!?]+$/, "")), saved = new URL(source.url);
            return linked.hostname === saved.hostname && linked.pathname.replace(/\/$/, "") === saved.pathname.replace(/\/$/, "");
          } catch { return false; }
        }));
      if (!explicit) { reasons.push("跨作者关联缺少原帖依据"); continue; }
    }
    let eventId = claim.eventId;
    if (!eventId) {
      if (!claim.localEventKey) { reasons.push("新事件缺少分组标识"); continue; }
      eventId = localEvents.get(claim.localEventKey) ?? null;
      if (!eventId) {
        if (!["announce", "confirm"].includes(claim.action)) { reasons.push("新事件必须从预告或确认开始"); continue; }
        eventId = randomUUID();
      }
    } else if (claim.localEventKey) { reasons.push("已有事件不能指定本地分组"); continue; }
    if (claim.existingActionId) {
      const prior = input.actions.find(action => action.id === claim.existingActionId);
      if (!prior || prior.event_id !== eventId || prior.action !== claim.action || prior.invalidates_event !== claim.invalidatesEvent) { reasons.push("重复事实没有匹配的已有动作"); continue; }
    }
    let time: string | null = null;
    if (claim.timeExcerpt) {
      if (!quotedInPost(claim.timeExcerpt, text)) { reasons.push("时间引文不在本帖中"); continue; }
      const occurred = claim.invalidatesEvent || claim.action === "progress" || claim.action === "confirm";
      const resolved = resolveEventExpression(claim.timeExcerpt,
        { id: post.id, author: post.author, text, published_at: post.published_at } as Parameters<typeof resolveEventExpression>[1],
        claim.action === "announce" || claim.action === "amend" && !claim.invalidatesEvent, text, target && occurred ? new Date(target.created_at).toISOString() : undefined, occurred);
      const vague = /^(?:(?:in|within|over)\s+(?:(?:a|the)\s+)?few\s+(?:minutes?|hours?)|soon|shortly|稍后|稍後|几分钟(?:内|后)?|幾分鐘(?:內|後)?)\s*[.!。！]?$/i.test(claim.timeExcerpt.trim());
      if (resolved.kind === "unknown" && !vague) { reasons.push("明确时间无法安全解析"); continue; }
      if (occurred && resolved.kind !== "unknown") {
        const future = resolved.kind === "date"
          ? Temporal.PlainDate.compare(Temporal.PlainDate.from(resolved.date), Temporal.Instant.from(new Date(post.published_at).toISOString()).toZonedDateTimeISO(resolved.timeZone).toPlainDate()) > 0
          : Date.parse(resolved.kind === "range" ? resolved.through : resolved.at) > new Date(post.published_at).getTime();
        if (future) { reasons.push("活动结果时间尚未发生"); continue; }
      }
      if (resolved.kind !== "unknown") time = serializeEventTime(resolved);
    }
    const prior = claim.existingActionId ? input.actions.find(action => action.id === claim.existingActionId)! : null;
    // A repeated fact only adds a source; a new scope requires an explicit new fact or review.
    if (prior && claim.scopeExcerpt && stableJson(claim.scope) !== stableJson(target!.scope)) {
      reasons.push("重复事实不能修改事件影响范围"); continue;
    }
    if (!prior) {
      if (!target && !events.has(eventId)) events.set(eventId, { id: eventId, type: claim.kind, title: claim.title, summary: claim.summary, scope: claim.scope });
      else if (claim.scopeExcerpt) events.set(eventId, { ...(events.get(eventId) ?? { id: eventId }), scope: claim.scope });
    }
    if (claim.localEventKey) localEvents.set(claim.localEventKey, eventId);
    drafts.push(prior ? { id: prior.id, eventId, action: prior.action, title: prior.title,
      summary: prior.summary, time: prior.time, invalidatesEvent: prior.invalidates_event }
      : { eventId, action: claim.action, title: claim.title, summary: claim.summary, time, invalidatesEvent: claim.invalidatesEvent });
    acceptedClaims.push(proposition);
  }
  if (blockedPost || !drafts.length && (recognition.needsReview || reasons.length)) {
    await transaction(async db => {
      await markPostReview(postId, [...new Set(reasons)].join("；") || "事件关联或事实需要复核", version, receiptId ?? undefined, db, recognition);
      await finish(db);
    });
    return empty;
  }
  let eventIds: string[];
  const reviewReason = recognition.needsReview || reasons.length ? [...new Set(reasons)].join("；") || "部分事件关联或事实仍需复核" : null;
  try {
    eventIds = await transaction(async db => {
      const affected = await saveAcceptedPost(postId, { title: recognition.title, summary: recognition.summary, actions: drafts, events: [...events.values()], receiptId, expectedVersion: version,
        filteredOut: monitor().collection.resetOnly && recognition.relevant === false, reviewReason }, db);
      await finish(db);
      return affected;
    });
  } catch (error) {
    if (db !== sql || !(error instanceof StalePostWork)) throw error;
    await transaction(finish);
    return empty;
  }
  for (const [key, id] of localEvents) if (eventIds.includes(id)) sharedEvents?.set(key, id);
  return { eventIds, notify: [] };
}
