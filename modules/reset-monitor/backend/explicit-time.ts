import { pacificParts, wallTimeToUtc, type StatedTime, type StatedWords } from "./time.ts";

const HOUR = 3600_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 24 * HOUR).toISOString().slice(0, 10);

const numberWords: Record<string, number> = {
  a: 1, an: 1, the: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
  half: 0.5, quarter: 0.25, couple: 2,
};
function numberOf(value: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const parts = value.toLowerCase().split(/[ -]/);
  return parts.every((part) => numberWords[part] !== undefined) ? parts.reduce((sum, part) => sum + numberWords[part]!, 0) : null;
}

/** Relative times need a stated quantity, not a model's interpretation of "soon" or "a few". */
function hasRelativeHours(text: string, hours: number): boolean {
  for (const match of text.matchAll(/\b(?:in|within|after|over)\s+(?:the\s+next\s+|next\s+)?(?:(?:about|around|approximately|roughly)\s+)?(?:a\s+(?=(?:couple|quarter)\b))?(\d+(?:\.\d+)?|[a-z]+(?:-[a-z]+)?)(?:\s+(?:an?|of))?\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi)) {
    const count = numberOf(match[1]!);
    if (count !== null && Math.abs(count / (/^m/i.test(match[2]!) ? 60 : 1) - hours) < 1e-9) return true;
  }
  const next = /\b(?:within|in|over)\s+(?:the\s+)?next\s+(hour|minute)\b/i.exec(text);
  if (next && Math.abs((next[1]!.toLowerCase() === "hour" ? 1 : 1 / 60) - hours) < 1e-9) return true;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?|[一二两三四五六七八九十半])\s*(小时|分鐘|分钟)\s*(?:后|後|内|內|之内|之內)/g)) {
    const chinese: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
    const count = chinese[match[1]!] ?? Number(match[1]);
    if (Math.abs(count / (match[2] === "小时" ? 1 : 60) - hours) < 1e-9) return true;
  }
  return false;
}

function hasTimezone(text: string, timezone: string): boolean {
  const names: Record<string, RegExp> = {
    UTC: /\b(?:UTC|GMT)\b(?!\s*[+-])|\d{2}:\d{2}(?::\d{2})?Z\b/i,
    GMT: /\b(?:UTC|GMT)\b(?!\s*[+-])/i,
    PT: /\bPT\b|\bPacific Time\b/i,
    PST: /\bPST\b|\bPacific Standard Time\b/i,
    PDT: /\bPDT\b|\bPacific Daylight Time\b/i,
  };
  if (names[timezone]) return names[timezone]!.test(text);
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(timezone);
  return !!match && new RegExp(`\\${match[1]}${match[2]}:?${match[3]}(?!\\d)`).test(text);
}

function hasClock(text: string, clock: string): boolean {
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  const sourceHour = hour < 10 ? `0?${hour}` : String(hour);
  if (new RegExp(`(?<!\\d)${sourceHour}:?${String(minute).padStart(2, "0")}(?!\\d)`).test(text)) return true;
  const twelve = hour % 12 || 12;
  const suffix = hour >= 12 ? "p\\.?m\\.?" : "a\\.?m\\.?";
  const minutes = minute ? `:${String(minute).padStart(2, "0")}` : "(?::00)?";
  return new RegExp(`(?<!\\d)${twelve < 10 ? `0?${twelve}` : twelve}${minutes}\\s*${suffix}(?![a-z])`, "i").test(text);
}

/** An absent date is undefined; a stated date with an unknown year is null. */
function statedDay(text: string, reference: string): string | null | undefined {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1];
  if (iso) return iso;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const named = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i.exec(text);
  if (named) return named[3] ? `${named[3]}-${String(months.indexOf(named[1]!.slice(0, 3).toLowerCase()) + 1).padStart(2, "0")}-${named[2]!.padStart(2, "0")}` : null;
  if (/\b(?:day after tomorrow)\b|后天|後天/i.test(text)) return addDays(reference, 2);
  if (/\btomorrow\b|明天/i.test(text)) return addDays(reference, 1);
  if (/\btoday\b|今天/i.test(text)) return reference;
  return undefined;
}

export function resolve(words: StatedWords, postAt: Date, sourceText?: string): StatedTime | null {
  if (words.relativeHours !== null && words.relativeHours > 0) {
    if (sourceText !== undefined && !hasRelativeHours(sourceText, words.relativeHours)) return null;
    const instant = new Date(postAt.getTime() + words.relativeHours * HOUR);
    return { precision: words.precision, date: instant.toISOString().slice(0, 10), from: instant.toISOString().slice(11, 16), through: null, timezone: "UTC" };
  }
  const timezone = words.timezone;
  if (!timezone || !/^(?:UTC|GMT|PT|PST|PDT|[+-]\d{2}:\d{2})$/.test(timezone)) return null;
  if (/^[+-]/.test(timezone) && (Number(timezone.slice(1, 3)) > 23 || Number(timezone.slice(4)) > 59)) return null;
  if (sourceText !== undefined && !hasTimezone(sourceText, timezone)) return null;
  for (const clock of [words.clock, words.clockThrough]) {
    if (!clock) continue;
    const [hour, minute] = clock.split(":").map(Number);
    if (hour === undefined || minute === undefined || hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return null;
  }
  let day: string;
  if (timezone === "PT") day = pacificParts(postAt).date;
  else {
    const midnight = wallTimeToUtc(postAt.toISOString().slice(0, 10), "00:00", timezone);
    const offset = Date.parse(`${postAt.toISOString().slice(0, 10)}T00:00:00Z`) - midnight.getTime();
    day = new Date(postAt.getTime() + offset).toISOString().slice(0, 10);
  }
  if (sourceText !== undefined) {
    const evidenceDay = statedDay(sourceText, day);
    if (evidenceDay === null) return null;
    const requestedDay = words.date ?? addDays(day, words.dayOffset ?? 0);
    if (requestedDay !== (evidenceDay ?? day)) return null;
    if (words.clock && !hasClock(sourceText, words.clock)) return null;
    if (words.clockThrough && !hasClock(sourceText, words.clockThrough)) return null;
    if (words.precision === "date" && !evidenceDay) return null;
  }
  day = words.date ?? addDays(day, words.dayOffset ?? 0);
  const parsedDay = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) return null;
  if (words.clock) return { precision: words.clockThrough ? "window" : words.precision, date: day, from: words.clock, through: words.clockThrough, timezone };
  if (words.precision === "date" && (words.date || words.dayOffset !== null)) return { precision: "date", date: day, from: null, through: null, timezone };
  // Named periods and hedged phrases have no exact window in the announcement.
  return null;
}
export const estimate = () => null;
