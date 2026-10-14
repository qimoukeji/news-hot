import { monitor as currentMonitor, monitorId, authorHandles, isAuthor, purpose as requestPurpose, auditAction, auditSubject } from "./context.ts";
// Turns a recognized post into monitor facts: events (announce → progress → confirm, amend,
// withdraw), the post's activity role and outage links. Code decides what
// a proposition may change; the model's wording never confirms anything on its own.
import { sql, type Tx } from "@aihot/backend/db";
import { randomUUID } from "node:crypto";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import type { ContextInput, Proposition, Recognition } from "./recognize.ts";
import { actionEvidence, timeSource, retrospective } from "./evidence.ts";
import { estimateFor, resolveStatedTime, scheduleFrom, type Schedule } from "./time.ts";
import { bonusCreditOf, bonusOpeningTime } from "./bonus-credit.ts";
import { eventLabel, eventDisplayLabel } from "../event-kind.ts";
import { trustedThreadEvents } from "./thread-events.ts";
import { authorTimePolicy, withAuthorTime } from "./context.ts";
import { resolve as resolveExplicitTime } from "./explicit-time.ts";
import { productsConflict, plansFromScopeLabel } from "./scope-policy.ts";
import { enqueuePublicV2 } from "./public-v2-work.ts";

const HOUR = 3600_000;
const OUTAGE_LINK_MS = 18 * HOUR;
/** "in about an hour", "in the next hour or so", "shortly" are approximate; "in the next few hours" is a deadline. */
const HEDGED = /\b(about|around|approximately|roughly|shortly|soon|or so)\b|~|-ish\b/i;
/** Words that keep potentially distinct claims within one post from being collapsed. */
const ANOTHER = /\b(another|again|second|one more|twice|2nd)\b/i;
/** An ordinal names a round; "Again, ..." can simply repeat its confirmation. */
function newRound(text: string): boolean {
  const product = currentMonitor().product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`\b(?:another|one more)\s+(?:(?:banked|manual|${product}|usage|full)\s+)*reset\b|\banother one\s+(?:will|is|has|have|lands?|came|coming)\b|\breset(?:ting)?(?:\s+(?:${product}|usage|rate|limits?|everyone['’]s)){0,5}\s+again\b`, "i").test(text);
}
/** the monitored author saying how many ("reset twice", "two resets", "3x"). Plural wording alone ("more resets coming") is one round. */
const STATED_COUNT = /\b(twice|thrice)\b|\b(two|three|four|five|[2-5])\s+(?:(?:banked|manual)\s+)?(?:times|resets?)\b|\b[2-5]\s*x\b/i;

const STAGE: Record<Proposition["kind"], Record<Proposition["action"], string>> = {
  direct_reset: { announce: "预告", progress: "进展", confirm: "确认完成", amend: "补充说明", withdraw: "撤回" },
  reset_credit: { announce: "发卡预告", progress: "进展", confirm: "确认发卡", amend: "补充说明", withdraw: "撤回" },
  bonus_credit: { announce: "奖励预告", progress: "发放进展", confirm: "活动可领取", amend: "活动更正", withdraw: "活动撤回" },
};

interface EventRow {
  id: string;
  type: Proposition["kind"];
  status: "announced" | "confirmed";
  schedule: Schedule | null;
  presentation: Record<string, unknown> | null;
  created_at: Date;
}

export interface Applied {
  eventIds: string[];
  /**
   * What the post tells the content groups: a new announcement or confirmation, and for an
   * announcement already out, a changed time or scope ("amend") or its withdrawal.
   */
  notify: Array<{ eventId: string; action: "announce" | "confirm" | "amend" | "withdraw"; postId: string }>;
}

/** The monitor policy resolves usable source words; unclear time stays null. */
function usableTime(p: Proposition, postAt: Date, context: ContextInput[], sourceText: string) {
  if (!p.statedTime) return null;
  if (p.kind === "bonus_credit" && !bonusOpeningTime(p)) return null;
  const hedged = p.statedTime.precision === "approximate" && p.statedTime.relativeHours && !HEDGED.test(p.excerpt);
  const source = context.find((c) => c.id === p.timeSourceId);
  const at = source?.publishedAt ? new Date(source.publishedAt) : postAt;
  if (p.kind === "bonus_credit") return resolveExplicitTime(p.statedTime, at, source?.text ?? sourceText);
  // The author adopts the source words; their timestamp remains the relative-time anchor.
  return resolveStatedTime(hedged ? { ...p.statedTime, precision: "deadline" } : p.statedTime, at, source?.text ?? sourceText, p.timeInferred);
}

/**
 * An announcement stays open to follow-ups until 12 hours after its stated time (36 hours after it
 * was made when no time was given). Explicitly named targets are checked without this time cutoff.
 */
function isOpen(e: EventRow, postAt: Date, grace: number): boolean {
  const base = e.schedule?.through ? Date.parse(e.schedule.through) : e.created_at.getTime() + 24 * HOUR;
  return postAt.getTime() <= base + grace;
}

function legacyScope(p: Proposition): string {
  if (p.scope.plans?.length) return p.scope.plans.join("、");
  if (p.scope.audienceSource && /paid/i.test(p.scope.audienceSource)) return "所有付费订阅";
  return "";
}

