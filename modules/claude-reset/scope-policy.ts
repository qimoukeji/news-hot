/** Quota cycles are different resources even for the same subscription plan. */
export function quotaScope(input: { audienceSource: string | null; productsZh: string | null }, evidence?: { excerpt: string; kind: string }): string | null {
  if (evidence?.kind === "bonus_credit") return null;
  // Only the clauses saying what is reset supply cycle evidence; nearby increases cannot do so.
  const actionWords = evidence?.excerpt.split(/[\n.!?;]|\band\b(?=\s+(?:we|your)\b)/i)
    .filter((part) => /\breset(?:s|ting)?\b|重置/i.test(part)).join(" ") ?? "";
  const text = evidence ? actionWords : `${input.audienceSource ?? ""} ${input.productsZh ?? ""}`;
  const fiveHour = /\b(?:5\s*[- ]?\s*h(?:ours?|rs?)?|five\s*[- ]?\s*hours?)\b|(?:5|五)\s*(?:小时|小時)/i.test(text);
  const weekly = /\b(?:weekly|week(?:ly)?[- ](?:usage|limits?|quota)|7[- ]days?)\b|周(?:额度|額度|限额|限額|用量)|每周|每週|(?:一|1|七|7)\s*(?:周|週|天)/i.test(text);
  return fiveHour && weekly ? "five_hour+weekly" : fiveHour ? "five_hour" : weekly ? "weekly" : null;
}
