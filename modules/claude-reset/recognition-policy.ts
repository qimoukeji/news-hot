import type { Proposition } from "@aihot/reset-monitor/backend/recognize";

/** Credit pools are never reset cards; only the enabled one-time campaign becomes a reward event. */
export function excludeProposition(proposition: Proposition, sourceText: string, association?: { trustedEventKinds: readonly Proposition["kind"][] }): string | null {
  const quote = proposition.excerpt;
  if (proposition.kind !== "bonus_credit" && /\breset(?:s|ting)?\b|重置/i.test(quote)) return null;
  const credit = /\bcredits?\b/i.test(quote);
  const cloudBonus = /\b(?:one[ -]time|bonus)\s+credits?\b/i.test(quote) && /\bcloud\s+sessions?\b/i.test(sourceText);
  if (credit && (/\bAPI\s+credits?\b/i.test(quote) || !cloudBonus && /\bAPI\s+credits?\b/i.test(sourceText))) return "API 赠金不属于本监控的奖励活动、额度重置或重置卡";
  if (proposition.kind === "bonus_credit") {
    return cloudBonus || credit && association?.trustedEventKinds.includes("bonus_credit") ? null : "缺少明确的一次性云会话奖励活动证据";
  }
  if (credit && /\bbonus\s+credits?\b/i.test(sourceText) && /\bcloud\s+sessions?\b/i.test(sourceText)) {
    return "云会话赠额是独立消费池，不是额度重置或可兑换的重置次数";
  }
  return null;
}
