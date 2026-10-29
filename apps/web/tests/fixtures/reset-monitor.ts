import { createServer } from "node:http";
import { eventListSchema, overviewSchema, type EventList, type EventStatus, type Overview, type PlatformOverview } from "../../../../modules/reset-monitor/public-v2.ts";
import type { AdminEvent, AdminPost, AdminEntries, AdminTimelineEvent, ReviewAction, AdminReviewDetail, ReviewCommands, ProcessingStatus } from "../../../../modules/reset-monitor/web/admin-types.ts";

export const day = "2026-10-23";
export const at = "2026-10-22T16:30:00.000Z";
const localized = (value: string) => ({ en: value, zh: value, "zh-Hant": value, ja: value, ko: value, ru: value, es: value });
export const platforms = [
  { platform: "codex", product: "Codex", path: "/codex-reset", admin: "/admin/codex-reset", api: "/api/admin/codex-reset", list: "/api/v2/codex-resets" },
  { platform: "claude-code", product: "Claude", path: "/claude-reset", admin: "/admin/claude-reset", api: "/api/admin/claude-reset", list: "/api/v2/claude-resets" },
  { platform: "grok", product: "Grok", path: "/grok-reset", admin: "/admin/grok-reset", api: "/api/admin/grok-reset", list: "/api/v2/grok-resets" },
] as const;
export type Product = typeof platforms[number];
export const scope = { type: "paid_users", productCodes: ["product"], planCodes: ["pro"], quotaWindowCodes: ["weekly"], note: null } as const;