function presentationOf(p: Proposition, author: string, extra: Record<string, unknown> = {}) {
  const scopeLabel = p.scope.plans?.length ? p.scope.plans.join(", ") : p.scope.audienceSource;
  return {
    scopeKnown: !!scopeLabel,
    scopeLabel: scopeLabel ?? null,
    kindExplicit: p.kindExplicit,
    timeInferred: authorTimePolicy() === "explicit" || p.kind === "bonus_credit" ? false : p.timeInferred,
    timePolicy: p.kind === "bonus_credit" ? "explicit" : authorTimePolicy(),
    timeAuthor: author,
    audienceZh: p.scope.audienceZh,
    productsZh: p.scope.productsZh,
    ...(p.kind === "bonus_credit" ? { bonusCredit: p.bonusCredit ?? null } : {}),
    ...(currentMonitor().quotaScope ? { quotaScope: currentMonitor().quotaScope!(p.scope, p) } : {}),
    reportedAt: null,
    ...extra,
  };
}

function scopeConflicts(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const names = currentMonitor().plans.filter((p) => p.toLowerCase() !== "free").map((p) => p.toLowerCase());
  const words = (s: string): string[] => s.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
  const free = (s: string) => words(s).includes("free");
  const paid = (s: string) => words(s).some((word) => word === "paid" || names.includes(word));
  if (free(a) && paid(b) || paid(a) && free(b)) return true;
  const x = words(a).filter((word) => names.includes(word)), y = words(b).filter((word) => names.includes(word));
  return x.length > 0 && y.length > 0 && !x.some((value) => y.includes(value));
}

function propositionScope(p: Proposition): string | null {
  return p.scope.plans?.join(", ") ?? p.scope.audienceSource;
}

function quotaConflicts(a: unknown, p: Proposition): boolean {
  if (p.kind === "bonus_credit") return false;
  const next = currentMonitor().quotaScope?.(p.scope, p);
  return typeof a === "string" && !!next && a !== next;
}

function claimScopesConflict(a: Proposition, b: Proposition): boolean {
  return scopeConflicts(propositionScope(a), propositionScope(b)) || quotaConflicts(currentMonitor().quotaScope?.(a.scope, a), b)
    || !!currentMonitor().scopeConflicts?.(a.scope, b.scope);
}

function eventScope(e: EventRow): Proposition["scope"] {
  const label = e.presentation?.scopeLabel;
  return {
    audienceSource: typeof label === "string" ? label : null,
    plans: typeof label === "string" ? plansFromScopeLabel(label, currentMonitor().plans) : null, audienceZh: null,
    productsZh: typeof e.presentation?.productsZh === "string" ? e.presentation.productsZh : null,
  };
}
function eventScopeConflicts(e: EventRow, p: Proposition): boolean {
  return !!currentMonitor().scopeConflicts?.(eventScope(e), p.scope);
}
function eventProductConflicts(e: EventRow, p: Proposition): boolean {
  return productsConflict(eventScope(e), p.scope, currentMonitor().productAliases);
}

function mergeRepeatedScope(original: Proposition, repeated: Proposition) {
  original.scope = { ...original.scope,
    audienceSource: [...new Set([original.scope.audienceSource, repeated.scope.audienceSource].filter(Boolean))].join("; ") || null,
    audienceZh: [...new Set([original.scope.audienceZh, repeated.scope.audienceZh].filter(Boolean))].join("；") || null,
    productsZh: original.scope.productsZh ?? repeated.scope.productsZh };
}

/** Only fields stated in a follow-up are merged; missing fields cannot erase earlier evidence. */
async function enrichEvent(tx: Tx, id: string, p: Proposition, previous: Record<string, unknown> | null = null, supplement = false, defaultedProduct = false) {
  const patch: Record<string, unknown> = {};
  const scope = propositionScope(p);
  // Progress and completion describe delivery, not a revision of who was promised the reset.
  const keepKnownScope = (p.action === "progress" || p.action === "confirm") && !!previous?.scopeLabel;
  if (scope && !keepKnownScope) Object.assign(patch, { scopeKnown: true, scopeLabel: scope });
  if (p.scope.audienceZh && !keepKnownScope) patch.audienceZh = p.scope.audienceZh;
  if (p.scope.productsZh && (!defaultedProduct || !previous?.productsZh)) patch.productsZh = p.scope.productsZh;
  if (p.kind === "bonus_credit" && p.bonusCredit) {
    patch.bonusCredit = { amount: null, eligibility: null, claimMethod: null, usageTerms: null, claimDeadline: null, expiresAt: null,
      ...(previous?.bonusCredit as object ?? {}), ...Object.fromEntries(Object.entries(p.bonusCredit).filter(([, value]) => value !== null)) };
    if (supplement) {
      const merged = patch.bonusCredit as Record<string, unknown>;
      const old = previous?.bonusCredit as Record<string, unknown> | null;
      for (const key of ["usageTerms", "eligibility", "claimMethod"] as const) {
        const before = old?.[key], next = p.bonusCredit[key];
        if (typeof before === "string" && typeof next === "string" && !before.includes(next)) merged[key] = `${before}\n${next}`;
      }
    }
  }
  const quota = currentMonitor().quotaScope?.(p.scope, p);
  if (quota) patch.quotaScope = quota;
  if (p.kindExplicit) patch.kindExplicit = true;
  if (p.statedTime) patch.timeInferred = authorTimePolicy() === "explicit" || p.kind === "bonus_credit" ? false : p.timeInferred;
  if (!Object.keys(patch).length) return;
  await tx`UPDATE monitor_events SET presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json(patch as never)},
    type = CASE WHEN ${p.kindExplicit && previous?.kindExplicit === false} THEN ${p.kind} ELSE type END,
    label = CASE WHEN ${p.kindExplicit && previous?.kindExplicit === false} THEN ${eventLabel(p.kind)} ELSE label END,
    display_label = CASE WHEN ${p.kindExplicit} THEN ${eventDisplayLabel(p.kind)} ELSE display_label END,
    scope = CASE WHEN ${!keepKnownScope && !!legacyScope(p)} THEN ${legacyScope(p)} ELSE scope END WHERE monitor_id = ${monitorId()} AND (id = ${id}) `;
}

