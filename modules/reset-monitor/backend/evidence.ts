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

const accountArrival = /(?:\s*,\s*|\s+(?:and|but)\s+)(?=(?:(?:it|they)\s+)?(?:should|will|(?:is|are) expected to)\s+(?:land|arrive|appear|show up)\s+(?:in|on)\b)|[，,]\s*(?=(?:预计|預計|等待|等候)[^，,。]*到[账帳賬])/i;
const activatedResetCredit = /\b(?:banked resets?|reset (?:credits?|cards?))\s+(?:(?:has|have)\s+(?:(?:already|just)\s+)?been|is|are|was|were)\s+(?:(?:already|just|now)\s+)?activated\b|(?:重置卡|(?:存储|儲存|可存储|可儲存)重置)(?:已经|已經|已)\s*(?:激活|啟用|启用)/i;

/** Inspect the completed assertion rather than an adjacent question or usage instruction. */
export function confirmsCompletedAction(excerpt: string, verifiedBankedEvent = false, kind?: Proposition["kind"]): boolean {
  const clauses = excerpt.match(/[^.!?。！？;；\n]+[.!?。！？;；]?/g) ?? [];
  const isCompletedAssertion = (clause: string) => {
    if (/[?？]/.test(clause) || /\b(?:will|would|should|soon|coming|tomorrow|scheduled|planned|expected|if|unless|maybe|perhaps|might|could|not|never|haven['’]t|hasn['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|didn['’]t|can['’]t|won['’]t)\b|尚未|还未|還未|没有|沒有|并未|並未|将会|將會|如果/i.test(clause)) return false;
    if (/\b(?:feel(?:ing)?|felt|slept|sleep|youth)\b|感觉|感覺|睡醒/i.test(clause)) return false;
    if (/\b(?:my|mine)\b|我的/i.test(clause)) return false;
    if (/\bi\b|我已/i.test(clause) && !/\b(?:all\s+(?:users|accounts|subscriptions)|everyone|users)\b|所有|全部|用户|用戶/i.test(clause)) return false;
    return true;
  };
  // Activation is a fact about the card; account delivery can still be in the future.
  if (kind === "reset_credit" && clauses.some(clause => {
    if (/[?？]/.test(clause)) return false;
    const activation = clause.split(accountArrival, 1)[0]!;
    return activatedResetCredit.test(activation) && isCompletedAssertion(activation)
      && !/\b(?:no|once|when|after|later|next)\b|(?:一旦|只要|等到|待到|才会|才會|才可|之后|之後|后才|後才|下周|下週)/i.test(activation);
  })) return true;
  const completedClauses = clauses.filter(isCompletedAssertion);
  // Present distribution plus present redemption establishes delivery, not a reset of usage.
  if (kind === "reset_credit"
    && completedClauses.some(clause => /\bwe(?:['’]re|\s+are)\s+(?:giving|issuing|granting)\b/i.test(clause) && /\bresets?\b|重置/i.test(clause)
      && !/\b(?:after|once|when|starting|next|later)\b|\b(?:no|zero|0)\s+(?:(?:more|additional|further)\s+)?reset(?:\s+credit)?s?\b/i.test(clause))
    && completedClauses.some(clause => /\b(?:use|redeem)\s+(?:them|these|(?:your|the)\s+(?:reset\s+)?credits?)\b/i.test(clause)
      && /\b(?:now|anytime|any\s+time)\b/i.test(clause)
      && !/\b(?:after|once|when|starting|from|later|next)\b/i.test(clause))
    && !clauses.some(clause => !/[?？]/.test(clause) && /\b(?:use|redeem|available|unavailable|usable|redeemable)\b|可用|可使用|可兑换|可兌換/i.test(clause)
      && /\b(?:unavailable|not|never|cannot|can['’]t|isn['’]t|aren['’]t|won['’]t|will|soon|tomorrow|after|once|when|starting|next|later)\b|尚未|还未|還未|无法|無法/i.test(clause))) return true;
  return completedClauses.some(clause => {
    const quotaObject = /\b(?:resets?|usage|limits?|quotas?|credits?|rewards?|banked)\b|额度|額度|重置|奖励|獎勵/i.test(clause);
    // Discourse connectors do not change the assertion; its negation and ownership checks stay above.
    const assertion = clause.replace(/^\s*(?:(?:and|but|now|so|yes|well|indeed)\b[,\s]*)+/i, "");
    const generic = /^\s*(?:(?:it|this|that)(?:['’]s|\s+(?:is|has\s+been))?\s+)?(?:confirmed\s+)?(?:all\s+)?(?:done(?:\s+and\s+dusted)?|completed|landed|propagated|(?:now\s+)?available)(?:\s+(?:across|for|to)\s+(?:all\s+)?(?:accounts|users|everyone))?\s*[.!。！;；]?\s*$/i.test(assertion);
    if (!quotaObject && !generic) return false;
    if (generic && clauses.some(other => !/[?？]/.test(other) && /\b(?:reset|usage|limits?|quotas?|credits?)\b|重置|额度|額度/i.test(other)
      && /\b(?:will|would|should|not|never|scheduled|tomorrow)\b|尚未|如果/i.test(other))) return false;
    // Only validate a model-selected confirmation of a verified event; never select or create a round here.
    const banked = verifiedBankedEvent && bankedRoundCounts(clause);
    if (banked && banked.completed > 0 && banked.completed <= banked.total) return true;
    return /\b(?:restored|completed|done|landed|propagated|available|claimable|opened|granted|issued|credited|added|distributed|delivered)\b|\b(?:we(?:['’]ve|\s+have)?\s+reset|(?:has|have|was|were|is|are)\s+(?:been\s+)?(?:now\s+)?reset|(?:usage|limits?|quotas?|all)\s+reset|reset\s+(?:usage|limits?|quotas?|all|everyone|for\s+(?:all|everyone|paid)))\b|已(?:完成|重置|恢复|恢復|发放|發放|开放|開放|生效)|可(?:领取|領取)/i.test(clause);
  });
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
    if (p.eventId && p.action === "confirm" && confirmsCompletedAction(quote)) return "action";
    if (p.eventId && ["amend", "progress"].includes(p.action) && action.test(quote)) return "action";
    return "review";
  }
  if (p.action === "announce" && !reset.test(quote)) {
    if (p.eventId && /\b(?:land(?:s|ing)?|arriv(?:e|es|ing)|will|coming|by)\b|将于|將於|生效/i.test(quote)) return "action";
    if (/\banother one\b/i.test(quote) && /\b(?:will|coming|lands?)\b/i.test(quote)
      && earlier.some(prior => prior.real && prior.kind === p.kind && reset.test(prior.excerpt))) return "action";
    const quotedReset = context.some(source => reset.test(source.text));
    return quotedReset && answer.test(quote.trim()) && quote.length <= 100 ? "action" : "related";
  }
  return "action";
}
