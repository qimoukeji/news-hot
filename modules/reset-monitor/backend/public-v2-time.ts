import { Temporal } from "@js-temporal/polyfill";
import type { EventTime } from "../public-v2.ts";
type PublicV2PostRow = { text: string; published_at: Date | string };

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const namedClock = (text: string) => text.replace(/\bmidnight\b/gi, "12am").replace(/\bnoon\b/gi, "12pm");
const monthPattern = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const datePattern = `(?:${monthPattern}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2})`;
const zoneToken = "(?:(?:UTC|GMT)\\s*[+-]\\s*\\d{1,2}(?::?\\d{2})?(?![\\d:])|(?:UTC|GMT)(?!\\s*[+-])|[A-Za-z_]+/[A-Za-z_]+(?:/[A-Za-z_]+)?|(?:Pacific|Eastern)(?:\\s+(?:Standard|Daylight))?\\s+Time|PST|PDT|PT|EST|EDT|ET|CST|CDT|CT|MST|MDT|MT|BST|IST|JST|KST|CET|CEST)";
const zonePattern = new RegExp(`\\b${zoneToken}(?![\\w/+:\\d-])`, "gi");
const zones: Record<string, string> = {
  pt: "America/Los_Angeles", "pacific time": "America/Los_Angeles", "america/los_angeles": "America/Los_Angeles",
  pst: "Etc/GMT+8", "pacific standard time": "Etc/GMT+8", pdt: "Etc/GMT+7", "pacific daylight time": "Etc/GMT+7",
  utc: "UTC", gmt: "UTC", "asia/shanghai": "Asia/Shanghai",
  et: "America/New_York", "eastern time": "America/New_York", est: "Etc/GMT+5", edt: "Etc/GMT+4",
  "eastern standard time": "Etc/GMT+5", "eastern daylight time": "Etc/GMT+4",
  ct: "America/Chicago", cdt: "Etc/GMT+5", mt: "America/Denver", mst: "Etc/GMT+7", mdt: "Etc/GMT+6",
  jst: "Asia/Tokyo", kst: "Asia/Seoul", cet: "Etc/GMT-1", cest: "Etc/GMT-2",
};
function parseZone(value: string): string | null {
  const offset = /^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(value);
  if (offset) {
    const hours = Number(offset[2]), minutes = Number(offset[3] ?? 0);
    return hours <= 23 && minutes <= 59 ? `${offset[1]}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}` : null;
  }
  if (zones[value.toLowerCase()]) return zones[value.toLowerCase()]!;
  if (!value.includes("/")) return null; // Ambiguous or unsupported abbreviations must not become UTC.
  try { return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone; } catch { return null; }
}
/** undefined means absent; null means explicit but unsupported or contradictory. */
function zoneIn(text: string): string | null | undefined {
  text = text.replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, " ");
  const tokens = [...text.matchAll(zonePattern)].map(match => match[0]);
  for (const match of text.matchAll(/\b\d{1,2}(?::\d{2})?\s*(?:[aA][mM]|[pP][mM])?\s+([A-Z]{2,5})\b/g)) {
    const token = match[1]!;
    if (!zones[token.toLowerCase()] && !["AM", "PM"].includes(token) && !tokens.includes(token)) tokens.push(token);
  }
  if (!tokens.length) return /\b(?:UTC|GMT)\s*[+-]/i.test(text) ? null : undefined;
  const found = [...new Set(tokens.map(parseZone))];
  return found.length === 1 ? found[0]! : null;
}
function sourceZone(expression: string, postText: string, activityText: string) {
  for (const [basis, text] of [["expression", expression], ["post", postText], ["activity", activityText]] as const) {
    const zone = zoneIn(text);
    if (zone !== undefined) return zone === null ? null : { timeZone: zone, zoneBasis: basis };
  }
  return { timeZone: "UTC", zoneBasis: "publication" as const };
}
function dateZone(zone: string) {
  const offset = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (!offset) return zone;
  if (offset[3] !== "00") return null;
  const hours = Number(offset[2]);
  const name = hours === 0 ? "UTC" : `Etc/GMT${offset[1] === "+" ? "-" : "+"}${hours}`;
  try { new Intl.DateTimeFormat("en", { timeZone: name }); return name; } catch { return null; }
}

