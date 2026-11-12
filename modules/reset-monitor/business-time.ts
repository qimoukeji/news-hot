import type { BusinessTime } from "./public-v2.ts";

export function formatBusinessTime(value: BusinessTime | null | undefined, locale = "zh-CN", timeZone = "Asia/Shanghai", options: { dateOnly?: boolean } = {}): string {
  if (!value) return ({ en: "Time not announced", zh: "时间未公布", ja: "日時未発表", ko: "시간 미발표", ru: "Время не объявлено", es: "Hora sin anunciar" }[locale.split("-")[0]!] ?? "Time not announced");
  const calendar: Intl.DateTimeFormatOptions = options.dateOnly ? { month: "short", day: "numeric" } : { year: "numeric", month: "2-digit", day: "2-digit" };
  const instant = (at: string) => new Intl.DateTimeFormat(locale, { ...calendar, ...(!options.dateOnly && { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" as const }), timeZone }).format(new Date(at));
  if (value.kind === "range") return `${instant(value.from)} – ${instant(value.through)}`;
  if (value.kind === "deadline") {
    const before: Record<string, string> = { en: "Before", zh: "截止", ja: "期限", ko: "마감", ru: "До", es: "Antes de" };
    return `${before[locale.split("-")[0]!] ?? before.en} ${instant(value.at)}`;
  }
  return instant(value.at);
}
