/** Display an explicitly recorded quota cycle; an absent value stays unknown. */
export function quotaScopeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return ({ five_hour: "五小时额度", weekly: "周额度", "five_hour+weekly": "五小时及周额度" } as Record<string, string>)[value] ?? value;
}
