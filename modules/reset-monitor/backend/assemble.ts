import { randomUUID } from "node:crypto";
import { sql, type Db } from "@aihot/backend/db";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { monitor, isAuthor } from "./context.ts";
import { sourcePost, loadActionInput, saveAcceptedPost, markPostReview, markPostFailure, StalePostWork, lockActionRecords, rowVersion, type ActionDraft, type EventWrite } from "./action-store.ts";
import { actionEvidence, quotedInPost, bankedRoundCounts } from "./evidence.ts";
export { quotedInPost } from "./evidence.ts";
import { recognizedScope } from "./recognition-scope.ts";
import { relatedContextEvents, uniqueContextEvent, uniqueRoundContextEvent } from "./context-association.ts";
import { reduceEvent, type ActionKind, type ActionInput, type SourcePostRow } from "../actions.ts";
import { hasExplicitAnnouncementClock, resolveActionTime } from "./public-v2-time.ts";
import { actionRecognitionSchema, type ActionRecognition, type ActionRecognitionBody, type Proposition, type ThreadRecognition } from "./recognize.ts";
import { postContext, needsReplyContext } from "./post-context.ts";

export interface Applied {
  eventIds: string[];
  notify: Array<{ eventId: string; action: ActionKind; postId: string }>;
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

/** Browser-sourced claims use the same action rules without a paid receipt. */
export async function applyOfflineRecognition(postId: string, body: unknown, expectedVersion: string): Promise<Applied> {
  return applyRecognitionBody(postId, actionRecognitionSchema.parse(body), expectedVersion, null);
}

/** One model response is committed with all of its target posts and exact input revisions. */
export async function applyRecognitionGroup(targets: SourcePostRow[], context: SourcePostRow[], baseline: ActionInput, recognition: ThreadRecognition,
  options: { db?: Db; preserveReceipt?: boolean } = {}): Promise<Applied> {
  const targetIds = new Set(targets.map(post => post.id));
  const returned = [...recognition.posts.map(post => post.postId), ...(recognition.failedPostIds ?? [])];
  if (returned.length !== targetIds.size || new Set(returned).size !== targetIds.size || returned.some(id => !targetIds.has(id)))
    throw Object.assign(new Error("识别组目标不完整"), { statusCode: 400 });
  if (options.preserveReceipt) for (const post of recognition.posts) for (const claim of post.actions) {
    if (claim.eventId && !baseline.events.some(event => event.id === claim.eventId)
      || claim.existingActionId && !baseline.actions.some(action => action.id === claim.existingActionId)
        && !targets.slice(0, targets.findIndex(target => target.id === post.postId)).some(target => claim.existingActionId === `source:${target.id}`)) {
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
    const events = new Set<string>(), localEvents = new Map<string, string>(), earlierTargets = new Set<string>();
    for (const post of targets) {
      const result = recognition.posts.find(result => result.postId === post.id);
      if (!result) {
        await markPostFailure(post.id, rowVersion(post), recognition.receiptId, tx, "模型响应缺少此帖或无法辨认其动作");
        continue;
      }
      const affected = await applyRecognitionBody(post.id, result, rowVersion(post), recognition.receiptId, tx, localEvents, result.reviewReason,
        !options.preserveReceipt, options.preserveReceipt ? undefined : baseline, earlierTargets);
      earlierTargets.add(post.id);
      for (const id of affected.eventIds) events.add(id);
    }
    if (!options.preserveReceipt) await completeReceipt(tx, recognition.receiptId);
    return { eventIds: [...events], notify: [] };
  };
  return options.db ? save(options.db) : sql.begin(save);
}

async function applyRecognitionBody(postId: string, recognition: ActionRecognitionBody, expectedVersion: string, receiptId: number | null, db: Db = sql, sharedEvents?: Map<string, string>, reviewDetail?: string | null, completePaidReceipt = true, paidBaseline?: ActionInput, earlierTargets?: ReadonlySet<string>): Promise<Applied> {
  const transaction = <T>(run: (tx: Db) => Promise<T>): Promise<T> => db === sql ? sql.begin(run) as Promise<T> : run(db);
  const finish = (db: Db) => receiptId === null || !completePaidReceipt ? Promise.resolve() : completeReceipt(db, receiptId);
  const empty: Applied = { eventIds: [], notify: [] };
  const source = await sourcePost(postId, db);
  const version = expectedVersion;
  if (!source || source.context_only || source.processing_status !== "pending" || source.version !== version) {
    if (db !== sql) throw new StalePostWork("识别组帖子已变化");
    await transaction(finish);
    return empty;
  }
  const post = source;
  if (!post.text?.trim() && !paidBaseline) {
    await transaction(async db => {
      await markPostReview(post.id, "资料不完整：缺少原帖正文", version, receiptId ?? undefined, db, recognition);
      await finish(db);
    });
    return empty;
  }
  const text = post.text ?? "";
  const input = await loadActionInput(db);
  const context = postContext(post, input.posts);
  const drafts: ActionDraft[] = [], localEvents = new Map<string, string>(sharedEvents), acceptedClaims: Proposition[] = [], events = new Map<string, EventWrite>();
  const missingReplyContext = needsReplyContext(post, context);
  const reasons: string[] = missingReplyContext ? ["回复缺少可核验的父帖或引用上下文"] : [];
  const blockedPost = !recognition.relevant && recognition.actions.length > 0;
  const standaloneFollowups = new Set<string>();
  const refineAnnouncementIds = new Set<string>();
  const processingNow = Date.now();
  if (paidBaseline && !recognition.relevant && recognition.actions.some(action => action.real)) reasons.push("模型相关性与识别动作不一致");
  if (recognition.needsReview && reviewDetail) reasons.push(reviewDetail);
  function planClaim(original: ActionRecognitionBody["actions"][number]) {
    const claim = structuredClone(original);
    const confirmation = claim.action === "confirm";
    if (confirmation && !claim.real) return;
    const rejectLink = (reason: string) => { reasons.push(reason); return false; };
    const earlierSource = claim.existingActionId?.startsWith("source:") && earlierTargets?.has(claim.existingActionId.slice(7))
      ? claim.existingActionId.slice(7) : null;
    if (paidBaseline && (claim.eventId && !paidBaseline.events.some(event => event.id === claim.eventId)
      || claim.existingActionId && !earlierSource && !paidBaseline.actions.some(action => action.id === claim.existingActionId))) {
      return rejectLink("识别结果引用了输入之外的事件或动作");
    }
    if (!confirmation && paidBaseline && claim.kind === "direct_reset" && quotedInPost(claim.excerpt, text)
      && (/\b(?:banked resets?|reset (?:credits?|cards?))\b|重置卡/i.test(claim.excerpt)
        || /\b(?:resets?\b.{0,100}\b(?:redeem|use (?:them|these) anytime)|redeem\b.{0,40}\bresets?)\b/i.test(claim.excerpt))) {
      reasons.push("模型识别为额度重置，但原帖描述可兑换的重置次数"); return;
    }
    const round = bankedRoundCounts(claim.excerpt);
    if (!claim.eventId && claim.action === "announce" && round
      && (recognition.needsReview || round.completed <= 0 || round.completed >= round.total
        || !acceptedClaims.some(prior => prior.action === "confirm" && prior.kind === claim.kind && prior.eventId))) {
      reasons.push("下一轮预告缺少已核验的前轮确认或剩余轮次依据"); return;
    }
    if (claim.localEventKey && localEvents.has(claim.localEventKey) && input.events.some(event => event.id === localEvents.get(claim.localEventKey!))) {
      claim.eventId = localEvents.get(claim.localEventKey)!; claim.localEventKey = null;
    }
    const followup = claim.action !== "announce" || !/\b(?:resets?|banked|quota|credits?|usage|limits?)\b|重置|额度|額度/i.test(claim.excerpt);
    const linkedEvents = confirmation ? relatedContextEvents(post, input) : null;
    const related = linkedEvents ? linkedEvents.filter(event => event.type === claim.kind)
      : followup ? relatedContextEvents(post, input, claim.kind) : [];
    if (linkedEvents?.length && !related.length) return rejectLink("识别目标与原帖上下文关联冲突");
    const roundTarget = related.length > 1 && claim.action === "confirm" && claim.eventId && !recognition.needsReview
      ? uniqueRoundContextEvent(post, input, claim.kind) : null;
    const contextual = followup ? uniqueContextEvent(post, input, claim.kind) ?? roundTarget : null;
    if (related.length > 1 && roundTarget?.id !== claim.eventId) return rejectLink("上下文存在多个可能事件，需人工确定目标");
    if (!claim.eventId && related.length && (!contextual || related.length !== 1)) {
      return rejectLink("上下文关联不唯一或事件已取消、撤回");
    }
    if (claim.eventId && related.length && !related.some(event => event.id === claim.eventId)) {
      return rejectLink("识别目标与原帖上下文关联冲突");
    }
    if (!claim.eventId && contextual) {
      claim.eventId = contextual.id;
      claim.localEventKey = null;
    }
    const target = claim.eventId ? input.events.find(event => event.id === claim.eventId) : undefined;
    if (target && followup && recognition.needsReview && contextual?.id !== target.id) return rejectLink("待复核的已有事件关联缺少唯一原帖关系");
    if (target && claim.action === "announce" && !/\b(?:reset(?:s|ting)?|banked|quota|credits?|usage|limits?)\b|重置|额度|額度/i.test(claim.excerpt) && contextual?.id !== target.id) {
      reasons.push("泛指动作与目标事件缺少唯一可核验的上下文关联"); return;
    }
    if (!monitor().eventKinds.includes(claim.kind)) {
      if (paidBaseline && claim.real) reasons.push("此监控未启用该类型");
      return;
    }
    if (!confirmation) {
      const exclusion = monitor().excludeProposition?.(claim, text, { trustedEventKinds: target ? [target.type] : [] });
      if (exclusion) { if (paidBaseline && claim.real) reasons.push(exclusion); return; }
      const evidence = actionEvidence(claim, context, acceptedClaims);
      if (!claim.real || evidence === "related") return;
      if (evidence !== "action" || !quotedInPost(claim.excerpt, text)) {
        reasons.push("动作缺少本帖明确依据"); return;
      }
      if (!explicitLifecycle(claim)) { reasons.push("活动结果缺少明确整体状态依据"); return; }
    }
    const samePostEvent = claim.localEventKey && localEvents.has(claim.localEventKey);
    if (samePostEvent && events.get(localEvents.get(claim.localEventKey!)!)?.type !== claim.kind) {
      return rejectLink("同帖分组包含不同事件类型");
    }
    if (claim.eventId && (!target || target.withdrawn || target.type !== claim.kind || reduceEvent(target, input)?.status === "cancelled")) {
      return rejectLink("事件关联不存在、已取消或类型冲突");
    }
    if (!confirmation && post.reply_to && target && !/\b(?:reset(?:s|ting)?|banked|quota|credits?|usage|limits?)\b|重置|额度|額度/i.test(claim.excerpt)) {
      const linked = new Set(input.actions.filter(action => action.event_id === target.id).flatMap(action => action.sources.map(source => source.postId)));
      if (!context.some(source => linked.has(source.id))) { reasons.push("泛指回复与目标事件缺少可核验的上下文关联"); return; }
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
      if (!explicit) return rejectLink("跨作者关联缺少原帖依据");
    }
    let eventId = claim.eventId;
    if (!eventId) {
      if (!claim.localEventKey) return rejectLink("新事件缺少分组标识");
      eventId = localEvents.get(claim.localEventKey) ?? null;
      if (!eventId) {
        if (!["announce", "confirm"].includes(claim.action)) { reasons.push("新事件必须从预告或确认开始"); return; }
        eventId = randomUUID();
      }
    } else if (claim.localEventKey) return rejectLink("已有事件不能指定本地分组");
    if (earlierSource) {
      const candidates = input.actions.filter(action => action.event_id === eventId && action.action === "announce"
        && action.sources.some(source => source.postId === earlierSource));
      if (claim.action !== "announce" || candidates.length !== 1) {
        return rejectLink("同组补充时间未关联唯一预告动作");
      }
      claim.existingActionId = candidates[0]!.id;
    }
    if (claim.existingActionId) {
      const prior = input.actions.find(action => action.id === claim.existingActionId);
      if (!prior || prior.event_id !== eventId || prior.action !== claim.action || prior.invalidates_event !== claim.invalidatesEvent) {
        return rejectLink("重复事实没有匹配的已有动作");
      }
    }
    const resolvedTime = resolveActionTime(claim, { text, published_at: post.published_at }, target ? new Date(target.created_at).toISOString() : undefined, processingNow);
    if (resolvedTime.issue) reasons.push(resolvedTime.issue);
    const time = resolvedTime.time;
    const prior = claim.existingActionId ? input.actions.find(action => action.id === claim.existingActionId)! : null;
    // A repeated fact only adds a source; changing an accepted audience requires a sourced amendment.
    const initial = !target && !events.has(eventId);
    const updatesScope = claim.action === "amend" && !claim.invalidatesEvent && claim.scopeExcerpt !== null && claim.scope.type !== "unknown";
    if (!prior && (initial || updatesScope)) {
      const { scope, issue } = recognizedScope(claim, text);
      if (issue) { reasons.push(issue); return; }
      if (initial) events.set(eventId, { id: eventId, type: claim.kind, title: claim.title, summary: claim.summary, scope });
      else events.set(eventId, { ...(events.get(eventId) ?? { id: eventId }), scope });
    }
    if (claim.localEventKey) localEvents.set(claim.localEventKey, eventId);
    const refineTime = prior?.action === "announce" && claim.action === "announce" && claim.timeExcerpt !== null
      && !resolvedTime.issue && hasExplicitAnnouncementClock(claim.timeExcerpt) && JSON.stringify(prior.time) !== JSON.stringify(time);
    if (refineTime) refineAnnouncementIds.add(prior!.id);
    drafts.push(prior ? { id: prior.id, eventId, action: prior.action, title: prior.title,
      summary: prior.summary, time: refineTime ? time : prior.time, invalidatesEvent: prior.invalidates_event }
      : { eventId, action: claim.action, title: claim.title, summary: claim.summary, time, invalidatesEvent: claim.invalidatesEvent });
    acceptedClaims.push(claim);
  }
  for (const claim of recognition.actions) {
    const confirmation = claim.action === "confirm";
    if (confirmation && missingReplyContext) continue;
    const count = drafts.length, before = reasons.length;
    const linkRejected = (!paidBaseline || !blockedPost) && !missingReplyContext && planClaim(claim) === false;
    if (confirmation && linkRejected) continue;
    if (!paidBaseline || drafts.length !== count || !claim.real || !monitor().eventKinds.includes(claim.kind)) continue;

    // Preserve a model action without attaching an unverified update to an existing event.
    if (reasons.length === before) reasons.push("模型识别动作的事实或关联需要复核");
    const key = claim.localEventKey && JSON.stringify(["review", claim.kind, claim.localEventKey]);
    const proposed = claim.localEventKey ? localEvents.get(claim.localEventKey) : undefined;
    const sameNewGroup = proposed && events.get(proposed)?.type === claim.kind ? proposed : undefined;
    const eventId = sameNewGroup ?? (key ? localEvents.get(key) : undefined) ?? randomUUID();
    const initial = !events.has(eventId) && !input.events.some(event => event.id === eventId);
    const { time, issue } = resolveActionTime(claim, { text, published_at: post.published_at }, undefined, processingNow);
    if (issue) reasons.push(issue);
    if (initial) {
      const scope = recognizedScope(claim, text);
      if (scope.issue) reasons.push(scope.issue);
      events.set(eventId, { id: eventId, type: claim.kind, title: claim.title, summary: claim.summary, scope: scope.scope });
      if (claim.action === "progress" || claim.action === "amend") standaloneFollowups.add(eventId);
    }
    if (key) localEvents.set(key, eventId);
    if (claim.localEventKey && !proposed) localEvents.set(claim.localEventKey, eventId);
    drafts.push({ eventId, action: claim.action, title: claim.title, summary: claim.summary,
      time, invalidatesEvent: claim.invalidatesEvent });
  }
  if ((!paidBaseline && blockedPost) || (!drafts.length && (recognition.needsReview || reasons.length))) {
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
        filteredOut: monitor().collection.resetOnly && recognition.relevant === false, reviewReason, standaloneFollowups, refineAnnouncementIds }, db);
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
