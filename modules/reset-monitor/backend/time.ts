import { monitor as currentMonitor } from "./context.ts";
// Source time conversion and shared Beijing formatting. Each module supplies its time policy.

const PACIFIC = "America/Los_Angeles";
const HOUR = 3600_000;

/** UTC instant of a Pacific wall-clock time ("2026-09-25", "18:00"). */
export function pacificToUtc(date: string, time: string): Date {
  if (time === "24:00") {
    // "end of day": midnight at the end of that Pacific date
    const next = new Date(Date.UTC(...(date.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number]) + 36 * HOUR);
    return pacificToUtc(next.toISOString().slice(0, 10), "00:00");
  }
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h + 8, mi); // PST
  for (const offset of [8, 7]) {
    const t = Date.UTC(y, mo - 1, d, h + offset, mi);
    if (pacificParts(new Date(t)).hm === `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` && pacificParts(new Date(t)).date === date) return new Date(t);
  }
  return new Date(guess);
}

export function pacificParts(d: Date): { date: string; hm: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hm: `${get("hour")}:${get("minute")}`, hour: Number(get("hour")) };
}

const bj = (d: Date) => new Date(d.getTime() + 8 * HOUR);
const md = (d: Date) => `${bj(d).getUTCMonth() + 1}月${bj(d).getUTCDate()}日`;
const hm = (d: Date) => bj(d).toISOString().slice(11, 16);

/** "9月8日 09:00–10:00" or "9月22日 15:00–9月23日 15:00" in Beijing time. */
export function beijingRange(from: Date, through: Date): string {
  if (from.getTime() === through.getTime()) return `${md(from)} ${hm(from)}`;
  const sameDay = bj(from).toISOString().slice(0, 10) === bj(through).toISOString().slice(0, 10);
  return sameDay ? `${md(from)} ${hm(from)}–${hm(through)}` : `${md(from)} ${hm(from)}–${md(through)} ${hm(through)}`;
}

export type SchedulePrecision = "exact" | "approximate" | "deadline" | "date" | "window";

/** Source wall-clock time. A missing timezone retains the legacy Pacific policy. */
export interface StatedTime {
  timezone?: string;
  precision: SchedulePrecision;
  /** Source-local date the statement refers to. */
  date: string;
  /** Source-local time or window start. Null for date-only. */
  from: string | null;
  /** Source-local window end when the author gave a range. */
  through: string | null;
}

export interface Schedule {
  precision: SchedulePrecision;
  from: string;
  through: string;
  label: string;
}

/** Converts the monitored author's own words into Beijing time. Kept after completion; never an execution receipt. */
export function scheduleFrom(stated: StatedTime): Schedule {
  if (stated.precision === "date") {
    // A whole Pacific day.
    const from = wallTimeToUtc(stated.date, "00:00", stated.timezone);
    const through = new Date(wallTimeToUtc(stated.date, "23:59", stated.timezone).getTime() + 60_000);
    return { precision: "date", from: from.toISOString(), through: through.toISOString(), label: `北京时间预计 ${beijingRange(from, through)}` };
  }
  const start = wallTimeToUtc(stated.date, stated.from ?? "18:00", stated.timezone);
  if (stated.precision === "deadline") {
    return { precision: "deadline", from: start.toISOString(), through: start.toISOString(), label: `北京时间预计 ${md(start)} ${hm(start)} 前` };
  }
  if (stated.precision === "approximate") {
    return { precision: "approximate", from: start.toISOString(), through: start.toISOString(), label: `北京时间约 ${md(start)} ${hm(start)}` };
  }
  // A clock time is a point; only an explicitly stated range has a second endpoint.
  const end = stated.through ? wallTimeToUtc(stated.through < (stated.from ?? "18:00") ? addPacificDays(stated.date, 1) : stated.date, stated.through, stated.timezone) : start;
  return { precision: stated.precision, from: start.toISOString(), through: end.toISOString(), label: `北京时间预计 ${beijingRange(start, end)}` };
}

export type EstimateBasis = "model" | "source" | "source_day" | "history";

export interface Estimate {
  from: string;
  through: string;
  basis: EstimateBasis;
  label: string;
  reason: string;
}

/** What the recognizer extracted: relative hours, a named period, a clock time and/or a day offset. */
export interface StatedWords {
  timezone?: string | null;
  date?: string | null;
  precision: SchedulePrecision;
  relativeHours: number | null;
  period: "afternoon" | "evening" | "tonight" | "end_of_day" | null;
  clock: string | null;
  clockThrough: string | null;
  dayOffset: number | null;
}

/** A schedule an operator entered in Beijing time (admin corrections). */
export function manualSchedule(precision: SchedulePrecision, from: Date, through: Date): Schedule {
  if (precision === "deadline") return { precision, from: from.toISOString(), through: from.toISOString(), label: `北京时间预计 ${md(from)} ${hm(from)} 前` };
  if (precision === "approximate") return { precision, from: from.toISOString(), through: from.toISOString(), label: `北京时间约 ${md(from)} ${hm(from)}` };
  const end = precision === "exact" ? from : through;
  return { precision, from: from.toISOString(), through: end.toISOString(), label: `北京时间预计 ${beijingRange(from, end)}` };
}

function addPacificDays(date: string, days: number) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * 24 * HOUR).toISOString().slice(0, 10); }

export function wallTimeToUtc(date: string, time: string, timezone = PACIFIC): Date {
  if (timezone === PACIFIC || timezone === "PT") return pacificToUtc(date, time);
  if (time === "24:00") return wallTimeToUtc(addPacificDays(date, 1), "00:00", timezone);
  const offset = timezone === "UTC" || timezone === "GMT" ? "Z" : timezone === "PST" ? "-08:00" : timezone === "PDT" ? "-07:00" : timezone;
  if (!/^(?:Z|[+-]\d{2}:\d{2})$/.test(offset)) throw new Error("Unsupported explicit source timezone");
  const result = new Date(`${date}T${time}:00${offset}`);
  if (!Number.isFinite(result.getTime())) throw new Error("Invalid explicit source time");
  return result;
}

export function resolveStatedTime(words: StatedWords, postAt: Date, sourceText?: string, inferred = false): StatedTime | null {
  if (currentMonitor().timePolicy === "explicit" && inferred) return null;
  return currentMonitor().timing.resolve(words, postAt, sourceText);
}
export function estimateFor(input: { schedule: Schedule | null; announcedAt: Date; model?: { earliestPacific: string; latestPacific: string; note: string } | null }): Estimate | null { return currentMonitor().timing.estimate(input); }