export function createMonitorFixture() {
  const requests: string[] = [];
  const writes: Array<{ path: string; body: Record<string, any>; csrf?: string }> = [];
  const createdPosts: Array<{ platform: Product["platform"]; post: AdminPost }> = [];
  const postEditorial = new Map<string, Pick<AdminPost, "title" | "summary" | "version">>();
  const editedPost = (product: Product, post: AdminPost): AdminPost => ({ ...post, ...postEditorial.get(`${product.platform}:${post.id}`) });
  const associationActions = new Map<Product["platform"], ReviewAction[]>();
  const createdEvents: Array<{ platform: Product["platform"]; event: AdminTimelineEvent; actions: Array<ReviewAction & { publishedAt: string }> }> = [];
  const state: {
    type: "direct_reset" | "bonus_credit"; status: EventStatus; noActions: boolean; previewConflict: boolean;
    processingStatus: ProcessingStatus; reviewReason: string | null; withdrawn: boolean; filteredOut: boolean;
    replyTo: AdminPost["replyTo"]; publicEventCount: number;
    emptyConfirmation: boolean; emptyConfirmationTitle: string;
    eventScope?: EventList["list"][number]["scope"];
    actionTimes?: [string | null, string | null];
    typicalInterval: PlatformOverview["statistics"]["typicalInterval"]; predictedResetTime: string | null; resetTime?: string | null;
  } = { type: "direct_reset", status: "completed", noActions: false, emptyConfirmation: false, emptyConfirmationTitle: "已到预告时间", previewConflict: false, processingStatus: "needs_attention", reviewReason: "来源关系需要管理员核对", withdrawn: false, filteredOut: false, replyTo: null, publicEventCount: 1,
    typicalInterval: { value: 3.0625, unit: "day", sampleCount: 5 }, predictedResetTime: "2026-10-28" };
  const event = (product: Product): EventList["list"][number] => ({
    id: "event-1", type: state.type, status: state.status, publishedAt: at, title: localized(`${product.product} 官方活动`),
    summary: localized("仅限 Pro 套餐，每周额度。"), time: at, scope: state.eventScope ?? { ...scope, productCodes: [...scope.productCodes], planCodes: [...scope.planCodes], quotaWindowCodes: [...scope.quotaWindowCodes], note: localized("仅限 Pro 用户") },
    updates: [
      { id: "announce-action", action: "announce", invalidatesEvent: false, title: localized("额度活动预告"), summary: null, time: state.actionTimes?.[0] ?? null, publishedAt: at, sources: [{ postId: "post-1", sourceId: "official", url: "https://example.org/official-1" }] },
      { id: "confirm-action", title: localized(state.emptyConfirmation ? state.emptyConfirmationTitle : "额度活动状态确认"), summary: localized("以官方公告明确的活动结果为准。"), time: state.actionTimes?.[1] ?? null, publishedAt: at,
        ...(state.status === "cancelled" ? { action: "amend" as const, invalidatesEvent: true, sources: [{ postId: "post-1", sourceId: "official", url: "https://example.org/official-1" }, { postId: "post-2", sourceId: "other", url: "https://example.org/official-2" }] }
          : { action: "confirm" as const, invalidatesEvent: false as const, sources: state.emptyConfirmation ? [] : [{ postId: "post-1", sourceId: "official", url: "https://example.org/official-1" }, { postId: "post-2", sourceId: "other", url: "https://example.org/official-2" }] }) },
    ],
  });
  const overview = (product: Product): PlatformOverview => ({ platform: product.platform,
    sources: ["official", "other"].map((id, index) => ({ id, type: "official_social", name: localized(`官方账号 ${index + 1}`), url: `https://example.org/account-${index}` })),
    catalog: { products: [{ code: "product", name: localized(product.product) }], plans: [{ code: "pro", name: localized("Pro") }], quotaWindows: [{ code: "weekly", name: localized("周额度") }] },
    statistics: { typicalInterval: state.typicalInterval, resetsLast30Days: state.type !== "bonus_credit" && state.status !== "cancelled" ? 1 : 0, cardsLast30Days: 0, bonusesLast30Days: state.type === "bonus_credit" && state.status !== "cancelled" ? 1 : 0 },
    predictedResetTime: state.predictedResetTime, announcedResetTime: state.status === "announced" ? at : null, resetTime: state.resetTime !== undefined ? state.resetTime : state.status === "cancelled" ? null : state.status === "announced" ? "2026-10-20T16:30:00Z" : at,
  });
  const adminEvent = (product: Product): AdminEvent => ({ ...event(product), withdrawn: state.withdrawn, version: "event-version", actionCount: state.noActions ? 0 : 2, sourcePostCount: state.noActions ? 0 : 2, ...(state.noActions ? { status: null, time: null, updates: [], title: null, scope: null } : {}) });
  const post = (): AdminPost => ({ id: "post-1", author: "official", publishedAt: at, title: localized("官方帖子摘要"), summary: localized("这条帖子同时包含活动预告及确认事实。"), url: "https://example.org/official-1", text: "Original outer post: quota reset announced and confirmed.", quotedPost: { text: "Quoted context is separate evidence.", author: "other", url: "https://example.org/quoted" }, replyTo: state.replyTo, filteredOut: state.filteredOut, processingStatus: state.processingStatus, reviewReason: state.reviewReason, version: "post-version", actionCount: state.noActions ? 0 : 2 });
  const posts = (): AdminPost[] => [post(), { ...post(), id: "post-2", author: "other", title: localized("另一条官方报道"), url: "https://example.org/official-2", text: "Second official report.", quotedPost: null, version: "other-post-version" }];
  const sourcePosts = (product: Product) => [...posts().map(post => editedPost(product, post)), ...createdPosts.filter(row => row.platform === product.platform).map(row => editedPost(product, row.post))];
  const actions = (): ReviewAction[] => state.noActions ? [] : [
    { id: "announce-action", eventId: "event-1", sequence: 1, action: "announce", invalidatesEvent: false, title: localized("额度活动预告"), summary: null, time: null, sources: [{ postId: "post-1" }], version: "announce-version" },
    { id: "confirm-action", eventId: "event-1", sequence: 2, action: "confirm", invalidatesEvent: false, title: localized(state.emptyConfirmation ? state.emptyConfirmationTitle : "额度活动状态确认"), summary: null, time: state.emptyConfirmation ? at : null, sources: state.emptyConfirmation ? [] : [{ postId: "post-1" }, { postId: "post-2" }], version: "confirm-version" },
  ];
  const detail = (product: Product, eventMode = false): AdminReviewDetail => {
    const unsourcedConfirmationId = state.emptyConfirmation ? (associationActions.get(product.platform) ?? actions()).find(action => action.eventId === "event-1" && action.action === "confirm" && !action.sources.length)?.id : undefined;
    const e = { id: "event-1", type: state.type, title: event(product).title, summary: event(product).summary, scope: event(product).scope, version: "event-version", status: state.noActions ? null : state.status, time: state.noActions ? null : at, withdrawn: state.withdrawn, ...(unsourcedConfirmationId ? { unsourcedConfirmationId } : {}) };
    const otherEvent = { ...e, id: "event-2", title: localized("另一期额度活动"), version: "other-event-version", unsourcedConfirmationId: undefined };
    const otherAction: ReviewAction = { id: "other-action", eventId: "event-2", sequence: 1, action: "announce", invalidatesEvent: false, title: localized("另一期活动预告"), summary: null, time: null, sources: [{ postId: "post-2" }], version: "other-action-version" };
    const allActions = associationActions.get(product.platform) ?? [...actions(), otherAction];
    const allEvents = [e, otherEvent, ...createdEvents.filter(row => row.platform === product.platform).map(row => row.event)];
    const detailedEvent: AdminTimelineEvent = { ...adminEvent(product), ...e, latestAt: at, timeline: state.noActions ? [] : event(product).updates.map((update, index) => ({ ...update, sequence: index + 1, sources: update.sources.map(source => sourcePosts(product).find(post => post.id === source.postId)!) })).reverse() };
    return { version: eventMode ? "event-review-version" : "review-version", versions: { events: Object.fromEntries(allEvents.map(event => [event.id, event.version])), actions: Object.fromEntries(allActions.map(action => [action.id, action.version])), posts: Object.fromEntries(sourcePosts(product).map(post => [post.id, post.version])) }, ...(eventMode ? { event: detailedEvent } : { post: post() }), actions: allActions.filter(action => eventMode ? action.eventId === "event-1" : action.sources.some(source => source.postId === "post-1")), options: { events: allEvents, actions: allActions, posts: sourcePosts(product) } };
  };
  const orphanPost = (): AdminPost => ({ ...post(), id: "post-3", title: localized("待核对的独立帖子"), actionCount: 0, events: [] });
  const withAssociations = (product: Product, post: AdminPost): AdminPost => {
    const overrides = associationActions.get(product.platform);
    if (!overrides) return post;
    const own = overrides.filter(action => action.sources.some(source => source.postId === post.id));
    const events = detail(product).options.events.filter(event => own.some(action => action.eventId === event.id)).map(event => ({ id: event.id, title: event.title, type: event.type }));
    return { ...post, events, actionCount: own.length };
  };
  const createdDetail = (product: Product, record: typeof createdEvents[number]): AdminReviewDetail => {
    const base = detail(product, true), event = record.event;
    return { ...base, version: `review-${event.version}`, event, actions: record.actions,
      versions: { ...base.versions, events: { ...base.versions.events, [event.id]: event.version }, actions: { ...base.versions.actions, ...Object.fromEntries(record.actions.map(action => [action.id, action.version])) } },
      options: { ...base.options, events: [...base.options.events, event], actions: [...base.options.actions, ...record.actions] } };
  };
  const refreshCreated = (record: typeof createdEvents[number]) => {
    const actions = record.actions, event = record.event;
    const last = actions.at(-1);
    event.status = last ? last.action === "confirm" ? "completed" : last.action === "announce" ? "announced" : last.invalidatesEvent ? "cancelled" : "in_progress" : null;
    event.time = last?.time ?? (last ? last.publishedAt : null);
    event.actionCount = actions.length;
    event.sourcePostCount = new Set(actions.flatMap(action => action.sources.map(source => source.postId))).size;
    event.timeline = actions.map(action => ({ ...action, sources: action.sources.map(source => [...sourcePosts(platforms.find(product => product.platform === record.platform)!), orphanPost()].find(post => post.id === source.postId)!) })).reverse();
    event.updates = event.timeline.map(action => ({ id: action.id, action: action.action, invalidatesEvent: action.invalidatesEvent, publishedAt: action.publishedAt, time: action.time,
      title: localized(action.title.zh ?? "Action"), summary: action.summary ? localized(action.summary.zh ?? "Summary") : null,
      sources: action.sources.map(source => ({ postId: source.id, sourceId: "official", url: source.url })) })) as AdminEvent["updates"];
    event.version = `${event.id}-version-${writes.length}`;
  };
  const api = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture"), path = url.pathname;
    requests.push(req.url!); res.setHeader("Content-Type", "application/json");
    const send = (value: unknown) => res.end(JSON.stringify(value));
    if (path === "/api/admin/me") return send({ name: "Fixture admin", csrf: "fixture-csrf", dev: true });
    if (["/api/admin/nav-counts", "/api/site/meta", "/api/health"].includes(path)) return send({});
    if (path === "/api/site/track") { res.statusCode = 204; return res.end(); }
    if (path === "/api/v2/overview") return send(overviewSchema.parse({ schemaVersion: 2, generatedAt: at, platforms: platforms.map(overview) } satisfies Overview));
    const product = platforms.find(product => path === product.list || path.startsWith(`${product.api}/`));
    if (!product) { res.statusCode = 404; return send({ code: "not_found" }); }
    if (path === product.list) {
      const month = url.searchParams.get("from")?.slice(0, 7) ?? "2026-10";
      const list = Array.from({ length: state.publicEventCount }, (_, index) => ({ ...event(product), id: state.publicEventCount === 1 ? "event-1" : `event-${String(index + 1).padStart(3, "0")}`,
        title: localized(`${product.product} 官方活动${state.publicEventCount === 1 ? "" : ` ${index + 1}`}`),
        time: `${month}-${index < 16 ? "22" : "21"}T16:30:00.000Z` }));
      for (const record of createdEvents.filter(record => record.platform === product.platform && record.event.status)) {
        list.push({ ...event(product), id: record.event.id, type: record.event.type, publishedAt: record.event.publishedAt, updates: record.event.updates, title: localized(record.event.title?.zh ?? "Manual event"), summary: record.event.summary ? localized(record.event.summary.zh ?? "Summary") : null,
          scope: { ...(record.event.scope ?? event(product).scope), note: record.event.scope?.note ? localized(record.event.scope.note.zh ?? "Scope") : null }, status: record.event.status!, time: record.event.time! });
      }
      list.sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.id.localeCompare(b.id));
      return send(eventListSchema.parse({ list, pagination: { limit: null, total: list.length, hasMore: false, nextCursor: null } } satisfies EventList));
    }
    if (req.method === "POST" || req.method === "PATCH") {
      let input = ""; for await (const chunk of req) input += chunk;
      const body = JSON.parse(input); writes.push({ path, body, csrf: req.headers["x-csrf-token"] as string });
      if (path === `${product.api}/posts` && req.method === "POST") {
        if (!body.title?.zh?.trim()) { res.statusCode = 400; return send({ detail: "请填写帖子标题" }); }
        const id = "manual-post-" + (createdPosts.length + 1);
        const manual: AdminPost = { id, author: body.author, publishedAt: body.publishedAt, url: body.url, title: body.title, summary: body.summary ?? null, text: body.text ?? null,
          quotedPost: null, replyTo: null, filteredOut: false, processingStatus: "processed", reviewReason: null, version: id + "-version-1", events: [], actionCount: 0 };
        createdPosts.push({ platform: product.platform, post: manual }); res.statusCode = 201; return send(manual);
      }
      const postId = path.startsWith(`${product.api}/posts/`) ? decodeURIComponent(path.slice((product.api + "/posts/").length)) : null;
      if (postId && !postId.includes("/") && req.method === "PATCH") {
        const original = createdPosts.find(row => row.platform === product.platform && row.post.id === postId)?.post ?? (postId === "post-3" ? { ...post(), id: "post-3", title: localized("待核对的独立帖子"), actionCount: 0, events: [] } : posts().find(post => post.id === postId));
        if (!original) { res.statusCode = 404; return send({ detail: "帖子不存在" }); }
        const current = editedPost(product, original);
        if (state.previewConflict || body.version !== current.version) { res.statusCode = 409; return send({ detail: "帖子版本已变化" }); }
        const changed = { title: body.patch.title ?? current.title, summary: "summary" in body.patch ? body.patch.summary : current.summary, version: postId + "-version-" + writes.length };
        postEditorial.set(`${product.platform}:${postId}`, changed); return send({ ...current, ...changed });
      }
      if (path === `${product.api}/events` && req.method === "POST") {
        if (!body.title?.zh?.trim()) { res.statusCode = 400; return send({ detail: "请填写事件标题" }); }
        const createdAt = new Date().toISOString(), id = `manual-event-${createdEvents.length + 1}`;
        const manual: AdminTimelineEvent = { ...adminEvent(product), id, type: body.type, title: body.title, summary: body.summary, scope: body.scope,
          status: null, time: null, updates: [], actionCount: 0, sourcePostCount: 0, timeline: [], latestAt: createdAt, publishedAt: createdAt,
          version: `${id}-version-1`, withdrawn: false };
        createdEvents.push({ platform: product.platform, event: manual, actions: [] }); res.statusCode = 201;
        return send({ ...manual, createdAt });
      }
      if (/\/posts\/[^/]+\/review(?:\/preview)?$/.test(path) && !body.reason) {
        if (state.previewConflict) { res.statusCode = 409; return send({ detail: "事件版本已变化，请重新预览" }); }
        const command = { events: { create: [], update: [] }, actions: { create: [], update: [] }, sources: { add: [], remove: [] }, orders: [], ...body } as ReviewCommands, baseline = detail(product), beforeActions = baseline.options.actions;
        const originPostId = decodeURIComponent(path.match(/\/posts\/([^/]+)\/review/)![1]!);
        const completesPost = command.events.create.some(event => command.actions.create.some(action => action.eventKey === event.localKey
          && ["announce", "confirm"].includes(action.action) && command.sources.add.some(source => source.actionKey === action.localKey && source.postId === originPostId)));
        const postChange = { before: { processingStatus: state.processingStatus, reviewReason: state.reviewReason, filteredOut: state.filteredOut },
          after: { processingStatus: completesPost ? "processed" : state.processingStatus, reviewReason: completesPost ? null : state.reviewReason, filteredOut: state.filteredOut } };
        const nextActions = structuredClone(beforeActions), eventKeys = new Map(command.events.create.map((event, index) => [event.localKey, `association-event-${createdEvents.length + index + 1}`]));
        const actionKeys = new Map(command.actions.create.map((action, index) => [action.localKey, `association-action-${writes.length}-${index}`]));
        for (const draft of command.actions.create) {
          const eventId = draft.eventId ?? eventKeys.get(draft.eventKey!)!;
          nextActions.push({ ...draft, id: actionKeys.get(draft.localKey)!, eventId, sequence: Math.max(0, ...nextActions.filter(action => action.eventId === eventId).map(action => action.sequence)) + 1, sources: [], version: `association-action-version-${writes.length}` });
        }
        for (const patch of command.actions.update) Object.assign(nextActions.find(action => action.id === patch.id)!, patch);
        for (const remove of command.sources.remove) { const action = nextActions.find(action => action.id === remove.actionId)!; action.sources = action.sources.filter(source => source.postId !== remove.postId); }
        for (const add of command.sources.add) {
          const action = nextActions.find(action => action.id === (add.actionId ?? actionKeys.get(add.actionKey!)))!;
          if (!action.sources.some(source => source.postId === add.postId)) action.sources.push({ postId: add.postId });
        }
        const deleted = nextActions.filter(action => !action.sources.length && beforeActions.some(before => before.id === action.id && before.sources.length));
        const afterActions = nextActions.filter(action => !deleted.includes(action));
        const ids = new Set([...command.actions.create.map(action => action.eventId ?? eventKeys.get(action.eventKey!)!), ...command.actions.update.map(patch => beforeActions.find(action => action.id === patch.id)!.eventId), ...command.sources.add.map(source => nextActions.find(action => action.id === (source.actionId ?? actionKeys.get(source.actionKey!)))!.eventId), ...command.sources.remove.map(source => beforeActions.find(action => action.id === source.actionId)!.eventId)]);
        if (path.endsWith("/preview")) return send({ previewToken: "association-preview", postChange, changes: [...ids].map(eventId => ({ eventId, before: baseline.options.events.some(event => event.id === eventId) ? { status: state.status, time: at } : null, after: { status: "completed", time: at } })),
          actionChanges: [...command.actions.create.map(action => ({ actionId: actionKeys.get(action.localKey), eventId: action.eventId ?? eventKeys.get(action.eventKey!), before: null, after: action })), ...command.actions.update.map(action => ({ actionId: action.id, eventId: beforeActions.find(row => row.id === action.id)!.eventId, before: beforeActions.find(row => row.id === action.id), after: action })), ...deleted.map(action => ({ actionId: action.id, eventId: action.eventId, before: beforeActions.find(row => row.id === action.id), after: null }))],
          sourceChanges: nextActions.filter(action => JSON.stringify(action.sources) !== JSON.stringify(beforeActions.find(before => before.id === action.id)?.sources ?? [])).map(action => ({ actionId: action.id, eventId: action.eventId, before: beforeActions.find(before => before.id === action.id)?.sources.map(source => source.postId) ?? [], after: deleted.includes(action) ? [] : action.sources.map(source => source.postId) })),
          orderChanges: [], lastSourceRemovals: deleted.map(action => ({ actionId: action.id, eventId: action.eventId, message: "最后一条来源移除后删除动作，请核对事件当前影响范围" })) });
        for (const draft of command.events.create) {
          const id = eventKeys.get(draft.localKey)!, related = afterActions.filter(action => action.eventId === id);
          const manual: AdminTimelineEvent = { ...adminEvent(product), id, type: draft.type, title: draft.title ?? null, summary: draft.summary ?? null, scope: draft.scope ?? null, version: `${id}-version`, status: null, time: null, timeline: [], updates: [], latestAt: at, publishedAt: at, actionCount: 0, sourcePostCount: 0, withdrawn: false };
          const record = { platform: product.platform, event: manual, actions: related.map(action => ({ ...action, publishedAt: at })) }; createdEvents.push(record); refreshCreated(record);
        }
        associationActions.set(product.platform, afterActions);
        if (completesPost) { state.processingStatus = "processed"; state.reviewReason = null; }
        return send({ saved: true });
      }
      const record = createdEvents.find(record => record.platform === product.platform && (path === `${product.api}/events/${record.event.id}` || path.startsWith(`${product.api}/events/${record.event.id}/`)));
      if (record) {
        const event = record.event;
        if (req.method === "PATCH") { Object.assign(event, body.patch); event.version = `${event.id}-version-${writes.length}`; return send(event); }
        if (path.endsWith("/preview") && !path.includes("/review/")) return send({ eventId: event.id, version: event.version, previewToken: "event-preview-token", before: event, after: { ...event, ...body.patch } });
        const command = { events: { create: [], update: [] }, actions: { create: [], update: [] }, sources: { add: [], remove: [] }, orders: [], ...body } as ReviewCommands;
        if (path.endsWith("/preview")) return send({ previewToken: `preview-${event.version}`, changes: [{ eventId: event.id, before: { status: event.status, time: event.time }, after: { status: command.actions.create.at(-1)?.action === "confirm" ? "completed" : "announced", time: command.actions.create.at(-1)?.time ?? event.time } }],
          actionChanges: command.actions.create.map(action => ({ actionId: action.localKey, eventId: event.id, before: null, after: action })), sourceChanges: [], orderChanges: [], lastSourceRemovals: [] });
        if (path.endsWith("/review")) {
          for (const action of command.actions.create) record.actions.push({ ...action, id: `${event.id}-action-${record.actions.length + 1}`, eventId: event.id, sequence: record.actions.length + 1, version: `action-version-${writes.length}`, publishedAt: new Date().toISOString(), sources: command.sources.add.filter(source => source.actionKey === action.localKey).map(source => ({ postId: source.postId })) });
          for (const patch of command.actions.update) Object.assign(record.actions.find(action => action.id === patch.id)!, patch);
          refreshCreated(record); return send({ saved: true });
        }
      }
      if (path.includes("/events/") && path.endsWith("/preview") && !path.includes("/review/")) return send({ eventId: "event-1", version: "event-version", previewToken: "event-preview-token", before: adminEvent(product), after: { ...adminEvent(product), ...body.patch } });
      if (path.endsWith("/preview")) {
        const command = { events: { create: [], update: [] }, actions: { create: [], update: [] }, sources: { add: [], remove: [] }, orders: [], ...body } as ReviewCommands;
        return send({ previewToken: "preview-token", changes: [{ eventId: "event-1", before: { status: state.status, time: at }, after: { status: "completed", time: at } }],
          ...(path.includes("/posts/") ? { postChange: { before: { processingStatus: state.processingStatus, reviewReason: state.reviewReason, filteredOut: state.filteredOut }, after: { processingStatus: body.completeProcessing ? "processed" : state.processingStatus, reviewReason: body.completeProcessing ? null : state.reviewReason, filteredOut: body.keepPost || command.sources.add.some(source => source.postId === "post-1") ? false : state.filteredOut } } } : {}),
          actionChanges: [...command.actions.create.map((action, index) => ({ actionId: `new-${index}`, eventId: action.eventId ?? "new-event", before: null, after: action })), ...command.actions.update.map(action => ({ actionId: action.id, eventId: "event-1", before: actions().find(row => row.id === action.id), after: action }))],
          sourceChanges: command.sources.add.map(source => ({ actionId: source.actionId ?? source.actionKey, eventId: "event-1", before: [], after: [source.postId] })),
          orderChanges: command.orders.map(order => ({ eventId: order.eventId, before: actions().map(action => action.id), after: order.actionIds })),
          lastSourceRemovals: actions().filter(action => action.sources.length && action.sources.every(source => command.sources.remove.some(remove => remove.actionId === action.id && remove.postId === source.postId))).map(action => ({ actionId: action.id, eventId: action.eventId, message: "移除最后一条来源后动作停止生效，请核对事件当前影响范围。" })),
        });
      }
      if (state.previewConflict && path.endsWith("/review")) { res.statusCode = 409; return send({ detail: "事件版本已变化，请重新预览" }); }
      if (path.endsWith("/review")) {
        const confirmation = body.actions?.create.find((action: ReviewCommands["actions"]["create"][number]) => action.action === "confirm" && !body.sources.add.some((source: ReviewCommands["sources"]["add"][number]) => source.actionKey === action.localKey));
        if (confirmation) { state.emptyConfirmation = true; state.emptyConfirmationTitle = confirmation.title.zh; state.status = "completed"; }
        if (body.sources?.add.some((source: ReviewCommands["sources"]["add"][number]) => source.actionId === "confirm-action")) state.emptyConfirmation = false;
      }
      if (body.keepPost && path.endsWith("/review")) state.filteredOut = false;
      if (body.completeProcessing && path.endsWith("/review")) { state.processingStatus = "processed"; state.reviewReason = null; }
      return send({ ok: true });
    }
    if (path === `${product.api}/entries`) {
      const q = url.searchParams.get("q")?.trim().toLowerCase(), type = url.searchParams.get("type"), status = url.searchParams.get("status"), visibility = url.searchParams.get("visibility"), filter = url.searchParams.get("filter"), kind = url.searchParams.get("kind"), collectionFilter = url.searchParams.get("collectionFilter") ?? "normal";
      const progressMatches = !filter || filter === "all" || filter === state.processingStatus;
      const eventMatches = progressMatches && kind !== "posts" && (!q || `${product.product} 官方活动 Pro 每周额度 official 来源关系需要管理员核对`.toLowerCase().includes(q)) && (!type || type === "all" || type === state.type) && (!status || status === "all" || status === state.status) && (!visibility || visibility === "all" || visibility === "withdrawn" && state.withdrawn || visibility === "public" && !state.withdrawn && !state.noActions || visibility === "unpublished" && state.noActions && !state.withdrawn);
      const orphan = { ...post(), id: "post-3", title: localized("待核对的独立帖子"), actionCount: 0, events: [] };
      const postMatches = progressMatches && kind !== "events" && (!type || type === "all") && (!status || status === "all") && (!visibility || visibility === "all") && (!q || `待核对的独立帖子 official 来源关系需要管理员核对`.toLowerCase().includes(q));
      const rows: AdminEntries["rows"] = [];
      if (kind !== "posts" && collectionFilter !== "filtered") for (const record of createdEvents.filter(record => record.platform === product.platform)) rows.push({ kind: "event", latestAt: record.event.latestAt, event: record.event });
      if (eventMatches && collectionFilter !== "filtered") rows.push({ kind: "event", latestAt: at, event: { ...adminEvent(product), latestAt: at, timeline: state.noActions ? [] : event(product).updates.map((update, index) => ({ ...update, sequence: index + 1, sources: update.sources.map(source => posts().find(post => post.id === source.postId)!) })).reverse() } });
      if (postMatches && (collectionFilter === "all" || orphan.filteredOut === (collectionFilter === "filtered"))) rows.push({ kind: "post", latestAt: at, post: orphan });
      const inRange = (value: string) => {
        const day = new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 10);
        return (!url.searchParams.get("from") || day >= url.searchParams.get("from")!) && (!url.searchParams.get("to") || day <= url.searchParams.get("to")!);
      };
      const matching = rows.filter(row => inRange(row.latestAt));
      const filtered = [...url.searchParams].some(([key, value]) => !["page", "kind"].includes(key) && !(key === "collectionFilter" && value === "normal") && value && value !== "all");
      return send({ page: Number(url.searchParams.get("page") ?? 1), total: filtered ? matching.length : 12 + createdEvents.filter(record => record.platform === product.platform).length, totalPages: filtered ? 1 : 2, pageSize: 10, rows: matching } satisfies AdminEntries);
    }
    if (path === `${product.api}/posts`) {
      const orphan = { ...post(), id: "post-3", title: localized("待核对的独立帖子"), actionCount: 0, events: [] };
      const linked = { ...post(), events: state.noActions ? [] : [{ id: "event-1", title: localized(`${product.product} 官方活动`), type: state.type }] };
      const rows = [...createdPosts.filter(row => row.platform === product.platform).map(row => row.post), linked, orphan].map(post => withAssociations(product, editedPost(product, post))).filter(post => {
        const day = new Date(Date.parse(post.publishedAt) + 8 * 3600_000).toISOString().slice(0, 10);
        const association = url.searchParams.get("association") ?? "all";
        return (association === "all" || (association === "linked" ? !!post.events?.length : !post.events?.length)) && ((url.searchParams.get("collectionFilter") ?? "normal") === "all" || (url.searchParams.get("collectionFilter") === "filtered" ? post.filteredOut && !post.actionCount : !post.filteredOut || !!post.actionCount)) && (!url.searchParams.get("from") || day >= url.searchParams.get("from")!) && (!url.searchParams.get("to") || day <= url.searchParams.get("to")!);
      });
      return send({ page: Number(url.searchParams.get("page") ?? 1), total: rows.length ? 12 : 0, totalPages: rows.length ? 2 : 0, pageSize: 10, rows });
    }
    if (path.startsWith(`${product.api}/posts/`)) {
      const postId = decodeURIComponent(path.slice((product.api + "/posts/").length));
      const original = createdPosts.find(row => row.platform === product.platform && row.post.id === postId)?.post ?? (postId === "post-3" ? { ...post(), id: "post-3", title: localized("待核对的独立帖子"), actionCount: 0, events: [] } : posts().find(post => post.id === postId));
      if (original) {
        const value = detail(product), current = withAssociations(product, editedPost(product, original));
        return send({ ...value, post: current, actions: value.options.actions.filter(action => action.sources.some(source => source.postId === postId)), options: { ...value.options, posts: value.options.posts.some(post => post.id === postId) ? value.options.posts : [...value.options.posts, current] }, versions: { ...value.versions, posts: { ...value.versions.posts, [postId]: current.version } } });
      }
    }
    if (path === `${product.api}/events/event-1/review`) return send(detail(product, true));
    const record = createdEvents.find(record => record.platform === product.platform && path === `${product.api}/events/${record.event.id}/review`);
    if (record) return send(createdDetail(product, record));
    res.statusCode = 404; send({ code: "not_found" });
  });
  return { api, requests, writes, state, createdEvents, createdPosts, postEditorial, associationActions };
}