async function verifiedCrossAuthorTarget(tx: Tx, eventId: string, postAt: Date, postAuthor: string, context: ContextInput[], sourceText: string): Promise<boolean> {
  const sources = await tx<{ id: string; author: string; text: string; published_at: Date }[]>`
    SELECT p.id,p.author,p.text,p.published_at FROM monitor_event_posts l JOIN monitor_posts p ON p.monitor_id=l.monitor_id AND p.id=l.post_id
    WHERE l.monitor_id=${monitorId()} AND l.event_id=${eventId} AND p.published_at<=${postAt}`;
  return sources.some(source => source.author.toLowerCase() === postAuthor.toLowerCase()
    || context.some(c => c.id === source.id && isAuthor(c.author) && c.author.replace(/^@/, "").toLowerCase() === source.author.toLowerCase()
      && c.text === source.text && c.publishedAt && Date.parse(c.publishedAt) === source.published_at.getTime())
    || new RegExp(`https?://(?:www\\.)?(?:x|twitter)\\.com/(?:[A-Za-z0-9_]+|i)/status/${source.id}(?:[?/#\\s]|$)`, "i").test(sourceText));
}

async function findTarget(tx: Tx, p: Proposition, postAt: Date, postAuthor: string, context: ContextInput[], sourceText: string): Promise<{ target: EventRow | null; needsReview: boolean }> {
  if (p.relatesTo) {
    const [e] = await tx<EventRow[]>`SELECT id, type, status, schedule, presentation, created_at FROM (SELECT * FROM monitor_events WHERE monitor_id = ${monitorId()}) AS monitor_events WHERE id = ${p.relatesTo} AND NOT withdrawn`;
    // "The second reset has landed" can complete its explicitly named announcement.
    // A new announcement or a further reset after completion is independent of the named old round.
    if (e && p.count === 1 && newRound(p.excerpt) && (p.action === "announce" || p.action === "confirm" && e.status === "confirmed")) return { target: null, needsReview: false };
    const kindCompatible = e && (e.type === p.kind || e.type !== "bonus_credit" && p.kind !== "bonus_credit" && (!p.kindExplicit || e.presentation?.kindExplicit === false));
    if (e && kindCompatible && e.created_at <= postAt && !eventProductConflicts(e, p) && (p.action === "amend"
      || !eventScopeConflicts(e, p) && !scopeConflicts(e.presentation?.scopeLabel as string | null, propositionScope(p)) && !quotaConflicts(e.presentation?.quotaScope, p))) {
      if (currentMonitor().requireCrossAuthorEvidence && !await verifiedCrossAuthorTarget(tx, e.id, postAt, postAuthor, context, sourceText)) return { target: null, needsReview: true };
      return { target: e, needsReview: false };
    }
    return { target: null, needsReview: true };
  }
  if (p.action === "announce") return { target: null, needsReview: false };
  // Reward reminders cannot be assigned to a recent campaign by timing alone.
  if (p.kind === "bonus_credit") return { target: null, needsReview: p.action !== "confirm" };
  // A sole compatible open announcement can be linked; several candidates require explicit evidence.
  const rows = await tx<EventRow[]>`
    SELECT id, type, status, schedule, presentation, created_at FROM (SELECT * FROM monitor_events WHERE monitor_id = ${monitorId()}) AS monitor_events
    WHERE (type = ${p.kind} OR presentation->>'kindExplicit' = 'false' OR ${!p.kindExplicit}) AND NOT withdrawn AND created_at <= ${postAt}
      AND type <> 'bonus_credit' AND (status = 'announced' OR ${p.action === "confirm"} AND confirmation_basis = 'receipt_review' AND confirmed_at IS NULL)
    ORDER BY created_at DESC`;
  const eligible = rows.filter((e) => isOpen(e, postAt, 12 * HOUR) && !scopeConflicts(e.presentation?.scopeLabel as string | null, propositionScope(p)) && !quotaConflicts(e.presentation?.quotaScope, p) && !eventScopeConflicts(e, p));
  if (eligible.length === 1 && currentMonitor().requireCrossAuthorEvidence) {
    if (!await verifiedCrossAuthorTarget(tx, eligible[0]!.id, postAt, postAuthor, context, sourceText)) return { target: null, needsReview: true };
  }
  return { target: eligible.length === 1 ? eligible[0]! : null, needsReview: eligible.length > 1
    || eligible.length === 0 && rows.some((e) => isOpen(e, postAt, 12 * HOUR) && eventProductConflicts(e, p)) };
}

