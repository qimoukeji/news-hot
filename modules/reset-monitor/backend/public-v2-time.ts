import { Temporal } from "@js-temporal/polyfill";
import type { BusinessTime } from "../public-v2.ts";
import { normalizePublicTime, isFutureBusinessTime } from "../public-v2.ts";
import { defaultActionTime, type ActionDraft } from "../actions.ts";
import { quotedInPost } from "./evidence.ts";
type PublicV2PostRow = { text: string; published_at: Date | string };
/** Intermediate source precision is resolved before anything is written. */
export type ParsedTime = BusinessTime | { kind: "date"; date: string; timeZone: string } | { kind: "unknown" };

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const namedClock = (text: string) => text.replace(/\bmidnight\b/gi, "12am").replace(/\bnoon\b/gi, "12pm");
const monthPattern = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const datePattern = `(?:${monthPattern}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2})`;
const clockText = "\\d{1,2}(?::\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?)?\\s*(?:am|pm)?";
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
/** Private provenance: never append this information to reader-facing localized text. */
export interface TimeResolution {
  field: "claimDeadline" | "expiresAt";
  time: ParsedTime;
  postId: string;
  excerpt: string;
  activityAnchor: string;
  yearBasis: "explicit" | "activity";
  timeZone: string;
  zoneBasis: "expression" | "post" | "activity" | "publication";
}

type SourceTimeContext = {
  activityAnchor: string; postText: string; activityText: string; deadline: boolean; past?: boolean; sameYear?: boolean;
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
    if (!explicitYear && !context.sameYear) {
      if (context.past && (month > anchor.month || month === anchor.month && day > anchor.day)) year--;
      else if (!context.past && (month < anchor.month || month === anchor.month && day < anchor.day)) year++;
    }
    const date = Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" });
    const remainder = expression.slice(match.index + match[0].length);
    const clock = /^\s*(?:at\s+)?(\d{1,2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(am|pm)?\b(?![:\d]|\.\d)/i.exec(remainder);
    let time: ParsedTime;
    if (clock) {
      let hour = Number(clock[1]);
      if (clock[5]) {
        if (hour < 1 || hour > 12) return null;
        hour = hour % 12 + (clock[5].toLowerCase() === "pm" ? 12 : 0);
      } else if (!clock[2]) return null;
      const timeOfDay = `${String(hour).padStart(2, "0")}:${clock[2] ?? "00"}:${clock[3] ?? "00"}${clock[4] ? `.${clock[4]}` : ""}`;
      if (clock[3] === "60") return null;
      const local = date.toPlainDateTime(Temporal.PlainTime.from(timeOfDay));
      const at = local.toZonedDateTime(timeZone, { disambiguation: "reject" }).toInstant().toString();
      time = { kind: context.deadline ? "deadline" : "instant", at };
    } else {
      if (/^\s*(?:at\s+)?\d{1,2}\s*:|^\s*at\s+\d/i.test(remainder)) return null;
      time = { kind: "date", date: date.toString(), timeZone };
    }
    return { time, activityAnchor: context.activityAnchor, yearBasis: explicitYear ? "explicit" : "activity", timeZone, zoneBasis };
  } catch { return null; }
}

const nextDayPattern = "(?:(?:the\\s+)?next\\s+day\\b|次日|翌日)";
const rangePattern = new RegExp(`^\\s*(?:at\\s+|from\\s+|between\\s+)?(?<start>${clockText})(?:\\s*(?<startZone>${zoneToken}))?\\s*(?:[–—-]|to\\b|through\\b|until\\b|and\\b)\\s*(?:(?<nextDay>${nextDayPattern})\\s*(?:at\\s+)?)?(?:(?<endDate>${datePattern})\\s*(?:at\\s+)?)?(?<end>${clockText})(?:\\s*(?<endZone>${zoneToken}))?(?:\\s*(?<endNextDay>${nextDayPattern}))?`, "i");
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
      let time: ParsedTime = { kind: context.deadline ? "deadline" : "instant", at: from };
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
    if (new RegExp(`^\\s*(?:at|from|between)?\\s*${clockText}\\s*(?:${zoneToken})?\\s*(?:[–—-]|to\\b|through\\b|until\\b|and\\b)`, "i").test(remainder)) return null;
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
    // A clock running backwards is not evidence of an overnight schedule.
    const endDate = range.endDate ?? localDay.add({ days: range.nextDay || range.endNextDay ? 1 : 0 }).toString();
    const end = resolveSingleSourceTime(`${endDate} at ${range.end} ${endZone}`, { ...context, activityAnchor: start.time.at, past: false, deadline: false });
    if (end?.time.kind !== "instant") continue;
    const duration = Date.parse(end.time.at) - Date.parse(start.time.at);
    if (duration >= 0) options.push({ duration, result: { ...start, time: { kind: "range", from: start.time.at, through: end.time.at } } });
  }
  return options.sort((a, b) => a.duration - b.duration)[0]?.result ?? null;
}

