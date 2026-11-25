import type { ContextInput, Proposition } from "./recognize.ts";

/** Literal excerpts are compared without typography and whitespace differences. */
export function quotedInPost(excerpt: string, post: string): boolean {
  const loose = (text: string) => ` ${text.normalize("NFKC").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const parts = excerpt.split(/…|\.\.\./).map(loose).filter(part => part.trim());
  return parts.length > 0 && parts.every(part => loose(post).includes(part));
}

export type TextSpan = { start: number; end: number };

export function scopeText(text: string): string {
  return text.normalize("NFKC").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/https?:\/\/[^\s<>"']+/gi, url => " ".repeat(url.length));
}

export function literalPattern(text: string): string {
  return text.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
}

// English catalog names can touch Chinese or Japanese prose without a space.
export const scopeWordChars = "\\p{Script=Latin}\\p{Script=Cyrillic}\\p{N}\\p{M}_";

export function literalScopeSpans(excerpt: string, source: string): TextSpan[] {
  const pattern = literalPattern(scopeText(excerpt));
  if (!pattern) return [];
  return [...source.matchAll(new RegExp(`(?<![${scopeWordChars}])${pattern}(?![${scopeWordChars}])`, "giu"))]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}

/** Scope quotes may compose literal spans, but may not discard symbols within them. */
export function scopeQuoteSpans(excerpt: string, source: string): TextSpan[] {
  const parts = excerpt.split(/[…;；]|\.\.\./).map(part => literalScopeSpans(part, source));
  return parts.every(part => part.length) ? parts.flat() : [];
}

export function quotedScopeInPost(excerpt: string, post: string): boolean {
  return scopeQuoteSpans(excerpt, scopeText(post)).length > 0;
}

/** Read literal counters only; the recognizer must still establish their event and meaning. */
export function bankedRoundCounts(excerpt: string): { completed: number; total: number } | null {
  const match = /\bbanked\s+(\d+)\s*\/\s*(\d+)\b/i.exec(excerpt);
  if (!match) return null;
  const completed = Number(match[1]), total = Number(match[2]);
  return Number.isSafeInteger(completed) && Number.isSafeInteger(total) ? { completed, total } : null;
}

const reset = /\b(reset(?:s|ting)?|banked|usage limits?|rate limits?)\b|重置/i;
const answer = /^(?:@\w+\s+)*(?:yes|yep|yeah|indeed|absolutely|definitely|ok(?:ay)?[, ]+fine|of course|will do)\b/i;

/** Only the outer source can assert an action; embedded quotes may identify its explicit object. */
export function actionEvidence(proposition: Proposition, context: ContextInput[], earlier: Proposition[] = []): "action" | "related" | "review" {
  const p = proposition, quote = p.excerpt;
  if (!p.real || ["explanation", "policy", "uncertain"].includes(p.role ?? "") || /\b(?:maybe|perhaps|surprise)\b/i.test(quote)) return "related";
  if (p.action === "announce" && /^(?:@\w+\s+)*(?:if|unless)\b|\beither\b[^.]*\bor\b/i.test(quote.trim())) return "related";
  if (p.kind === "bonus_credit") {
    const reward = /\b(?:bonus|reward|promotional|one[ -]time)\s+(?:usage\s+)?credits?\b|奖励额度|獎勵額度/i;
    const action = /\b(?:claim(?:ing|s)?|reopen(?:ed|s)?|restor(?:ed|e)|reinstated|back on|grant(?:ed|ing)?|giv(?:e|en|ing)|get|gets|receive[ds]?|available|opens?|offer(?:ing)?|will|added|redeem|closed|ended|expired|cancelled|canceled)\b|领取|領取|发放|發放|开放|关闭|到期|取消|恢复安排|恢復安排/i;
    if (reward.test(quote) && action.test(quote)) return "action";
    if (p.eventId && ["amend", "progress"].includes(p.action) && action.test(quote)) return "action";
    return "review";
  }
  if (p.action === "announce" && !reset.test(quote)) {
    if (p.eventId && /\b(?:land(?:s|ing)?|arriv(?:e|es|ing)|will|coming|by)\b|将于|將於|生效/i.test(quote)) return "action";
    if (/\banother one\b/i.test(quote) && /\b(?:will|coming|lands?)\b/i.test(quote)
      && earlier.some(prior => prior.real && prior.kind === p.kind && (prior.action === "confirm" || reset.test(prior.excerpt)))) return "action";
    const quotedReset = context.some(source => reset.test(source.text));
    return quotedReset && answer.test(quote.trim()) && quote.length <= 100 ? "action" : "related";
  }
  return "action";
}
