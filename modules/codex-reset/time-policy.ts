import { pacificToUtc, pacificParts, beijingRange, type Estimate, type EstimateBasis, type Schedule, type StatedTime, type StatedWords } from "@aihot/reset-monitor/backend/time";
const HOUR = 3600_000;

/** Tibo usually presses the button 16:30–21:30 Pacific (07:30–12:30 Beijing the next morning). */
const USUAL_FROM = "16:30";
const USUAL_TO = "21:30";

function makeEstimate(from: Date, through: Date, basis: EstimateBasis, reason: string): Estimate {
  return { from: from.toISOString(), through: through.toISOString(), basis, label: `北京时间 ${beijingRange(from, through)}`, reason };
}

/**
 * The site's landing window for an unconfirmed announcement. A model window is accepted only when it
 * is well-formed and stays inside the stated window; otherwise the stated time or his usual timing
 * is used. A predicted delay cannot extend Tibo's own deadline.
 */
export function estimate(opts: { schedule: Schedule | null; announcedAt: Date; model?: { earliestPacific: string; latestPacific: string; note: string } | null }): Estimate {
  const { schedule, announcedAt, model } = opts;
  if (model) {
    const parse = (s: string) => {
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(s.trim());
      return m ? pacificToUtc(m[1]!, m[2]!) : null;
    };
    const a = parse(model.earliestPacific);
    const b = parse(model.latestPacific);
    const sane = a && b && b > a && b.getTime() - a.getTime() <= 36 * HOUR && a >= announcedAt;
    const tolerance = schedule?.precision === "approximate" ? HOUR / 2 : 0;
    const consistent = !schedule || (a && b && b.getTime() <= Date.parse(schedule.through) + tolerance
      && (schedule.precision === "deadline" || a.getTime() >= Date.parse(schedule.from) - tolerance));
    if (sane && consistent) return makeEstimate(a!, b!, "model", `模型推算：${model.note}`);
  }
  if (schedule && schedule.precision === "date") {
    const day = pacificParts(new Date(schedule.from)).date;
    return makeEstimate(pacificToUtc(day, USUAL_FROM), pacificToUtc(day, USUAL_TO), "source_day", "Tibo 只给了日期，按他以往的习惯落在当天太平洋时间傍晚。");
  }
  if (schedule && schedule.precision === "deadline") {
    // "Within the hour", "by 8pm": from the announcement (at most a day ahead) to that deadline.
    const deadline = new Date(schedule.through).getTime();
    const from = Math.min(Math.max(announcedAt.getTime(), deadline - 24 * HOUR), deadline);
    return makeEstimate(new Date(from), new Date(deadline), "source", "按原帖给出的截止时间换算成北京时间，不延长作者承诺的窗口。");
  }
  if (schedule) {
    // Around a time gets a half-hour window; explicit ranges retain their stated endpoints.
    const start = new Date(schedule.from).getTime();
    const from = schedule.precision === "approximate" ? Math.max(announcedAt.getTime(), start - HOUR / 2) : start;
    const through = new Date(Date.parse(schedule.through) + (schedule.precision === "approximate" ? HOUR / 2 : 0));
    return makeEstimate(new Date(from), through, "source", schedule.precision === "approximate" ? "按原帖时间换算成北京时间；约数按前后半小时展示。" : "按原帖明确给出的钟点或区间换算，不扩展时间范围。");
  }
  // No time given: the next usual evening after the announcement.
  const p = pacificParts(announcedAt);
  let day = p.date;
  if (p.hm > USUAL_TO) {
    const next = new Date(pacificToUtc(day, "12:00").getTime() + 24 * HOUR);
    day = pacificParts(next).date;
  }
  const from = pacificToUtc(day, USUAL_FROM);
  return makeEstimate(from < announcedAt ? announcedAt : from, pacificToUtc(day, USUAL_TO), "history", "原帖没有给出时间，按 Tibo 以往按下重置的时段推算。");
}


const addPacificDays = (date: string, days: number) => pacificParts(new Date(pacificToUtc(date, "12:00").getTime() + days * 24 * HOUR)).date;
const hhmm = (d: Date) => pacificParts(d).hm;

/** Turns the recognizer's words into a Pacific wall-clock statement, doing the arithmetic in code. */
export function resolve(w: StatedWords, postAt: Date): StatedTime | null {
  const post = pacificParts(postAt);
  const day = w.dayOffset ? addPacificDays(post.date, w.dayOffset) : post.date;
  if (w.relativeHours !== null && w.relativeHours > 0) {
    const at = new Date(postAt.getTime() + w.relativeHours * HOUR);
    return { precision: w.precision === "approximate" ? "approximate" : "deadline", date: pacificParts(at).date, from: hhmm(at), through: null };
  }
  if (w.period) {
    if (w.period === "end_of_day") return { precision: "deadline", date: day, from: "24:00", through: null };
    const [start, end] = w.period === "afternoon" ? ["12:00", "18:00"] : w.period === "evening" ? ["17:00", "21:00"] : ["18:00", "23:59"];
    const from = day === post.date && post.hm > start! ? post.hm : start!;
    return { precision: "window", date: day, from, through: end! };
  }
  if (w.clock) {
    if (w.clockThrough) return { precision: "window", date: day, from: w.clock, through: w.clockThrough };
    // "by 8pm" stays a deadline and "around 2:30pm" approximate; a plain clock time ("landing 2:30pm")
    // is shown as the hour after it.
    const precision = w.precision === "deadline" || w.precision === "approximate" ? w.precision : "exact";
    return { precision, date: day, from: w.clock, through: null };
  }
  if (w.precision === "date" && w.dayOffset !== null) return { precision: "date", date: day, from: null, through: null };
  return null;
}