/** Private provenance: never append this information to reader-facing localized text. */
export interface TimeResolution {
  field: "claimDeadline" | "expiresAt";
  time: EventTime;
  postId: string;
  excerpt: string;
  activityAnchor: string;
  yearBasis: "explicit" | "activity";
  timeZone: string;
  zoneBasis: "expression" | "post" | "activity" | "publication";
}

type SourceTimeContext = {
  activityAnchor: string; postText: string; activityText: string; deadline: boolean; past?: boolean;
};
type ResolvedTime = Omit<TimeResolution, "field" | "postId" | "excerpt">;

function resolveSingleSourceTime(expression: string, context: SourceTimeContext): ResolvedTime | null {
  const match = new RegExp(datePattern, "i").exec(expression);
  if (!match) return null;
  const zone = sourceZone(expression, context.postText, context.activityText);
  if (!zone) return null;
  const { timeZone, zoneBasis } = zone;
  try {
    const anchor = Temporal.Instant.from(context.activityAnchor).toZonedDateTimeISO(timeZone).toPlainDate();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(match[0]);
    const named = iso ? null : new RegExp(`^(${monthPattern})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$`, "i").exec(match[0]);
    const explicitYear = iso?.[1] ?? named?.[3];
    const month = iso ? Number(iso[2]) : months.indexOf(named![1]!.slice(0, 3).toLowerCase()) + 1;
    const day = Number(iso?.[3] ?? named![2]);
    let year = explicitYear ? Number(explicitYear) : anchor.year;
    // Select the next matching calendar date from the original activity, never from now or a reminder.
    if (!explicitYear && context.past && (month > anchor.month || month === anchor.month && day > anchor.day)) year--;
    else if (!explicitYear && !context.past && (month < anchor.month || month === anchor.month && day < anchor.day)) year++;
    const date = Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" });
    const remainder = expression.slice(match.index + match[0].length);
    const clock = /^\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(remainder);
    let time: EventTime;
    if (clock) {
      let hour = Number(clock[1]);
      if (clock[3]) {
        if (hour < 1 || hour > 12) return null;
        hour = hour % 12 + (clock[3].toLowerCase() === "pm" ? 12 : 0);
      } else if (!clock[2]) return null;
      const local = date.toPlainDateTime(Temporal.PlainTime.from({ hour, minute: Number(clock[2] ?? 0) }, { overflow: "reject" }));
      const at = local.toZonedDateTime(timeZone, { disambiguation: "reject" }).toInstant().toString();
      time = { kind: context.deadline ? "deadline" : "instant", at };
    } else {
      const sourceDateZone = dateZone(timeZone);
      if (!sourceDateZone) return null;
      time = { kind: "date", date: date.toString(), timeZone: sourceDateZone };
    }
    return { time, activityAnchor: context.activityAnchor, yearBasis: explicitYear ? "explicit" : "activity", timeZone, zoneBasis };
  } catch { return null; }
}

const clockText = "\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?";
const rangePattern = new RegExp(`^\\s*(?:at\\s+|from\\s+|between\\s+)?(?<start>${clockText})(?:\\s*(?<startZone>${zoneToken}))?\\s*(?:[–—-]|to\\b|through\\b|and\\b)\\s*(?:(?<endDate>${datePattern})\\s*(?:at\\s+)?)?(?<end>${clockText})(?:\\s*(?<endZone>${zoneToken}))?`, "i");
const isoTimestampPattern = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:\\d{2})";