/** Text compared loosely: case, quotes, dashes, links, emoji and spacing aside. */
function loose(text: string): string {
  return ` ${text.normalize("NFKC").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/**
 * Whether the sentence the recognizer quotes is the monitored author's own words in this post: a model cannot announce
 * or confirm anything with a sentence he did not write. An elided quote ("…") matches part by part.
 */
export function quotedInPost(excerpt: string, post: string): boolean {
  const body = loose(post);
  const parts = excerpt.split(/…|\.\.\./).map(loose).filter((part) => part.trim().length > 0);
  return parts.length > 0 && parts.every((part) => body.includes(part));
}

function labelOf(p: Proposition, postAt: Date, context: ContextInput[], sourceText: string): string | null {
  const stated = usableTime(p, postAt, context, sourceText);
  return stated ? scheduleFrom(stated).label : null;
}

async function link(tx: Tx, eventId: string, postId: string, p: Proposition) {
  await tx`
    INSERT INTO monitor_event_posts (monitor_id, event_id, post_id, stage, action, text, original_text)
    VALUES (${monitorId()}, ${eventId}, ${postId}, ${STAGE[p.kind][p.action]}, ${p.action}, ${p.excerptZh || p.excerpt}, ${p.excerpt})
    ON CONFLICT (monitor_id, event_id, post_id) DO UPDATE SET stage = EXCLUDED.stage, action = EXCLUDED.action, text = EXCLUDED.text, original_text = EXCLUDED.original_text`;
}

async function createEvent(tx: Tx, p: Proposition, postId: string, index: number, postAt: Date, status: "announced" | "confirmed", context: ContextInput[], sourceText: string, author: string, extra: Record<string, unknown> = {}, nth = 1) {
  // Event ids: <kind>-<creating post>-<proposition #>-<reset # within it> ("reset twice" makes -1-1 and -1-2).
  const id = `${p.kind === "bonus_credit" ? "bonus" : p.kind === "reset_credit" ? "banked" : "reset"}-${postId}-${index + 1}-${nth}`;
  const stated = usableTime(p, postAt, context, sourceText);
  const schedule = stated ? scheduleFrom(stated) : null;
  const estimate = status === "confirmed" || p.kind === "bonus_credit" ? null : estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding });
  await tx`
    INSERT INTO monitor_events (monitor_id, id, type, status, title, scope, label, display_label, schedule, estimate, presentation, confirmed_at, confirmation_basis, created_at, updated_at)
    VALUES (${monitorId()}, ${id}, ${p.kind}, ${status}, '', ${legacyScope(p)}, ${eventLabel(p.kind)},
            ${p.kindExplicit ? eventDisplayLabel(p.kind) : "重置（形式未明确）"},
            ${schedule ? tx.json(schedule as never) : null}, ${estimate ? tx.json(estimate as never) : null}, ${tx.json(presentationOf(p, author, extra) as never)},
            ${status === "confirmed" ? postAt : null}, ${status === "confirmed" ? "source_post" : null}, ${postAt}, ${postAt})
    ON CONFLICT (monitor_id, id) DO NOTHING`;
  return id;
}

/**
 * Applies one recognition inside a transaction. Idempotent for the same post: a second run (an
 * overlapping tick, a lookback, a retry) finds the post processed under its row lock and changes
 * nothing, so it cannot create a second event or notification.
 */
export async function applyRecognition(postId: string, rec: Recognition): Promise<Applied> {
  return sql.begin(async (tx) => {
    const [post] = await tx<{ author: string; published_at: Date; text: string; raw: { context?: ContextInput[] } | null; context: Array<Record<string, unknown>>; processed_at: Date | null }[]>`
      SELECT author, published_at, text, raw, context, processed_at FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts WHERE id = ${postId} FOR UPDATE`;
    if (!post) throw new Error(`monitor post ${postId} not found`);
    if (post.processed_at) return { eventIds: [], notify: [] };
    return withAuthorTime(post.author, async () => {
    const postAt = post.published_at;
    const originalContext: ContextInput[] = post.raw?.context ?? post.context.map((c) => ({ id: String(c.id), author: String(c.author), relation: c.relation as ContextInput["relation"], text: String(c.originalText ?? ""), publishedAt: typeof c.publishedAt === "string" ? c.publishedAt : null }));
    const modelResult = structuredClone(rec);
    const threadEvents = await trustedThreadEvents(tx, originalContext, postAt);
    // A standalone reminder may name a supplied campaign without replying to its original thread.
    const namedIds = rec.propositions.filter(p => p.kind === "bonus_credit" && p.relatesTo && quotedInPost(p.excerpt, post.text))
      .map(p => p.relatesTo!);
    const namedEvents = namedIds.length ? await tx<Array<{ id: string; type: Proposition["kind"] }>>`
      SELECT e.id,e.type FROM monitor_events e WHERE e.monitor_id=${monitorId()} AND e.id=ANY(${namedIds}::text[])
        AND e.type='bonus_credit' AND NOT e.withdrawn AND e.created_at<=${postAt}
        AND EXISTS (SELECT 1 FROM monitor_event_posts l JOIN monitor_posts p ON p.monitor_id=l.monitor_id AND p.id=l.post_id
          WHERE l.monitor_id=e.monitor_id AND l.event_id=e.id AND lower(p.author)=ANY(${authorHandles()}::text[]) AND p.published_at<=${postAt})` : [];
    const threadRelated = new Set<Proposition>();
    const ambiguousThread = new Set<Proposition>();
    const exclusions: Array<{ index: number; reason: string }> = [];
    const excluded = new Set<Proposition>();
    const unknownTime = new Set<Proposition>();
    const defaultedProducts = new Set<Proposition>();
    rec = { ...rec, propositions: rec.propositions.map((p, index) => {
      const refersToCampaign = /\b(?:the|your|this)\s+(?:credit|bonus|promo|promotion)|\bcan still claim\b|\/claim-credit\b/i.test(p.excerpt);
      const newCampaign = /\b(?:another|second|new|additional)\s+(?:(?:one[ -]time|bonus|reward|promotional|cloud)\s+)*(?:credit|campaign|promotion)|\banother\s+(?:bonus|reward)\b/i.test(p.excerpt);
      const targets = [...new Map([...threadEvents,
        ...(refersToCampaign && !newCampaign ? namedEvents.filter(event => event.id === p.relatesTo) : [])]
        .filter(event => event.type === p.kind).map(event => [event.id, event])).values()];
      const reason = !currentMonitor().eventKinds.includes(p.kind) ? "此监控未启用该事件类型" : currentMonitor().excludeProposition?.(p, post.text, { trustedEventKinds: targets.map((event) => event.type) });
      if (reason) {
        exclusions.push({ index, reason });
        const rejected: Proposition = { ...p, real: false, role: "explanation", relatesTo: null };
        excluded.add(rejected);
        return rejected;
      }
      // Official thread details enrich the known campaign with their own words, without confirming it again.
      let supplement = false;
      if (p.kind === "bonus_credit" && targets.length && quotedInPost(p.excerpt, post.text)
        && refersToCampaign && !newCampaign && p.action !== "withdraw"
        && (p.action !== "amend" || p.role === "explanation" || !p.real)) {
        p = { ...p, real: true, role: "explanation", action: "amend", relatesTo: p.relatesTo ?? (targets.length === 1 ? targets[0]!.id : null) };
        supplement = true;
      }
      const input = { id: postId, text: post.text, publishedAt: postAt, context: originalContext };
      if (p.kind === "bonus_credit") p = { ...p, count: 1, expectedLanding: null, timeInferred: false, bonusCredit: bonusCreditOf(p, input),
        statedTime: bonusOpeningTime(p) ? p.statedTime : null };
      const resolved = timeSource(p, input);
      if (!resolved.proposition.scope.productsZh) {
        const product = currentMonitor().defaultProductForAuthor?.(post.author);
        if (product) {
          resolved.proposition = { ...resolved.proposition, scope: { ...resolved.proposition.scope, productsZh: product } };
          defaultedProducts.add(resolved.proposition);
        }
      }
      if (supplement) threadRelated.add(resolved.proposition);
      if (supplement && (targets.length > 1 && !p.relatesTo || p.relatesTo && !targets.some((event) => event.id === p.relatesTo))) ambiguousThread.add(resolved.proposition);
      if (resolved.needsReview) unknownTime.add(resolved.proposition);
      return resolved.proposition;
    }) };
    if (exclusions.length === rec.propositions.length && exclusions.length > 0 && !rec.outage) rec.relevant = false;
    const contextZh = new Map(rec.contextZh.map((c) => [c.id, c.textZh]));
    const context = post.context.map((c) => ({ ...c, text: (c.text as string | null) ?? contextZh.get(String(c.id)) ?? null }));
    const evidence = new Map(rec.propositions.map((p, index) => [p, actionEvidence(p, originalContext,
      rec.propositions.slice(0, index).filter((q) => !excluded.has(q) && quotedInPost(q.excerpt, post.text)))]));
    const claimed = rec.propositions.filter((p) => !excluded.has(p) && (p.real || evidence.get(p) === "review") && p.excerpt.trim() && (threadRelated.has(p) || evidence.get(p) !== "related"
      || !quotedInPost(p.excerpt, post.text) && !["uncertain", "policy", "explanation"].includes(p.role ?? "action")));
    // An uncertain claim, including an announcement or withdrawal, cannot change public facts.
    const reasons = new Map<Proposition, string>();
    const held = claimed.filter((p) => {
      const reason = !quotedInPost(p.excerpt, post.text) ? "命题引文不在原帖中"
        : ambiguousThread.has(p) ? "官方线程关联到多个奖励活动，无法确定补充对象"
        : unknownTime.has(p) ? "相对时间缺少有效来源日期"
          : evidence.get(p) === "review" ? "明确动作缺少关键上下文或确认对象"
            : p.action === "confirm" && !p.relatesTo && retrospective(p.excerpt) && !usableTime(p, postAt, originalContext, post.text) ? "回顾性确认缺少有效发生时间或确认对象" : null;
      if (reason) reasons.set(p, reason);
      return !!reason;
    });
    const accepted = claimed
      .filter((p) => !held.includes(p))
      .filter((p) => {
        if (p.duplicateOf !== undefined && p.duplicateOf !== null) {
          const index = rec.propositions.indexOf(p);
          const original = rec.propositions[p.duplicateOf];
          if (p.duplicateOf >= index || !original || !claimed.includes(original) || held.includes(original)
            || original.kind !== p.kind || original.action !== p.action || original.count !== p.count || original.relatesTo !== p.relatesTo
            || claimScopesConflict(original, p)
            || labelOf(original, postAt, originalContext, post.text) !== labelOf(p, postAt, originalContext, post.text)) { held.push(p); reasons.set(p, "重复命题指向或事实不一致"); }
          else mergeRepeatedScope(original, p);
          return false;
        }
        const earlier = claimed.slice(0, claimed.indexOf(p)).filter((q) => !held.includes(q) && q.duplicateOf == null);
          if (earlier.some((q) => q.kind === p.kind && q.action === p.action && q.count === p.count && q.relatesTo === p.relatesTo && !claimScopesConflict(q, p) && loose(q.excerpt) === loose(p.excerpt))) return false;
        // The deployed recognizer once counted the explanation of a 500k-user compensation twice.
        // An explicit "instead granted" explanation restates the compensation and supplies its condition.
        // Without that evidence, different wording/scopes alone do not prove one or two rounds.
        const repeated = p.action === "confirm" && p.count === 1 && !ANOTHER.test(p.excerpt) && earlier.find((q) =>
          q.kind === p.kind && q.action === "confirm" && q.count === 1 && q.relatesTo === p.relatesTo
          && labelOf(q, postAt, originalContext, post.text) === labelOf(p, postAt, originalContext, post.text) && !claimScopesConflict(q, p));
        if (repeated) {
          if (/^instead\s+(?:granted|added|gave)\b/i.test(p.excerpt.trim()) && p.kind === "reset_credit") {
            mergeRepeatedScope(repeated, p);
            p.duplicateOf = rec.propositions.indexOf(repeated);
            return false;
          }
          held.push(p);
          reasons.set(p, "无法判断多条确认是否属于同一次事件");
          return false;
        }
        return true;
      })
      // Several rounds only when the monitored author states the number.
      .map((p) => {
        if (p.count <= 1 || STATED_COUNT.test(p.excerpt)) return p;
        const single = { ...p, count: 1 };
        if (defaultedProducts.has(p)) defaultedProducts.add(single);
        return single;
      });
    const applied: Applied = { eventIds: [], notify: [] };
    // Events this post itself created, by kind: a later sentence repeating the same reset joins it.
    const createdHere = new Map<Proposition["kind"], { id: string; label: string | null; claim: Proposition }>();
    const changed: Proposition[] = [];

    for (const [index, p] of accepted.entries()) {
      const here = createdHere.get(p.kind);
      if (here && !p.relatesTo && p.count === 1 && (p.action === "announce" || p.action === "progress") && !ANOTHER.test(p.excerpt) && !claimScopesConflict(here.claim, p)) {
        const stated = usableTime(p, postAt, originalContext, post.text);
        if (!stated || scheduleFrom(stated).label === here.label) continue;
      }
        const resolution = await findTarget(tx, p, postAt, post.author, originalContext, post.text);
      if (resolution.needsReview) { held.push(p); reasons.set(p, p.relatesTo ? "指定关联事件不存在或与明确事实冲突" : "存在多个可能的关联事件"); continue; }
      const target = resolution.target;
      // A single event id cannot identify every round in a multi-round statement.
      // Do not silently confirm only one or invent the remaining rounds beside existing ones.
      if (p.count > 1 && (target || !["announce", "confirm"].includes(p.action))) {
        held.push(p);
        reasons.set(p, target ? "多轮动作只关联到一个事件，无法确定其余轮次的归属" : "多轮动作缺少各轮目标事件，无法确定其余轮次的归属");
        continue;
      }
      if (target && !p.kindExplicit) p.kind = target.type;
      if (p.role === "explanation" && !threadRelated.has(p)) {
        // Completion embedded in an explanation can only close the known round quoted in this thread.
        if (!target || target.status !== "announced") continue;
        const sourceIds = originalContext.filter((c) => isAuthor(c.author)).map((c) => c.id);
        const [source] = await tx`SELECT event_id FROM (SELECT * FROM monitor_event_posts WHERE monitor_id = ${monitorId()}) AS monitor_event_posts WHERE event_id = ${target.id} AND post_id = ANY(${sourceIds}::text[]) LIMIT 1`;
        if (!source) continue;
      }
      let eventId: string;
      if (p.action === "announce") {
        if (target) {
          eventId = target.id;
          const stated = usableTime(p, postAt, originalContext, post.text);
          if (stated && target.status === "announced") {
            const schedule = scheduleFrom(stated);
            const estimate = p.kind === "bonus_credit" ? null : estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding });
            await tx`UPDATE monitor_events SET schedule = ${tx.json(schedule as never)}, estimate = ${tx.json(estimate as never)}, presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json({ timePolicy: p.kind === "bonus_credit" ? "explicit" : authorTimePolicy(), timeAuthor: post.author })}, updated_at = ${postAt} WHERE monitor_id = ${monitorId()} AND (id = ${eventId}) `;
            if (schedule.label !== target.schedule?.label) applied.notify.push({ eventId, action: "amend", postId });
          }
        } else {
          eventId = await createEvent(tx, p, postId, index, postAt, "announced", originalContext, post.text, post.author);
          createdHere.set(p.kind, { id: eventId, label: labelOf(p, postAt, originalContext, post.text), claim: p });
          applied.notify.push({ eventId, action: "announce", postId });
          for (let nth = 2; nth <= p.count; nth++) {
            const extraId = await createEvent(tx, p, postId, index, postAt, "announced", originalContext, post.text, post.author, {}, nth);
            await link(tx, extraId, postId, p);
            applied.eventIds.push(extraId);
          }
        }
      } else if (p.action === "progress") {
        if (target) {
          eventId = target.id;
          await tx`UPDATE monitor_events SET presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json({ inProgress: true, reportedAt: postAt.toISOString() })}, updated_at = ${postAt} WHERE monitor_id = ${monitorId()} AND (id = ${eventId} AND status = 'announced') `;
          // "Propagating in the next hour" narrows when it lands.
          const stated = usableTime(p, postAt, originalContext, post.text);
          if (stated && target.status === "announced") {
            const schedule = scheduleFrom(stated);
            await tx`UPDATE monitor_events SET schedule = ${tx.json(schedule as never)}, estimate = ${p.kind === "bonus_credit" ? null : tx.json(estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding }) as never)}, presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json({ timePolicy: p.kind === "bonus_credit" ? "explicit" : authorTimePolicy(), timeAuthor: post.author })} WHERE monitor_id = ${monitorId()} AND (id = ${eventId}) `;
          }
        } else {
          eventId = await createEvent(tx, p, postId, index, postAt, "announced", originalContext, post.text, post.author, { inProgress: true, reportedAt: postAt.toISOString() });
          createdHere.set(p.kind, { id: eventId, label: labelOf(p, postAt, originalContext, post.text), claim: p });
          applied.notify.push({ eventId, action: "announce", postId });
        }
      } else if (p.action === "confirm") {
        if (target && target.status === "confirmed") {
          const [c] = await tx<{ confirmed_at: Date | null; confirmation_basis: string | null }[]>`SELECT confirmed_at, confirmation_basis FROM (SELECT * FROM monitor_events WHERE monitor_id = ${monitorId()}) AS monitor_events WHERE id = ${target.id}`;
          eventId = target.id;
          // Confirmed from an account check before the monitored author said anything: his post now becomes the source
          // (and the earliest confirmation-post time). Status was already confirmed, so no notification.
          if (c?.confirmation_basis === "receipt_review") {
            await tx`UPDATE monitor_events SET confirmation_basis = 'source_post', confirmed_at = coalesce(confirmed_at, ${postAt}), updated_at = ${postAt} WHERE monitor_id = ${monitorId()} AND (id = ${eventId}) `;
          }
        } else if (target) {
          eventId = target.id;
          const updated = await tx`
            UPDATE monitor_events SET status = 'confirmed', confirmed_at = coalesce(confirmed_at, ${postAt}), confirmation_basis = coalesce(confirmation_basis, 'source_post'),
              estimate = NULL, presentation = coalesce(presentation, '{}'::jsonb) || '{"inProgress": false}'::jsonb, updated_at = ${postAt}
            WHERE monitor_id = ${monitorId()} AND (id = ${eventId} AND status = 'announced') `;
          if (updated.count) applied.notify.push({ eventId, action: "confirm", postId });
        } else {
          eventId = await createEvent(tx, p, postId, index, postAt, "confirmed", originalContext, post.text, post.author);
          applied.notify.push({ eventId, action: "confirm", postId });
          // "We reset twice" with nothing announced: each stated round is a confirmed reset of its own.
          for (let nth = 2; nth <= p.count; nth++) {
            const extraId = await createEvent(tx, p, postId, index, postAt, "confirmed", originalContext, post.text, post.author, {}, nth);
            await link(tx, extraId, postId, p);
            applied.eventIds.push(extraId);
          }
        }
      } else if (p.action === "amend") {
        if (!target) continue;
        eventId = target.id;
        const patch: Record<string, unknown> = {};
        if (p.scope.audienceSource || p.scope.plans?.length) {
          const label = propositionScope(p);
          Object.assign(patch, { scopeKnown: true, scopeLabel: label });
        }
        delete patch.reportedAt;
        await tx`UPDATE monitor_events SET presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json(patch as never)}, updated_at = ${postAt} WHERE monitor_id = ${monitorId()} AND (id = ${eventId}) `;
        const scopeChanged = "scopeLabel" in patch && patch.scopeLabel !== (target.presentation?.scopeLabel ?? null);
        let timeChanged = false;
        const stated = usableTime(p, postAt, originalContext, post.text);
        if (stated && target.status === "announced") {
          const schedule = scheduleFrom(stated);
          timeChanged = schedule.label !== target.schedule?.label;
          await tx`UPDATE monitor_events SET schedule = ${tx.json(schedule as never)}, estimate = ${p.kind === "bonus_credit" ? null : tx.json(estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding }) as never)}, presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json({ timePolicy: p.kind === "bonus_credit" ? "explicit" : authorTimePolicy(), timeAuthor: post.author })} WHERE monitor_id = ${monitorId()} AND (id = ${eventId}) `;
        }
        // Readers who were told of the announcement hear of a new time or a different audience.
        const bonusChanged = p.kind === "bonus_credit" && p.bonusCredit && Object.entries(p.bonusCredit).some(([key, value]) =>
          value !== null && JSON.stringify(value) !== JSON.stringify((target.presentation?.bonusCredit as Record<string, unknown> | null)?.[key]));
        if (!threadRelated.has(p) && (target.status === "announced" || p.kind === "bonus_credit") && (timeChanged || scopeChanged || bonusChanged)) applied.notify.push({ eventId, action: "amend", postId });
      } else {
        if (!target) continue;
        eventId = target.id;
        await tx`UPDATE monitor_events SET withdrawn = true, updated_at = ${postAt} WHERE monitor_id = ${monitorId()} AND (id = ${eventId}) `;
        if (target.status === "announced" || p.kind === "bonus_credit") applied.notify.push({ eventId, action: "withdraw", postId });
      }
      changed.push(p);
      if (p.action !== "withdraw") await enrichEvent(tx, eventId, p, target?.presentation, threadRelated.has(p), defaultedProducts.has(p));
      await link(tx, eventId, postId, p);
      if (!applied.eventIds.includes(eventId)) applied.eventIds.push(eventId);
    }

    const primary = changed.find((p) => p.action !== "progress")?.action ?? null;
    const activity = applied.eventIds.length
      ? { kind: "event_update", action: primary, statusChanged: true, eventIds: applied.eventIds }
      : rec.relevant && held.length === 0
        ? { kind: "related", action: null, statusChanged: false, eventIds: rec.propositions.map((p) => p.relatesTo).filter((x): x is string => !!x) }
        : null;

    // Outage hints: an acknowledged outage, its recovery, and the reset announced after it.
    let outage: Record<string, unknown> | null = null;
    if (rec.outage === "outage") outage = { kind: "outage", recoveredAt: null, resetEventId: null };
    const [open] = await tx<{ id: string; outage: { recoveredAt: string | null; resetEventId: string | null } }[]>`
      SELECT id, outage FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts WHERE outage IS NOT NULL AND id <> ${postId}
        AND published_at >= ${new Date(postAt.getTime() - OUTAGE_LINK_MS)} AND published_at <= ${postAt}
      ORDER BY published_at DESC LIMIT 1`;
    if (open) {
      const patch: Record<string, unknown> = {};
      if (rec.outage === "recovery" && !open.outage.recoveredAt) patch.recoveredAt = postAt.toISOString();
      const announced = applied.notify.find((n) => n.action === "announce" && !n.eventId.startsWith("bonus-"));
      if (announced && !open.outage.resetEventId) patch.resetEventId = announced.eventId;
      if (Object.keys(patch).length) await tx`UPDATE monitor_posts SET outage = outage || ${tx.json(patch as never)} WHERE monitor_id = ${monitorId()} AND (id = ${open.id}) `;
    }

    // The pushes this post owes are stored with it, in the same transaction: a push interrupted after
    // this commit is sent by the next tick (flushResetPushes), never lost.
    await tx`
      UPDATE monitor_posts SET translation = coalesce(${rec.relevant ? rec.translationZh : null}, translation), context = ${tx.json(context as never)},
        recognition = ${tx.json({ ...rec, modelResult, ...(exclusions.length ? { exclusions } : {}), needsReview: held.length > 0, held: held.map((p) => ({ action: p.action, excerpt: p.excerpt, reason: reasons.get(p) ?? "事件依据存在冲突" })), notify: applied.notify } as never)},
        activity = coalesce(${activity ? tx.json(activity as never) : null}, activity),
        outage = coalesce(${outage ? tx.json(outage as never) : null}, outage), processed_at = now()
      WHERE monitor_id = ${monitorId()} AND (id = ${postId}) `;
    await enqueuePublicV2(tx, applied.eventIds);
    // The paid recognition is complete once its result is committed with the post.
    await completeReceipt(tx, rec.receiptId);
    await tx`INSERT INTO monitor_state (monitor_id, key, value) VALUES (${monitorId()}, 'publication_revision', ${tx.json({ revision: randomUUID() })})
      ON CONFLICT (monitor_id, key) DO UPDATE SET value = excluded.value`;

    return applied;
    });
  });
}
