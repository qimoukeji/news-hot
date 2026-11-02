import type { BusinessTime } from "./public-v2.ts";

export function formatBusinessTime(value: BusinessTime | null | undefined, locale = "zh-CN", timeZone = "Asia/Shanghai"): string {
  if (!value) return "—";
  const date = (at: string) => new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(new Date(`${at}T00:00:00Z`));
  const instant = (at: string) => new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone }).format(new Date(at));
  if (value.kind === "date") return `${date(value.date)}${value.timeZone === timeZone ? "" : ` (${value.timeZone})`}`;
  if (value.kind === "range") return `${instant(value.from)} – ${instant(value.through)}`;
  if (value.kind === "deadline") {
    const before: Record<string, string> = { en: "Before", zh: "截止", ja: "期限", ko: "마감", ru: "До", es: "Antes de" };
    return `${before[locale.split("-")[0]!] ?? before.en} ${instant(value.at)}`;
  }
  return instant(value.at);
}

