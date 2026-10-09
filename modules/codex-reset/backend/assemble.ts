// Turns a recognized post into monitor facts: events (announce → progress → confirm, amend,
// withdraw), the post's activity role and outage links. Code decides what
// a proposition may change; the model's wording never confirms anything on its own.
import { sql, type Tx } from "@aihot/backend/db";
import { randomUUID } from "node:crypto";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import type { ContextInput, Proposition, Recognition } from "./recognize.ts";
import { actionEvidence, timeSource } from "./evidence.ts";
import { estimateFor, resolveStatedTime, scheduleFrom, type Schedule } from "./time.ts";

const HOUR = 3600_000;
const OUTAGE_LINK_MS = 18 * HOUR;
/** "in about an hour", "in the next hour or so", "shortly" are approximate; "in the next few hours" is a deadline. */
const HEDGED = /\b(about|around|approximately|roughly|shortly|soon|or so)\b|~|-ish\b/i;
/** Words that keep potentially distinct claims within one post from being collapsed. */
const ANOTHER = /\b(another|again|second|one more|twice|2nd)\b/i;
/** An ordinal names a round; "Again, ..." can simply repeat its confirmation. */
const NEW_ROUND = /\b(?:another|one more)\s+(?:(?:banked|manual|codex|usage|full)\s+)*reset\b|\banother one\s+(?:will|is|has|have|lands?|came|coming)\b|\breset(?:ting)?(?:\s+(?:codex|usage|rate|limits?|everyone['’]s)){0,5}\s+again\b/i;
/** Tibo saying how many ("reset twice", "two resets", "3x"). Plural wording alone ("more resets coming") is one round. */
const STATED_COUNT = /\b(twice|thrice)\b|\b(two|three|four|five|[2-5])\s+(?:(?:banked|manual)\s+)?(?:times|resets?)\b|\b[2-5]\s*x\b/i;

const STAGE: Record<Proposition["kind"], Record<Proposition["action"], string>> = {
  direct_reset: { announce: "预告", progress: "进展", confirm: "确认完成", amend: "补充说明", withdraw: "撤回" },
  reset_credit: { announce: "发卡预告", progress: "进展", confirm: "确认发卡", amend: "补充说明", withdraw: "撤回" },
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

/** The recognizer's words turned into a Pacific statement by code (null when nothing usable was said). */
function usableTime(p: Proposition, postAt: Date, context: ContextInput[]) {
  if (!p.statedTime) return null;
  const hedged = p.statedTime.precision === "approximate" && p.statedTime.relativeHours && !HEDGED.test(p.excerpt);
  const source = context.find((c) => c.id === p.timeSourceId);
  const at = source?.publishedAt ? new Date(source.publishedAt) : postAt;
  return resolveStatedTime(hedged ? { ...p.statedTime, precision: "deadline" } : p.statedTime, at);
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

function presentationOf(p: Proposition, extra: Record<string, unknown> = {}) {
  const scopeLabel = p.scope.plans?.length ? p.scope.plans.join(", ") : p.scope.audienceSource;
  return {
    scopeKnown: !!scopeLabel,
    scopeLabel: scopeLabel ?? null,
    kindExplicit: p.kindExplicit,
    timeInferred: p.timeInferred,
    audienceZh: p.scope.audienceZh,
    productsZh: p.scope.productsZh,
    reportedAt: null,
    ...extra,
  };
}

function scopeConflicts(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const free = (s: string) => /\bfree\b/i.test(s);
  const paid = (s: string) => /\b(paid|plus|pro|business|enterprise)\b/i.test(s);
  if (free(a) && paid(b) || paid(a) && free(b)) return true;
  const plans = (s: string): string[] => s.toLowerCase().match(/\b(plus|pro|business|enterprise)\b/g) ?? [];
  const x = plans(a), y = plans(b);
  return x.length > 0 && y.length > 0 && !x.some((v) => y.includes(v));
}

function propositionScope(p: Proposition): string | null {
  return p.scope.plans?.join(", ") ?? p.scope.audienceSource;
}

function mergeRepeatedScope(original: Proposition, repeated: Proposition) {
  original.scope = { ...original.scope,
    audienceSource: [...new Set([original.scope.audienceSource, repeated.scope.audienceSource].filter(Boolean))].join("; ") || null,
    audienceZh: [...new Set([original.scope.audienceZh, repeated.scope.audienceZh].filter(Boolean))].join("；") || null,
    productsZh: original.scope.productsZh ?? repeated.scope.productsZh };
}

/** Only fields stated in a follow-up are merged; missing fields cannot erase earlier evidence. */
async function enrichEvent(tx: Tx, id: string, p: Proposition, previous: Record<string, unknown> | null = null) {
  const patch: Record<string, unknown> = {};
  const scope = propositionScope(p);
  // Progress and completion describe delivery, not a revision of who was promised the reset.
  const keepKnownScope = (p.action === "progress" || p.action === "confirm") && !!previous?.scopeLabel;
  if (scope && !keepKnownScope) Object.assign(patch, { scopeKnown: true, scopeLabel: scope });
  if (p.scope.audienceZh && !keepKnownScope) patch.audienceZh = p.scope.audienceZh;
  if (p.scope.productsZh) patch.productsZh = p.scope.productsZh;
  if (p.kindExplicit) patch.kindExplicit = true;
  if (p.statedTime) patch.timeInferred = p.timeInferred;
  if (!Object.keys(patch).length) return;
  await tx`UPDATE monitor_events SET presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json(patch as never)},
    type = CASE WHEN ${p.kindExplicit && previous?.kindExplicit === false} THEN ${p.kind} ELSE type END,
    label = CASE WHEN ${p.kindExplicit && previous?.kindExplicit === false} THEN ${p.kind === "reset_credit" ? "发重置卡" : "全员重置"} ELSE label END,
    display_label = CASE WHEN ${p.kindExplicit} THEN ${p.kind === "reset_credit" ? "重置卡发放" : "额度重置"} ELSE display_label END,
    scope = CASE WHEN ${!keepKnownScope && !!legacyScope(p)} THEN ${legacyScope(p)} ELSE scope END WHERE id = ${id}`;
}

async function findTarget(tx: Tx, p: Proposition, postAt: Date): Promise<{ target: EventRow | null; needsReview: boolean }> {
  if (p.relatesTo) {
    const [e] = await tx<EventRow[]>`SELECT id, type, status, schedule, presentation, created_at FROM monitor_events WHERE id = ${p.relatesTo} AND NOT withdrawn`;
    // "The second reset has landed" can complete its explicitly named announcement.
    // A new announcement or a further reset after completion is independent of the named old round.
    if (e && p.count === 1 && NEW_ROUND.test(p.excerpt) && (p.action === "announce" || p.action === "confirm" && e.status === "confirmed")) return { target: null, needsReview: false };
    const kindCompatible = e && (e.type === p.kind || !p.kindExplicit || e.presentation?.kindExplicit === false);
    if (e && kindCompatible && e.created_at <= postAt && (p.action === "amend"
      || !scopeConflicts(e.presentation?.scopeLabel as string | null, propositionScope(p)))) return { target: e, needsReview: false };
    return { target: null, needsReview: true };
  }
  if (p.action === "announce") return { target: null, needsReview: false };
  // A sole compatible open announcement can be linked; several candidates require explicit evidence.
  const rows = await tx<EventRow[]>`
    SELECT id, type, status, schedule, presentation, created_at FROM monitor_events
    WHERE (type = ${p.kind} OR presentation->>'kindExplicit' = 'false' OR ${!p.kindExplicit}) AND NOT withdrawn AND created_at <= ${postAt}
      AND (status = 'announced' OR ${p.action === "confirm"} AND confirmation_basis = 'receipt_review' AND confirmed_at IS NULL)
    ORDER BY created_at DESC`;
  const eligible = rows.filter((e) => isOpen(e, postAt, 12 * HOUR) && !scopeConflicts(e.presentation?.scopeLabel as string | null, propositionScope(p)));
  return { target: eligible.length === 1 ? eligible[0]! : null, needsReview: eligible.length > 1 };
}

/** Text compared loosely: case, quotes, dashes, links, emoji and spacing aside. */
function loose(text: string): string {
  return ` ${text.normalize("NFKC").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/**
 * Whether the sentence the recognizer quotes is Tibo's own words in this post: a model cannot announce
 * or confirm anything with a sentence he did not write. An elided quote ("…") matches part by part.
 */
export function quotedInPost(excerpt: string, post: string): boolean {
  const body = loose(post);
  const parts = excerpt.split(/…|\.\.\./).map(loose).filter((part) => part.trim().length > 0);
  return parts.length > 0 && parts.every((part) => body.includes(part));
}

function labelOf(p: Proposition, postAt: Date, context: ContextInput[]): string | null {
  const stated = usableTime(p, postAt, context);
  return stated ? scheduleFrom(stated).label : null;
}

async function link(tx: Tx, eventId: string, postId: string, p: Proposition) {
  await tx`
    INSERT INTO monitor_event_posts (event_id, post_id, stage, action, text, original_text)
    VALUES (${eventId}, ${postId}, ${STAGE[p.kind][p.action]}, ${p.action}, ${p.excerptZh || p.excerpt}, ${p.excerpt})
    ON CONFLICT (event_id, post_id) DO UPDATE SET stage = EXCLUDED.stage, action = EXCLUDED.action, text = EXCLUDED.text, original_text = EXCLUDED.original_text`;
}

async function createEvent(tx: Tx, p: Proposition, postId: string, index: number, postAt: Date, status: "announced" | "confirmed", context: ContextInput[], extra: Record<string, unknown> = {}, nth = 1) {
  // Event ids: <kind>-<creating post>-<proposition #>-<reset # within it> ("reset twice" makes -1-1 and -1-2).
  const id = `${p.kind === "reset_credit" ? "banked" : "reset"}-${postId}-${index + 1}-${nth}`;
  const stated = usableTime(p, postAt, context);
  const schedule = stated ? scheduleFrom(stated) : null;
  const estimate = status === "confirmed" ? null : estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding });
  await tx`
    INSERT INTO monitor_events (id, type, status, title, scope, label, display_label, schedule, estimate, presentation, confirmed_at, confirmation_basis, created_at, updated_at)
    VALUES (${id}, ${p.kind}, ${status}, '', ${legacyScope(p)}, ${p.kind === "reset_credit" ? "发重置卡" : "全员重置"},
            ${p.kindExplicit ? (p.kind === "reset_credit" ? "重置卡发放" : "额度重置") : "重置（形式未明确）"},
            ${schedule ? tx.json(schedule as never) : null}, ${estimate ? tx.json(estimate as never) : null}, ${tx.json(presentationOf(p, extra) as never)},
            ${status === "confirmed" ? postAt : null}, ${status === "confirmed" ? "source_post" : null}, ${postAt}, ${postAt})
    ON CONFLICT (id) DO NOTHING`;
  return id;
}

/**
 * Applies one recognition inside a transaction. Idempotent for the same post: a second run (an
 * overlapping tick, a lookback, a retry) finds the post processed under its row lock and changes
 * nothing, so it cannot create a second event or notification.
 */
export async function applyRecognition(postId: string, rec: Recognition): Promise<Applied> {
  return sql.begin(async (tx) => {
    const [post] = await tx<{ published_at: Date; text: string; raw: { context?: ContextInput[] } | null; context: Array<Record<string, unknown>>; processed_at: Date | null }[]>`
      SELECT published_at, text, raw, context, processed_at FROM monitor_posts WHERE id = ${postId} FOR UPDATE`;
    if (!post) throw new Error(`monitor post ${postId} not found`);
    if (post.processed_at) return { eventIds: [], notify: [] };
    const postAt = post.published_at;
    const originalContext: ContextInput[] = post.raw?.context ?? post.context.map((c) => ({ id: String(c.id), author: String(c.author), relation: c.relation as ContextInput["relation"], text: String(c.originalText ?? ""), publishedAt: typeof c.publishedAt === "string" ? c.publishedAt : null }));
    const modelResult = structuredClone(rec);
    const unknownTime = new Set<Proposition>();
    rec = { ...rec, propositions: rec.propositions.map((p) => {
      const resolved = timeSource(p, { id: postId, text: post.text, publishedAt: postAt, context: originalContext });
      if (resolved.needsReview) unknownTime.add(resolved.proposition);
      return resolved.proposition;
    }) };
    const contextZh = new Map(rec.contextZh.map((c) => [c.id, c.textZh]));
    const context = post.context.map((c) => ({ ...c, text: (c.text as string | null) ?? contextZh.get(String(c.id)) ?? null }));
    const evidence = new Map(rec.propositions.map((p, index) => [p, actionEvidence(p, originalContext,
      rec.propositions.slice(0, index).filter((q) => quotedInPost(q.excerpt, post.text)))]));
    const claimed = rec.propositions.filter((p) => (p.real || evidence.get(p) === "review") && p.excerpt.trim() && (evidence.get(p) !== "related"
      || !quotedInPost(p.excerpt, post.text) && !["uncertain", "policy", "explanation"].includes(p.role ?? "action")));
    // An uncertain claim, including an announcement or withdrawal, cannot change public facts.
    const reasons = new Map<Proposition, string>();
    const held = claimed.filter((p) => {
      const reason = !quotedInPost(p.excerpt, post.text) ? "命题引文不在原帖中"
        : unknownTime.has(p) ? "相对时间缺少有效来源日期"
          : evidence.get(p) === "review" ? "明确动作缺少关键上下文或确认对象" : null;
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
            || scopeConflicts(propositionScope(original), propositionScope(p))
            || labelOf(original, postAt, originalContext) !== labelOf(p, postAt, originalContext)) { held.push(p); reasons.set(p, "重复命题指向或事实不一致"); }
          else mergeRepeatedScope(original, p);
          return false;
        }
        const earlier = claimed.slice(0, claimed.indexOf(p)).filter((q) => !held.includes(q) && q.duplicateOf == null);
        if (earlier.some((q) => q.kind === p.kind && q.action === p.action && q.count === p.count && q.relatesTo === p.relatesTo && loose(q.excerpt) === loose(p.excerpt))) return false;
        // The deployed recognizer once counted the explanation of a 500k-user compensation twice.
        // An explicit "instead granted" explanation restates the compensation and supplies its condition.
        // Without that evidence, different wording/scopes alone do not prove one or two rounds.
        const repeated = p.action === "confirm" && p.count === 1 && !ANOTHER.test(p.excerpt) && earlier.find((q) =>
          q.kind === p.kind && q.action === "confirm" && q.count === 1 && q.relatesTo === p.relatesTo
          && labelOf(q, postAt, originalContext) === labelOf(p, postAt, originalContext) && !scopeConflicts(propositionScope(q), propositionScope(p)));
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
      // Several rounds only when Tibo states the number.
      .map((p) => (p.count > 1 && !STATED_COUNT.test(p.excerpt) ? { ...p, count: 1 } : p));
    const applied: Applied = { eventIds: [], notify: [] };
    // Events this post itself created, by kind: a later sentence repeating the same reset joins it.
    const createdHere = new Map<Proposition["kind"], { id: string; label: string | null }>();
    const changed: Proposition[] = [];

    for (const [index, p] of accepted.entries()) {
      const here = createdHere.get(p.kind);
      if (here && !p.relatesTo && p.count === 1 && (p.action === "announce" || p.action === "progress") && !ANOTHER.test(p.excerpt)) {
        const stated = usableTime(p, postAt, originalContext);
        if (!stated || scheduleFrom(stated).label === here.label) continue;
      }
      const resolution = await findTarget(tx, p, postAt);
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
      if (p.role === "explanation") {
        // Completion embedded in an explanation can only close the known round quoted in this thread.
        if (!target || target.status !== "announced") continue;
        const sourceIds = originalContext.filter((c) => c.author.replace(/^@/, "").toLowerCase() === "thsottiaux").map((c) => c.id);
        const [source] = await tx`SELECT event_id FROM monitor_event_posts WHERE event_id = ${target.id} AND post_id = ANY(${sourceIds}::text[]) LIMIT 1`;
        if (!source) continue;
      }
      let eventId: string;
      if (p.action === "announce") {
        if (target) {
          eventId = target.id;
          const stated = usableTime(p, postAt, originalContext);
          if (stated && target.status === "announced") {
            const schedule = scheduleFrom(stated);
            const estimate = estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding });
            await tx`UPDATE monitor_events SET schedule = ${tx.json(schedule as never)}, estimate = ${tx.json(estimate as never)}, updated_at = ${postAt} WHERE id = ${eventId}`;
            if (schedule.label !== target.schedule?.label) applied.notify.push({ eventId, action: "amend", postId });
          }
        } else {
          eventId = await createEvent(tx, p, postId, index, postAt, "announced", originalContext);
          createdHere.set(p.kind, { id: eventId, label: labelOf(p, postAt, originalContext) });
          applied.notify.push({ eventId, action: "announce", postId });
          for (let nth = 2; nth <= p.count; nth++) {
            const extraId = await createEvent(tx, p, postId, index, postAt, "announced", originalContext, {}, nth);
            await link(tx, extraId, postId, p);
            applied.eventIds.push(extraId);
          }
        }
      } else if (p.action === "progress") {
        if (target) {
          eventId = target.id;
          await tx`UPDATE monitor_events SET presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json({ inProgress: true, reportedAt: postAt.toISOString() })}, updated_at = ${postAt} WHERE id = ${eventId} AND status = 'announced'`;
          // "Propagating in the next hour" narrows when it lands.
          const stated = usableTime(p, postAt, originalContext);
          if (stated && target.status === "announced") {
            const schedule = scheduleFrom(stated);
            await tx`UPDATE monitor_events SET schedule = ${tx.json(schedule as never)}, estimate = ${tx.json(estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding }) as never)} WHERE id = ${eventId}`;
          }
        } else {
          eventId = await createEvent(tx, p, postId, index, postAt, "announced", originalContext, { inProgress: true, reportedAt: postAt.toISOString() });
          createdHere.set(p.kind, { id: eventId, label: labelOf(p, postAt, originalContext) });
          applied.notify.push({ eventId, action: "announce", postId });
        }
      } else if (p.action === "confirm") {
        if (target && target.status === "confirmed") {
          const [c] = await tx<{ confirmed_at: Date | null; confirmation_basis: string | null }[]>`SELECT confirmed_at, confirmation_basis FROM monitor_events WHERE id = ${target.id}`;
          eventId = target.id;
          // Confirmed from an account check before Tibo said anything: his post now becomes the source
          // (and the earliest confirmation-post time). Status was already confirmed, so no notification.
          if (c?.confirmation_basis === "receipt_review") {
            await tx`UPDATE monitor_events SET confirmation_basis = 'source_post', confirmed_at = coalesce(confirmed_at, ${postAt}), updated_at = ${postAt} WHERE id = ${eventId}`;
          }
        } else if (target) {
          eventId = target.id;
          const updated = await tx`
            UPDATE monitor_events SET status = 'confirmed', confirmed_at = coalesce(confirmed_at, ${postAt}), confirmation_basis = coalesce(confirmation_basis, 'source_post'),
              estimate = NULL, presentation = coalesce(presentation, '{}'::jsonb) || '{"inProgress": false}'::jsonb, updated_at = ${postAt}
            WHERE id = ${eventId} AND status = 'announced'`;
          if (updated.count) applied.notify.push({ eventId, action: "confirm", postId });
        } else {
          eventId = await createEvent(tx, p, postId, index, postAt, "confirmed", originalContext);
          applied.notify.push({ eventId, action: "confirm", postId });
          // "We reset twice" with nothing announced: each stated round is a confirmed reset of its own.
          for (let nth = 2; nth <= p.count; nth++) {
            const extraId = await createEvent(tx, p, postId, index, postAt, "confirmed", originalContext, {}, nth);
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
        await tx`UPDATE monitor_events SET presentation = coalesce(presentation, '{}'::jsonb) || ${tx.json(patch as never)}, updated_at = ${postAt} WHERE id = ${eventId}`;
        const scopeChanged = "scopeLabel" in patch && patch.scopeLabel !== (target.presentation?.scopeLabel ?? null);
        let timeChanged = false;
        const stated = usableTime(p, postAt, originalContext);
        if (stated && target.status === "announced") {
          const schedule = scheduleFrom(stated);
          timeChanged = schedule.label !== target.schedule?.label;
          await tx`UPDATE monitor_events SET schedule = ${tx.json(schedule as never)}, estimate = ${tx.json(estimateFor({ schedule, announcedAt: postAt, model: p.expectedLanding }) as never)} WHERE id = ${eventId}`;
        }
        // Readers who were told of the announcement hear of a new time or a different audience.
        if (target.status === "announced" && (timeChanged || scopeChanged)) applied.notify.push({ eventId, action: "amend", postId });
      } else {
        if (!target) continue;
        eventId = target.id;
        await tx`UPDATE monitor_events SET withdrawn = true, updated_at = ${postAt} WHERE id = ${eventId}`;
        if (target.status === "announced") applied.notify.push({ eventId, action: "withdraw", postId });
      }
      changed.push(p);
      if (p.action !== "withdraw") await enrichEvent(tx, eventId, p, target?.presentation);
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
      SELECT id, outage FROM monitor_posts WHERE outage IS NOT NULL AND id <> ${postId}
        AND published_at >= ${new Date(postAt.getTime() - OUTAGE_LINK_MS)} AND published_at <= ${postAt}
      ORDER BY published_at DESC LIMIT 1`;
    if (open) {
      const patch: Record<string, unknown> = {};
      if (rec.outage === "recovery" && !open.outage.recoveredAt) patch.recoveredAt = postAt.toISOString();
      const announced = applied.notify.find((n) => n.action === "announce");
      if (announced && !open.outage.resetEventId) patch.resetEventId = announced.eventId;
      if (Object.keys(patch).length) await tx`UPDATE monitor_posts SET outage = outage || ${tx.json(patch as never)} WHERE id = ${open.id}`;
    }

    // The pushes this post owes are stored with it, in the same transaction: a push interrupted after
    // this commit is sent by the next tick (flushResetPushes), never lost.
    await tx`
      UPDATE monitor_posts SET translation = coalesce(${rec.relevant ? rec.translationZh : null}, translation), context = ${tx.json(context as never)},
        recognition = ${tx.json({ ...rec, modelResult, needsReview: held.length > 0, held: held.map((p) => ({ action: p.action, excerpt: p.excerpt, reason: reasons.get(p) ?? "事件依据存在冲突" })), notify: applied.notify } as never)},
        activity = coalesce(${activity ? tx.json(activity as never) : null}, activity),
        outage = coalesce(${outage ? tx.json(outage as never) : null}, outage), processed_at = now()
      WHERE id = ${postId}`;
    // The paid recognition is complete once its result is committed with the post.
    await completeReceipt(tx, rec.receiptId);
    await tx`INSERT INTO monitor_state (key, value) VALUES ('publication_revision', ${tx.json({ revision: randomUUID() })})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

    return applied;
  });
}
