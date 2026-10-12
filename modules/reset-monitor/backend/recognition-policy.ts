import type { Proposition } from "./recognize.ts";

/** Inspect the proposition's own evidence; unrelated clauses cannot suppress an official action. */
export function excludeNonEvent(p: Proposition): string | null {
  const quote = p.excerpt;
  const apiCredit = /\bapi\s+(?:credits?|tokens?|bonus|reward)|\b(?:credits?|bonus|reward)\s+(?:for\s+(?:the\s+)?)?api\b/i;
  const recurring = /\bevery\s+(?:day|week|month|\d+\s+hours?)\b|每天|每周|每月|\b(?:normally|usually|routine|scheduled)\b/i;
  const clauses = quote.split(/[\n.!?;]|\band\b/i);
  const explicitResetClause = p.kind !== "bonus_credit" && p.real && clauses.some(clause =>
    /\breset(?:s|ting)?\b|重置/i.test(clause) && !apiCredit.test(clause) && !recurring.test(clause));
  if (explicitResetClause) return null;
  if (apiCredit.test(quote)) return "API 赠金不属于产品额度事件";
  // A recurring compensation policy can also announce its first concrete card grant.
  // Keep that grant only when the quote itself names both issuance and its first landing time.
  const firstCardGrant = p.kind === "reset_credit" && p.real && ["announce", "progress", "confirm"].includes(p.action)
    && /\b(?:give|grant|credit|issue|send|load)\b[^.!?]*\b(?:banked\s+reset|reset\s+(?:card|credit))\b/i.test(quote)
    && /\bfirst\s+(?:one|card|reset(?:\s+credit)?)\b[^.!?]*\b(?:land|arrive|be\s+(?:issued|granted|loaded))\b[^.!?]*(?:\b\d+\s*(?:minutes?|hours?|days?)\b|\b(?:today|tomorrow|now)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b)/i.test(quote);
  if (firstCardGrant) return null;
  const oneTime = /\b(?:one[ -]time|compensation|compensat(?:e|ion)|this time)\b|一次性|补偿/i.test(quote);
  if (p.kind !== "bonus_credit" && /\b(?:automatically|every\s+(?:day|week|month|\d+\s+hours?))\b|每天|每周|每月/i.test(quote) && !oneTime) {
    // Automatic propagation of a specific reset is an action, not a recurring policy.
    const executed = /\b(?:we\s+(?:have\s+)?(?:applied|reset|restored)|has\s+(?:landed|been\s+reset)|have\s+been\s+reset|all\s+propagated)\b/i.test(quote);
    if (recurring.test(quote) || !executed && !p.real) return "日常自动重置规则不生成事件";
  }
  if (/\b(?:increas(?:e[ds]?|ing)|doubl(?:e[ds]?|ing)|rais(?:e[ds]?|ing))\b[^.]*\b(?:limits?|caps?)\b|(?:提高|翻倍|增加)(?:额度|限额|上限)/i.test(quote)
    && !/\breset(?:s|ting)?\b|重置|\b(?:one[ -]time|bonus|reward|promotional)\s+(?:usage\s+)?credits?\b|一次性.*(?:奖励|额度)/i.test(quote)) return "普通额度提升不生成事件";
  return null;
}