export function resolveSourceTime(expression: string, context: SourceTimeContext): ResolvedTime | null {
  expression = namedClock(expression);
  const date = new RegExp(datePattern, "i").exec(expression);
  if (!date) return null;
  const timestamp = expression.slice(date.index);
  if (/^\d{4}-\d{2}-\d{2}T/i.test(timestamp)) {
    const match = new RegExp(`^(${isoTimestampPattern})(?![\\w:+-])`, "i").exec(timestamp);
    if (!match) return null; // An explicit clock must never become a date-only fact.
    try {
      const from = Temporal.Instant.from(match[1]!).toString();
      const remainder = timestamp.slice(match[0].length);
      let time: EventTime = { kind: context.deadline ? "deadline" : "instant", at: from };
      if (/^\s*(?:\/|[–—-]|to\b|through\b)/i.test(remainder)) {
        const end = new RegExp(`^\\s*(?:/|[–—-]|to\\b|through\\b)\\s*(${isoTimestampPattern})(?![\\w:+-])`, "i").exec(remainder);
        if (!end) return null;
        const through = Temporal.Instant.from(end[1]!).toString();
        if (Temporal.Instant.compare(through, from) < 0) return null;
        time = { kind: "range", from, through };
      }
      return { time, activityAnchor: context.activityAnchor, yearBasis: "explicit",
        timeZone: /Z$/i.test(match[1]!) ? "UTC" : match[1]!.slice(-6), zoneBasis: "expression" };
    } catch { return null; }
  }
  const remainder = expression.slice(date.index + date[0].length);
  if (/^\s*(?:[–—-]|to\b|through\b)\s*(?:\d|[A-Za-z])/i.test(remainder)) return null;
  const range = rangePattern.exec(remainder)?.groups;
  if (!range) {
    // Never turn an unparseable interval into a fabricated single occurrence.
    if (new RegExp(`^\\s*(?:at|from|between)?\\s*${clockText}\\s*(?:${zoneToken})?\\s*(?:[–—-]|to\\b|through\\b|and\\b)`, "i").test(remainder)) return null;
    return resolveSingleSourceTime(expression, context);
  }
  const startZone = range.startZone ?? range.endZone ?? "";
  const endZone = range.endZone ?? range.startZone ?? "";
  const starts = /(?:am|pm)\b/i.test(range.start!) || !/(?:am|pm)\b/i.test(range.end!) ? [range.start!]
    : [`${range.start}am`, `${range.start}pm`];
  const options: Array<{ result: ResolvedTime; duration: number }> = [];
  for (const clock of starts) {
    const start = resolveSingleSourceTime(`${date[0]} at ${clock} ${startZone}`, { ...context, deadline: false });
    if (start?.time.kind !== "instant") continue;
    const localDay = Temporal.Instant.from(start.time.at).toZonedDateTimeISO(start.timeZone).toPlainDate();
    let endDate = range.endDate ?? localDay.toString();
    let end = resolveSingleSourceTime(`${endDate} at ${range.end} ${endZone}`, { ...context, activityAnchor: start.time.at, past: false, deadline: false });
    if (end?.time.kind !== "instant") continue;
    if (!range.endDate && Date.parse(end.time.at) < Date.parse(start.time.at)) {
      endDate = localDay.add({ days: 1 }).toString();
      end = resolveSingleSourceTime(`${endDate} at ${range.end} ${endZone}`, { ...context, deadline: false });
    }
    if (end?.time.kind !== "instant") continue;
    const duration = Date.parse(end.time.at) - Date.parse(start.time.at);
    if (duration >= 0) options.push({ duration, result: { ...start, time: { kind: "range", from: start.time.at, through: end.time.at } } });
  }
  return options.sort((a, b) => a.duration - b.duration)[0]?.result ?? null;
}