const relativeTime = /\b(?:(in|within|over)\s+(?:the\s+)?(?:(next)\s+)?|(next)\s+)(?:(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(minutes?|hours?|days?)\b/i;
const dayOrClock = /\b(?:today|tomorrow|yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|EOD|end\s+of\s+(?:the\s+)?day|noon|midnight|\d{1,2}:\d{2}(?:\s*[ap]m)?|\d{1,2}\s*[ap]m)\b/i;
const calendarTime = new RegExp(`\\b(?:${isoTimestampPattern}|${datePattern})(?!\\d)`, "i");
const timeClauses = (text: string) => text
  .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
  .replace(new RegExp(`\\b(${monthPattern})\\.(?=\\s+\\d)`, "gi"), "$1 ")
  .split(/[!?。！？;；\n]|\.(?=\s|$)/);

function firstRelativeTime(text: string, date: RegExpExecArray | null) {
  const relative = relativeTime.exec(text);
  return relative && (!date || relative.index < date.index) ? relative : null;
}

function selectedTime(text: string) {
  const date = calendarTime.exec(text);
  return firstRelativeTime(text, date) ?? date ?? dayOrClock.exec(text);
}

function usageAt(before: string, after: string): boolean {
  if (/^\s*(?:即|将|將)?(?:发放|發放|下发|下發|生效)/.test(after)) return false;
  if (/^\s*(?:(?:之前|以前|前)\s*(?:可|须|須|需|必须|必須)?\s*(?:使用|兑换|兌換|领取|領取)|(?:即|将|將)?(?:到期|过期|過期)|(?:is|was)\s+the\s+(?:(?:claim|redemption|usage|expiry)\s+deadline|last\s+day\s+to\s+(?:use|redeem|claim))\b)/i.test(after)) return true;
  // The governing fact can change within a sentence: "issued on X, good through Y",
  // or "users who use the product, resets start on X". A schedule needs its own subject.
  const cues = /(?<usage>\b(?:use|used|using|redeem(?:ed|ing)?|redemption|claim(?:s|ed|ing)?|expir(?:e[sd]?|ing|y|ation)|(?:usable|redeemable|claimable|valid|available|good)\s+(?:only\s+)?(?:until|through|before|by))\b|使用|兑换|兌換|领取|領取|到期|过期|過期|有效期|(?:可用|有效)\s*(?:至|到))|\b(?:issu(?:e[sd]?|ing|ance)|giv(?:e[sn]?|ing)|gave|grant(?:s|ed|ing)?|distribut(?:e[sd]?|ing|ion)|deliver(?:s|ed|ing|y)?|credit(?:ed|ing)|arriv(?:e[sd]?|ing)|lands?|landed|(?:now\s+)?available|reset\s+(?:usage|quotas?|limits?))\b|(?:^|[,，]\s*)(?:the\s+)?(?:resets?|reset\s+credits?)\s+(?:starts?|begins?)\b|发放|發放|下发|下發|生效/gi;
  const cue = [...before.matchAll(cues)].at(-1);
  if (!cue?.groups?.usage) return false;
  // "Issued for use on Fable on X" still dates the issuance.
  if (/^(?:use|redemption)$/i.test(cue[0]) && /\bfor\s+$/i.test(before.slice(0, cue.index)))
    return /\b(?:by|before|until|through)\s*$/i.test(before);
  return true;
}

/** True when the selected source time describes use, claiming, or expiry rather than delivery. */
export function isUsageTime(excerpt: string, postText: string): boolean {
  for (const quote of timeClauses(excerpt)) {
    const time = selectedTime(quote);
    if (!time) continue;
    // Match the selected quote, including any wording that distinguishes repeated dates.
    // The separator tolerates the same typography differences as quotedInPost.
    const words = (value: string) => value.normalize("NFKC").match(/[\p{L}\p{N}]+/gu)?.join("[^\\p{L}\\p{N}]+") ?? "";
    const prefix = words(quote.slice(0, time.index));
    const value = words(time[0]);
    const suffix = words(quote.slice(time.index + time[0].length));
    const pattern = new RegExp(`(?<![a-z0-9])(${prefix ? prefix + "[^\\p{L}\\p{N}]+" : ""})${value}(?![a-z0-9])${suffix ? "(?=[^\\p{L}\\p{N}]+" + suffix + "(?![a-z0-9]))" : ""}`, "giu");
    const matches = timeClauses(postText).flatMap(clause => {
      clause = clause.normalize("NFKC");
      return [...clause.matchAll(pattern)].map(match => usageAt(clause.slice(0, match.index + match[1]!.length), clause.slice(match.index + match[0].length)));
    });
    // A date shared by a delivery and a deadline is not evidence of a deadline on its own.
    return matches.length ? matches.every(Boolean) : usageAt(quote.slice(0, time.index), quote.slice(time.index + time[0].length));
  }
  return false;
}

const quotaObject = /\b(?:resets?|credits?|quotas?|rewards?)\b|重置卡|额度|額度/i;
const issuanceVerb = "(?:issue|grant|give|distribute|deliver|credit|receive)";
const issuedVerb = "(?:issued|granted|given|distributed|delivered|credited|received)";
const issuingVerb = "(?:issuing|granting|giving|distributing|delivering|crediting|receiving)";
const issuanceObject = "\\b(?!\\s+(?:(?:an?|the|more|new)\\s+)*(?:updates?|statements?|instructions?|announcements?|details|notices?)\\b)";
const futureIssuance = new RegExp(`(?:\\b(?:will|plans?\\s+to)\\s+|(?:\\b(?:is|are)|['’](?:s|re))\\s+(?:going|scheduled|set)\\s+to\\s+|['’]ll\\s+)(?:soon\\s+)?(?:${issuanceVerb}|be\\s+(?:${issuedVerb}|${issuingVerb}))${issuanceObject}|(?:将|將|定于|定於)[^，,]{0,40}(?:发放|發放|下发|下發)`, "i");
const ongoingIssuance = new RegExp(`(?:\\b(?:is|are|am)|['’](?:s|re|m))\\s+(?:${issuingVerb}|being\\s+${issuedVerb})${issuanceObject}`, "i");
const completedIssuance = new RegExp(`\\b(?:(?:we|they|I)(?:['’]ve|\\s+have)?\\s+(?:(?:already|just)\\s+)?(?:${issuedVerb}|gave)|(?:was|were|(?:has|have)\\s+(?:(?:already|just)\\s+)?been)\\s+(?:(?:already|just)\\s+)?${issuedVerb}|already\\s+available)\\b|已(?:经|經)?\\s*(?:发放|發放|下发|下發)`, "i");

/** Check a verified action excerpt without a model time quote. The post anchors dates on ongoing issuance. */
export function hasExplicitFutureIssuance(actionExcerpt: string, post?: PublicV2PostRow): boolean {
  if (/[?？]|^\s*(?:if\b|unless\b|如果|除非)/i.test(actionExcerpt)) return false;
  const clauses = timeClauses(actionExcerpt);
  if (clauses.some(clause => completedIssuance.test(clause))) return false;
  return clauses.some(clause => {
    if (!quotaObject.test(clause)
      || /\b(?:if|unless|maybe|perhaps|might|could|would|not|never)\b|(?:won|isn|aren)['’]t|如果|除非|可能|不(?:会|會|再)|尚未/i.test(clause)) return false;
    if (futureIssuance.test(clause)) return true;
    const date = calendarTime.exec(clause);
    if (!post || !date) return false;
    const before = clause.slice(0, date.index);
    const issuing = ongoingIssuance.exec(before);
    if (!issuing || !/\bon\s*$/i.test(before)
      || /\b(?:who|whose|when|once|after|before|to\s+use|for\s+use)\b/i.test(before.slice(issuing.index + issuing[0].length))
      || usageAt(before, clause.slice(date.index + date[0].length))) return false;
    const published = new Date(post.published_at);
    if (!Number.isFinite(published.getTime())) return false;
    const activityAnchor = published.toISOString();
    // This is evidence of a future plan only if the date is ahead without rolling the year forward.
    const resolved = resolveSourceTime(clause.slice(date.index),
      { activityAnchor, postText: post.text, activityText: clause, deadline: false, sameYear: true });
    return resolved !== null && resolved.time.kind !== "unknown" && isFutureSourceTime(resolved.time, activityAnchor);
  });
}

/** Normalize date-only source excerpts without replacing clocks or other clauses. */
function dateOnlyWords(excerpt: string): string {
  return excerpt.replace(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]/g, (source, year, month, day) =>
    months[Number(month) - 1] ? ` ${months[Number(month) - 1]} ${day}${year ? `, ${year}` : ""} ` : source)
    .replace(/(下|上|本|这|這)?(?:周|週|星期)([一二三四五六日天])/g, (_source, relative, day) =>
      ` ${relative ? `${relative}周 ` : ""}${weekdays[Math.min(6, "一二三四五六日天".indexOf(day))]} `).trim();
}

/** Event expressions are kept apart from redemption and expiry wording. */
export function resolveEventExpression(excerpt: string, post: PublicV2PostRow, announcement: boolean, activityText: string, activityAnchor?: string, occurredLifecycle = false): ParsedTime {
  if (!occurredLifecycle && isUsageTime(excerpt, post.text)) return { kind: "unknown" };
  const literal = excerpt.trim();
  excerpt = namedClock(dateOnlyWords(literal));
  const anchor = new Date(post.published_at).toISOString();
  const date = calendarTime.exec(excerpt);
  const relative = firstRelativeTime(excerpt, date);
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
  const deadline = /\b(?:by|before|until)\b/i.test(date ? excerpt.slice(0, date.index) : excerpt) || occurrences.length === 1
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
  const weekday = /(?:\b(next|last|this)\s+|([下上本这這])周\s*)?\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.exec(excerpt);
  const dayExplicit = /\b(today|tomorrow|yesterday)\b/i.exec(excerpt);
  if (dayExplicit) day = day.add({ days: dayExplicit[1]!.toLowerCase() === "tomorrow" ? 1 : dayExplicit[1]!.toLowerCase() === "yesterday" ? -1 : 0 });
  else if (weekday) {
    const offset = weekdays.indexOf(weekday[3]!.toLowerCase()) + 1 - local.dayOfWeek;
    const qualifier = weekday[1]?.toLowerCase();
    // Chinese week qualifiers select a calendar week, unlike English next/last occurrences.
    const days = weekday[2] ? offset + (weekday[2] === "下" ? 7 : weekday[2] === "上" ? -7 : 0)
      : qualifier === "next" ? (offset + 7) % 7 || 7 : qualifier === "last" ? (offset - 7) % 7 || -7
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
  const clock = /\b(?:at|by|before|until|from|between)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|(?<!\d)\d{1,2}:\d{2}\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.exec(excerpt);
  if (!clock) return dayExplicit || weekday ? { kind: "date", date: day.toString(), timeZone } : { kind: "unknown" };
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

function isFutureSourceTime(time: Exclude<ParsedTime, { kind: "unknown" }>, at: string): boolean {
  if (time.kind === "date") return time.date > Temporal.Instant.from(at).toZonedDateTimeISO(time.timeZone).toPlainDate().toString();
  return isFutureBusinessTime(time, at);
}

const deadlineWords = /\b(?:by|before|until|within|no later than|end\s+of)\b|截止|截至|结束前|結束前|之前|不晚于|不晚於|最迟|最遲|天内|天內|小时内|小時內/i;
function sourcePoint(text: string, post: PublicV2PostRow, anchor?: string): ParsedTime {
  return resolveEventExpression(text.trim().replace(/^(?:from|between)\s+|^[从從]\s*/i, ""), post, true, post.text, anchor);
}
const dateClock = (date: string, clock: string) => `${date}T${clock}:00Z`;

function announcementDeadline(excerpt: string, post: PublicV2PostRow): boolean {
  const normalized = dateOnlyWords(excerpt.trim()), selected = selectedTime(normalized);
  if (selected) {
    const before = normalized.slice(0, selected.index), after = normalized.slice(selected.index + selected[0].length);
    if (/^within\b/i.test(selected[0]) || /\b(?:by|before|until|within|no later than|end\s+of)\s*$/i.test(before)
      || /(?:截止|截至|不晚于|不晚於|最迟|最遲)\s*$/.test(before)
      || /^\s*(?:结束前|結束前|之前|前|内|內)/.test(after)
      || new RegExp(`^\\s*(?:(?:at\\s+)?${clockText})?(?:\\s*${zoneToken})?\\s*(?:之前|前)`, "i").test(after)) return true;
    const occurrences = [...post.text.matchAll(new RegExp(excerpt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
    if (occurrences.length === 1 && /\b(?:by|before|until)\s*$/i.test(post.text.slice(0, occurrences[0]!.index))) return true;
    return false;
  }
  return deadlineWords.test(excerpt);
}

/** Date-only restatements must not overwrite an accepted clock. */
export function hasExplicitAnnouncementClock(excerpt: string): boolean {
  return /(?<![+\-\d])\d{1,2}:\d{2}|\b\d{1,2}\s*[ap]m\b|\b(?:noon|midnight)\b/i.test(excerpt.replace(zonePattern, ""));
}

function announcementInterval(excerpt: string, post: PublicV2PostRow, anchor?: string): BusinessTime | null {
  const split = /\s+(?:to|through|and|until)\s+|\s*[–—~至到]\s*|\s+-\s+|(?<=\d{4}-\d{2}-\d{2})\/(?=\d{4}-\d{2}-\d{2}\b)/i.exec(excerpt);
  if (!split) return null;
  const left = excerpt.slice(0, split.index).trim(), right = excerpt.slice(split.index + split[0].length).trim();
  if (/^and$/i.test(split[0].trim()) && !/\bbetween\b/i.test(left)) return null;
  // An adjacent claim deadline is a separate fact, not the end of a delivery range.
  if (!/(?:\d|am|pm|UTC|GMT|P[DS]?T|E[DS]?T|day|[日号號一二三四五六天])$/i.test(left)
    || isUsageTime(right, post.text)) return null;
  const publishedAt = new Date(post.published_at).toISOString();
  const location = anchor ?? publishedAt;
  const clockOnly = new RegExp(`^(?:at\\s+)?(?=\\d{1,2}:|\\d{1,2}\\s*[ap]m\\b)${clockText}(?:\\s*${zoneToken})?$`, "i");
  const leftWords = dateOnlyWords(left);
  const namedStart = new RegExp(datePattern, "i").exec(leftWords)?.[0];
  const nextDay = new RegExp(nextDayPattern, "i").exec(right);
  const endWords = nextDay ? right.replace(nextDay[0], "").trim() : right;
  const rightClock = clockOnly.test(namedClock(endWords));
  const leftClock = left.replace(/^(?:from|between)\s+|^[从從]\s*/i, "").replace(/^at\s+/i, "");
  const startZone = sourceZone(left, post.text, post.text)?.timeZone;
  let start = sourcePoint(clockOnly.test(namedClock(leftClock)) ? `today at ${leftClock}` : left, post, anchor);
  let end = sourcePoint(right, post, anchor);
  const shortEnd = /^(\d{1,2})(?:st|nd|rd|th|[日号號])?(?=$|\s)(.*)$/i.exec(right);
  const startCalendar = (value: ParsedTime) => value.kind === "date" ? value.date : value.kind === "instant" || value.kind === "deadline"
    ? Temporal.Instant.from(value.at).toZonedDateTimeISO(startZone ?? "UTC").toPlainDate().toString() : undefined;
  const endCalendar = (value: ParsedTime) => value.kind === "date" ? value.date : value.kind === "instant" || value.kind === "deadline"
    ? Temporal.Instant.from(value.at).toZonedDateTimeISO(sourceZone(right, post.text, post.text)?.timeZone ?? "UTC").toPlainDate().toString() : undefined;
  const abbreviatedEnd = (date: string) => {
    if (rightClock) return sourcePoint(`${Temporal.PlainDate.from(date).add({ days: nextDay ? 1 : 0 })} at ${endWords.replace(/^at\s+/i, "")}`, post, anchor);
    const first = Temporal.PlainDate.from(date);
    const day = Number(shortEnd![1]);
    const month = day < first.day ? first.add({ months: 1 }) : first;
    return sourcePoint(`${month.with({ day }, { overflow: "reject" })}${shortEnd![2]}`, post, anchor);
  };
  if (namedStart && !/\d{4}/.test(namedStart)) {
    const sameYear = resolveSourceTime(leftWords, { activityAnchor: location, postText: post.text, activityText: post.text, deadline: false, sameYear: true })?.time;
    const candidateDate = sameYear && startCalendar(sameYear), rolledDate = startCalendar(start), endDate = endCalendar(end);
    if (candidateDate && rolledDate && candidateDate < rolledDate && (endDate && candidateDate <= endDate && endDate < rolledDate
      || shortEnd && end.kind === "unknown" && (endCalendar(abbreviatedEnd(candidateDate)) ?? "") >= location.slice(0, 10))) start = sameYear;
  }
  const startDate = startCalendar(start);
  if (startDate && (rightClock || shortEnd && end.kind === "unknown")) end = abbreviatedEnd(startDate);
  if (start.kind === "unknown" || end.kind === "unknown") {
    // A recognized range separator must not turn an invalid endpoint into a point.
    throw new RangeError("Invalid schedule range endpoint");
  }
  const startAt = start.kind === "date" ? start.date <= publishedAt.slice(0, 10) ? publishedAt : dateClock(start.date, "08:00")
    : start.kind === "range" ? start.from : start.at;
  const endAt = end.kind === "date" ? dateClock(end.date, "18:00") : end.kind === "range" ? end.through : end.at;
  return normalizePublicTime({ kind: "range", from: startAt, through: endAt });
}

function announcementTime(excerpt: string, post: PublicV2PostRow, anchor?: string): BusinessTime | null {
  const endOfDay = /\b(?:EOD|end\s+of\s+(?:the\s+)?day)\b/i;
  if (endOfDay.test(excerpt) && !hasExplicitAnnouncementClock(excerpt)) {
    const date = dateOnlyWords(excerpt.replace(endOfDay, ""));
    const point = sourcePoint(selectedTime(date) ? date : `today ${date}`, post, anchor);
    return point.kind === "date" ? { kind: "deadline", at: dateClock(point.date, "18:00") } : null;
  }
  const withinHours = /^(\d+(?:\.\d+)?)\s*(?:小时|小時)\s*(?:内|內)$/.exec(excerpt.trim());
  if (withinHours) {
    const at = new Date(new Date(post.published_at).getTime() + Number(withinHours[1]) * 3_600_000).toISOString();
    return { kind: "deadline", at };
  }
  const interval = announcementInterval(excerpt, post, anchor);
  if (interval) return interval;
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    一: 1, 两: 2, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const days = /\b(?:in|within|next|over)\s+(?:the\s+)?(?:next\s+)?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\b|([一两兩二三四五六七八九十\d]+)\s*天(?:内|內|后|後)/i.exec(excerpt);
  const namedDate = calendarTime.exec(dateOnlyWords(excerpt));
  if (days && (!namedDate || days.index < namedDate.index)) {
    const quantity = days[1] ?? days[2]!;
    const count = words[quantity.toLowerCase()] ?? Number(quantity);
    if (!Number.isFinite(count) || count < 0) return null;
    const date = Temporal.Instant.from(new Date(post.published_at).toISOString()).toZonedDateTimeISO("UTC").toPlainDate().add({ days: count }).toString();
    const suffix = excerpt.slice(days.index + days[0].length);
    if (hasExplicitAnnouncementClock(suffix) && /^\s*(?:at\s+)?(?:\d{1,2}|noon\b|midnight\b)/i.test(suffix)) {
      const exact = sourcePoint(`${date} ${suffix.trim()}`, post, anchor);
      return exact.kind === "instant" ? { kind: deadlineWords.test(days[0]) ? "deadline" : "instant", at: exact.at } : null;
    }
    if (/\b(?:over|next)\b/i.test(excerpt) && !/\bwithin\b/i.test(excerpt))
      return normalizePublicTime({ kind: "range", from: new Date(post.published_at).toISOString(), through: dateClock(date, "18:00") });
    return { kind: deadlineWords.test(excerpt) ? "deadline" : "instant", at: dateClock(date, "18:00") };
  }
  const resolved = sourcePoint(excerpt, post, anchor);
  if (resolved.kind === "unknown") return null;
  if (resolved.kind === "date") return { kind: announcementDeadline(excerpt, post) ? "deadline" : "instant", at: dateClock(resolved.date, "18:00") };
  if (announcementDeadline(excerpt, post)) return { kind: "deadline", at: resolved.kind === "range" ? resolved.through : resolved.at };
  return normalizePublicTime(resolved);
}

/** Time metadata never rejects an otherwise supported action. */
export function resolveActionTime(action: Pick<ActionDraft, "action" | "invalidatesEvent"> & { timeExcerpt: string | null }, post: PublicV2PostRow,
  activityAnchor?: string, now = Date.now()): { time: BusinessTime; issue: string | null } {
  const publishedAt = new Date(post.published_at).toISOString();
  if (action.action === "confirm") return { time: { kind: "instant", at: publishedAt }, issue: null };
  const fallback = { time: defaultActionTime(action.action, post.published_at, now), issue: null };
  const invalid = (issue: string) => ({ time: { kind: "instant" as const, at: dateClock(publishedAt.slice(0, 10), "18:00") }, issue });
  try {
    if (!action.timeExcerpt?.trim()) return fallback;
    if (!quotedInPost(action.timeExcerpt, post.text)) return invalid("时间引文不在原帖中");
    if (action.action === "announce" && isUsageTime(action.timeExcerpt, post.text)) return invalid("时间引文是使用或领取期限，需核对发放时间");
    if (action.action === "announce") {
      const time = announcementTime(action.timeExcerpt, post, activityAnchor);
      return time ? { time: normalizePublicTime(time), issue: null } : invalid("预告时间无法解析，已保存默认时刻，等待核对");
    }
    const occurred = action.invalidatesEvent || action.action === "progress";
    const resolved = resolveEventExpression(action.timeExcerpt, post, !occurred, post.text, occurred ? activityAnchor : undefined, occurred);
    if (resolved.kind === "unknown") return invalid("动作时间无法解析，已保存默认时刻，等待核对");
    if (resolved.kind === "date") return fallback;
    if (occurred && isFutureSourceTime(resolved, publishedAt)) return invalid("活动结果时间尚未发生，已保存默认时刻，等待核对");
    return { time: normalizePublicTime(resolved), issue: null };
  } catch { return invalid("时间格式、时区或区间异常，已保存默认时刻，等待核对"); }
}
