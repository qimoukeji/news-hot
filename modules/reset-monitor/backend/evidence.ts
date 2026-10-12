import { monitor as currentMonitor, monitorId, purpose as requestPurpose, auditAction, auditSubject } from "./context.ts";
// Checks action evidence and time provenance; model recognition remains the source of propositions.
import type { ContextInput, Proposition } from "./recognize.ts";

const RESET = /\b(reset(?:s|ting)?|banked|usage limits?|rate limits?)\b/i;
const RELATIVE = /\b(tomorrow|today|tonight|this afternoon|this evening|in (?:the next )?(?:\d+|an?|one|few) (?:hours?|minutes?))\b/i;
const COMMITMENT = /\b(?:will|we['’]ll|i['’]ll|going to|has landed|have reset|reset will|resetting)\b/i;
const ANSWER = /^(?:@\w+\s+)*(?:(?:yes|yep|yeah|indeed|sure|absolutely|definitely|soon|shortly|tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|ok(?:ay)?[, ]+fine\b|of course\b|will do\b|not (?:so )?random[^.]*\byes\b|in (?:the next )?(?:\d+|an?|one|few) (?:hours?|minutes?)\b)/i;
export const retrospective = (excerpt: string) => /\b(last (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in the (?:middle|past)|previously|earlier|yesterday)\b/i.test(excerpt);

export function actionEvidence(p: Proposition, context: ContextInput[], earlier: Proposition[] = []): "action" | "related" | "review" {
  const parent = context.find((c) => c.relation === "reply");
  // A delivery explanation can confirm an existing round when both speakers explicitly say it applied.
  if (p.role === "explanation" && p.action === "confirm" && /\bwe (?:have )?applied (?:the )?resets?\b/i.test(p.excerpt)
    && parent && RESET.test(parent.text) && /\bapplied\b/i.test(parent.text)) return "action";
  if (p.role === "explanation" || p.role === "policy") return "related";
  if (p.action === "confirm" && parent && RESET.test(parent.text)
    && /\$|\b(?:api credits?|tokens?|dollars?)\b/i.test(parent.text) && !RESET.test(p.excerpt)
    && ANSWER.test(p.excerpt.trim())) return "review";
  if (p.role === "uncertain" || /\b(maybe|perhaps|surprise)\b/i.test(p.excerpt)) return "related";
  if (p.kind === "bonus_credit") {
    const reward = /\b(?:bonus|reward|promotional|one[ -]time)\s+(?:usage\s+)?credits?\b|奖励额度|獎勵額度/i;
    const action = /\b(?:claim|grant(?:ed|ing)?|giv(?:e|en|ing)|get|gets|receive[ds]?|available|opens?|offer(?:ing)?|will|added|redeem)\b|领取|領取|发放|發放|开放/i;
    if (p.action === "confirm" && /\b(?:will|soon|coming)\b/i.test(p.excerpt)
      && !/\b(?:can (?:still )?claim|claim now|now available|already (?:available|granted))\b|已开放|已發放|已发放/i.test(p.excerpt)) return "review";
    if (reward.test(p.excerpt) && action.test(p.excerpt)) return "action";
    if (parent && reward.test(parent.text) && action.test(parent.text) && ANSWER.test(p.excerpt.trim()) && p.excerpt.length <= 100) return "review";
    return p.real && (p.role === "action" || p.role === "answer" || !p.role) ? "review" : "related";
  }
  // A dated retrospective is usable; an undated one cannot become today's confirmation.
  if (p.action === "confirm" && !p.relatesTo && !p.statedTime
    && retrospective(p.excerpt)) return "review";
  if (p.action === "announce" && /^(?:@\w+\s+)*(?:if|unless)\b|\beither\b[^.]*\bor\b/i.test(p.excerpt.trim())) return "related";
  // Explaining why resets happen is not evidence that a new reset has completed.
  if (parent && /^\s*why\b[^?]*\bresets?\b/i.test(parent.text) && !RESET.test(p.excerpt) && !ANSWER.test(p.excerpt.trim())) return "related";
  // A definition answer cannot turn the ancestor's announcement into a fresh promise.
  if (p.action === "announce" && parent && /\b(?:what['’]s|what is|meaning of)\b[^?]*\breset\b/i.test(parent.text)
    && !COMMITMENT.test(p.excerpt)) return "related";
  if (p.action === "announce" && !RESET.test(p.excerpt)) {
    // "Another one" refers to a reset explicitly stated earlier in the same post.
    if (/\banother one\b/i.test(p.excerpt) && COMMITMENT.test(p.excerpt) && earlier.some((q) =>
      q.real && q.kind === p.kind && RESET.test(q.excerpt) && actionEvidence(q, context) === "action")) return "action";
    // A short answer can inherit the direct question. An unrelated ancestor is insufficient.
    if (!parent || !RESET.test(parent.text) || !ANSWER.test(p.excerpt.trim()) || p.excerpt.length > 100 || /\bif\b/i.test(p.excerpt)) return "related";
  }
  return "action";
}

export function timeSource(p: Proposition, input: { id: string; text: string; publishedAt: Date; context: ContextInput[] }): { proposition: Proposition; needsReview: boolean } {
  if (!p.statedTime) return { proposition: p, needsReview: false };
  let sourceId = p.timeSourceId;
  const parent = input.context.find((c) => c.relation === "reply");
  // Saved responses predating timeSourceId still carry the actual direct question and its timestamp.
  if ((!sourceId || sourceId === input.id) && parent && input.text.replace(/@\w+/g, "").trim().length <= 100 && !RELATIVE.test(input.text) && RELATIVE.test(parent.text)
    && (p.statedTime.dayOffset !== null || p.statedTime.relativeHours !== null || p.statedTime.period !== null)) sourceId = parent.id;
  if (!sourceId || sourceId === input.id) return { proposition: { ...p, timeSourceId: input.id }, needsReview: false };
  const source = input.context.find((c) => c.id === sourceId);
  const valid = source?.publishedAt && Number.isFinite(Date.parse(source.publishedAt)) && Date.parse(source.publishedAt) <= input.publishedAt.getTime();
  return { proposition: { ...p, timeSourceId: sourceId }, needsReview: !valid };
}