/** Event expressions are kept apart from redemption and expiry wording. */
export function resolveEventExpression(excerpt: string, post: PublicV2PostRow, announcement: boolean, activityText: string, activityAnchor?: string, occurredLifecycle = false): EventTime {
  if (!occurredLifecycle && /\b(?:claims?|redeem|expire|expiry|valid until)\b/i.test(excerpt)) return { kind: "unknown" };
  const literal = excerpt.trim();
  excerpt = namedClock(excerpt);
  const anchor = new Date(post.published_at).toISOString();
  const relative = /\b(?:(in|within|over)\s+(?:the\s+)?(?:(next)\s+)?|(next)\s+)(?:(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(minutes?|hours?|days?)\b/i.exec(excerpt);
  if (relative && !/\b(?:about|around|roughly|approximately|or so)\b|~/i.test(excerpt)) {
    const unit = relative[5]!.toLowerCase();
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const amountText = relative[4]?.toLowerCase();
    const amount = amountText ? words[amountText] ?? Number(amountText) : (relative[2] || relative[3]) && !unit.endsWith("s") ? 1 : NaN;
    if (announcement && amount > 0 && amount <= 240) {
      const multiplier = unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000;
      const at = new Date(Date.parse(anchor) + amount * multiplier).toISOString();
      return /\b(?:within|next|over)\b/i.test(relative[0]) ? { kind: "range", from: anchor, through: at } : { kind: "instant", at };
    }
    return { kind: "unknown" };
  }
  if (/\b(?:about|around|roughly|approximately)\b|~/i.test(excerpt)) return { kind: "unknown" };
  const occurrences = literal ? [...post.text.matchAll(new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"))] : [];
  // A model may quote only the clock. Recover a deadline marker only from its unique literal occurrence.
  const deadline = /\b(?:by|before|until)\b/i.test(excerpt) || occurrences.length === 1
    && /\b(?:by|before|until)\s*$/i.test(post.text.slice(0, occurrences[0]!.index));
  const context = { activityAnchor: anchor, postText: post.text, activityText, deadline, past: !announcement };
  if (new RegExp(datePattern, "i").test(excerpt)) {
    // A calendar date belongs to the original announcement even when a later post confirms it.
    return resolveSourceTime(excerpt, activityAnchor ? { ...context, activityAnchor, past: false } : context)?.time ?? { kind: "unknown" };
  }
  const zone = sourceZone(excerpt, post.text, activityText);
  if (!zone) return { kind: "unknown" };
  const { timeZone } = zone;
  const local = Temporal.Instant.from(anchor).toZonedDateTimeISO(timeZone);
  let day = local.toPlainDate();
  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const weekday = /\b(?:(next|last|this)\s+)?(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.exec(excerpt);
  const dayExplicit = /\b(today|tomorrow|yesterday)\b/i.exec(excerpt);
  if (dayExplicit) day = day.add({ days: dayExplicit[1]!.toLowerCase() === "tomorrow" ? 1 : dayExplicit[1]!.toLowerCase() === "yesterday" ? -1 : 0 });
  else if (weekday) {
    const offset = weekdays.indexOf(weekday[2]!.toLowerCase()) + 1 - local.dayOfWeek;
    const qualifier = weekday[1]?.toLowerCase();
    const days = qualifier === "next" ? (offset + 7) % 7 || 7 : qualifier === "last" ? (offset - 7) % 7 || -7
      : qualifier === "this" ? offset : announcement ? (offset + 7) % 7 : (offset - 7) % 7;
    day = day.add({ days });
  }
  if (/\b(?:EOD|end\s+of\s+(?:the\s+)?day)\b/i.test(excerpt)) {
    try {
      const at = day.add({ days: 1 }).toZonedDateTime(timeZone).toInstant().toString();
      if (announcement) return Date.parse(at) >= Date.parse(anchor) ? { kind: "range", from: anchor, through: at } : { kind: "unknown" };
      // A future day boundary is a forecast, never the time of an occurred result.
      return Date.parse(at) <= Date.parse(anchor) ? { kind: deadline ? "deadline" : "instant", at } : { kind: "unknown" };
    } catch { return { kind: "unknown" }; }
  }
  const clock = /\b(?:at|by|before|until|from|between)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.exec(excerpt);
  if (!clock) {
    const sourceDateZone = dateZone(timeZone);
    return (dayExplicit || weekday) && sourceDateZone ? { kind: "date", date: day.toString(), timeZone: sourceDateZone } : { kind: "unknown" };
  }
  const clockExpression = excerpt.slice(clock.index).replace(/^(?:at|by|before|until|from|between)\s+/i, "");
  const expression = () => `${months[day.month - 1]} ${day.day}, ${day.year} at ${clockExpression}`;
  let result = resolveSourceTime(expression(), context)?.time;
  if (!dayExplicit && !weekday && result && result.kind !== "unknown" && result.kind !== "date") {
    const start = result.kind === "range" ? result.from : result.at;
    if (announcement && Date.parse(start) < Date.parse(anchor)) day = day.add({ days: 1 });
    if (!announcement && Date.parse(start) > Date.parse(anchor)) day = day.subtract({ days: 1 });
    result = resolveSourceTime(expression(), context)?.time;
  }
  return result ?? { kind: "unknown" };
}
