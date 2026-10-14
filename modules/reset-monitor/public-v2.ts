import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

const text = z.string().min(1).regex(/\S/, "Text must not be blank");
// Explicit HTTP(S) authority, no user-info, whitespace or backslash normalization.
// The final lookahead makes the end absolute, including after a trailing newline.
export const sourceUrlPattern = /^[hH][tT][tT][pP][sS]?:\/\/[^\s/@?#\\]+(?:[/?#][^\s\\]*)?$(?![\s\S])/;
export const timestampSchema = z.iso.datetime({ offset: true });
export const calendarDate = z.iso.date();
export const localizedTextSchema = z.strictObject({
  en: text, zh: text.optional(), "zh-Hant": text.optional(), ja: text.optional(), ko: text.optional(), ru: text.optional(), es: text.optional(),
});
const identifier = text;
const timeZone = text.refine(value => {
  try { return !/^[+-]/.test(new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone); } catch { return false; }
}, "Invalid source time zone");
export const eventTimeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("instant"), at: timestampSchema }),
  z.strictObject({ kind: z.literal("date"), date: calendarDate, timeZone }),
  z.strictObject({ kind: z.literal("range"), from: timestampSchema, through: timestampSchema })
    .refine(value => Date.parse(value.through) >= Date.parse(value.from), "Range end precedes start"),
  z.strictObject({ kind: z.literal("deadline"), at: timestampSchema }),
  z.strictObject({ kind: z.literal("unknown") }),
]);
export type EventTime = z.infer<typeof eventTimeSchema>;

// Only validate a supplied threshold; never supply a missing threshold.
function thresholdMatches(time: EventTime, threshold: string | null): boolean {
  if (time.kind === "unknown") return threshold === null;
  if (threshold === null) return false;
  try {
    const expected = time.kind === "date"
      ? Temporal.PlainDate.from(time.date).toZonedDateTime(time.timeZone).epochMilliseconds
      : Date.parse(time.kind === "range" ? time.from : time.at);
    return Date.parse(threshold) === expected;
  } catch { return false; }
}
function sameTime(left: EventTime, right: EventTime): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "date" && right.kind === "date") return left.date === right.date && left.timeZone === right.timeZone;
  if (left.kind === "range" && right.kind === "range") return Date.parse(left.from) === Date.parse(right.from) && Date.parse(left.through) === Date.parse(right.through);
  if ((left.kind === "instant" || left.kind === "deadline") && (right.kind === "instant" || right.kind === "deadline")) return Date.parse(left.at) === Date.parse(right.at);
  return left.kind === "unknown";
}
export const announcementSchema = z.strictObject({ time: eventTimeSchema, displayUntil: timestampSchema.nullable() })
  .refine(value => thresholdMatches(value.time, value.displayUntil), "displayUntil must match the time boundary");
export const statisticalForecastSchema = z.strictObject({ time: eventTimeSchema, expiresAt: timestampSchema.nullable() })
  .refine(value => thresholdMatches(value.time, value.expiresAt), "expiresAt must match the time boundary");
export const bonusCreditSchema = z.strictObject({
  amount: localizedTextSchema.nullable(), eligibility: localizedTextSchema.nullable(), claimMethod: localizedTextSchema.nullable(),
  usageTerms: localizedTextSchema.nullable(), claimDeadline: eventTimeSchema.nullable(), expiresAt: eventTimeSchema.nullable(),
});
export const eventStatuses = ["announced", "in_progress", "completed", "cancelled", "available", "claim_closed", "expired"] as const;
export type EventStatus = (typeof eventStatuses)[number];
export const scopeSchema = z.strictObject({
  type: z.enum(["all_users", "paid_users", "selected_users", "unknown"]),
  productCodes: z.array(identifier), planCodes: z.array(identifier), quotaWindowCodes: z.array(identifier), note: localizedTextSchema.nullable(),
});
const eventObjectSchema = z.strictObject({
  id: identifier, type: z.enum(["direct_reset", "reset_credit", "bonus_credit"]), status: z.enum(eventStatuses),
  publishedAt: timestampSchema, title: localizedTextSchema, summary: localizedTextSchema.nullable(), details: localizedTextSchema.nullable(),
  time: eventTimeSchema, announcement: announcementSchema.nullable(), sourceIds: z.array(identifier), scope: scopeSchema,
  bonusCredit: bonusCreditSchema.nullable(),
});
export const resetEventSchema = eventObjectSchema.superRefine((event, context) => {
  const allowed = event.type === "bonus_credit"
    ? ["announced", "available", "claim_closed", "expired", "cancelled"]
    : ["announced", "in_progress", "completed", "cancelled"];
  if (!allowed.includes(event.status)) context.addIssue({ code: "custom", path: ["status"], message: "Status is invalid for event type" });
  if (event.type !== "bonus_credit" && event.bonusCredit !== null) context.addIssue({ code: "custom", path: ["bonusCredit"], message: "Only bonus events contain bonus details" });
});
export const sourceSchema = z.strictObject({
  id: identifier, type: z.enum(["official_social", "official_blog", "official_docs", "community", "other"]), name: localizedTextSchema,
  url: z.string().regex(sourceUrlPattern, "Source URL requires an explicit HTTP(S) authority without credentials, whitespace or backslashes")
    .pipe(z.url()).refine(value => {
      try {
        const parsed = new URL(value);
        return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
      } catch { return false; }
    }, "Source URL must use HTTP(S) without credentials")
    .meta({ format: "uri", pattern: sourceUrlPattern.source }),
});
const catalogEntry = z.strictObject({ code: identifier, name: localizedTextSchema });
export const catalogSchema = z.strictObject({ products: z.array(catalogEntry), plans: z.array(catalogEntry), quotaWindows: z.array(catalogEntry) });
const dateRange = z.strictObject({ from: calendarDate, through: calendarDate }).refine(value => value.from <= value.through, "Range end precedes start");

/** Validate only the range supplied by the API; never enlarge the displayed calendar. */
function calendarCoversTime(range: { from: string; through: string }, time: EventTime): boolean {
  if (time.kind === "unknown") return false;
  if (time.kind === "date") return range.from <= time.date && range.through >= time.date;
  const anchor = time.kind === "range" ? time.from : time.at;
  const day = Temporal.Instant.from(anchor).toZonedDateTimeISO("UTC").toPlainDate();
  return Temporal.PlainDate.compare(range.from, day.subtract({ days: 1 })) <= 0
    && Temporal.PlainDate.compare(range.through, day.add({ days: 1 })) >= 0;
}
const count = z.number().int().nonnegative();
export const statisticsSchema = z.strictObject({
  typicalInterval: z.strictObject({ value: z.number().positive(), unit: z.enum(["hour", "day"]), sampleCount: count }).nullable(),
  resetsLast30Days: count.nullable(), cardsLast30Days: count.nullable(), bonusesLast30Days: count.nullable(),
});
export const resetSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(2), platform: z.enum(["codex", "claude-code", "grok"]), generatedAt: timestampSchema,
  sources: z.array(sourceSchema), catalog: catalogSchema, events: z.array(resetEventSchema),
  overview: z.strictObject({ latestDirectResetEventId: identifier.nullable(), latestCompletedResetEventId: identifier.nullable(), statisticalForecast: statisticalForecastSchema.nullable() }),
  statistics: statisticsSchema,
  history: z.strictObject({ range: dateRange.nullable(), total: count, eventIds: z.array(identifier) }),
  calendar: z.strictObject({ range: dateRange.nullable(), marks: z.array(z.strictObject({
    id: identifier, eventId: identifier, kind: z.enum(["event", "claim_deadline", "expiry"]), time: eventTimeSchema,
  })) }),
}).superRefine((snapshot, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
  const unique = (ids: string[], path: (string | number)[]) => {
    if (new Set(ids).size !== ids.length) issue(path, "IDs must be unique");
  };
  unique(snapshot.sources.map(source => source.id), ["sources"]);
  unique(snapshot.events.map(event => event.id), ["events"]);
  unique(snapshot.history.eventIds, ["history", "eventIds"]);
  unique(snapshot.calendar.marks.map(mark => mark.id), ["calendar", "marks"]);
  const events = new Map(snapshot.events.map(event => [event.id, event]));
  const sourceIds = new Set(snapshot.sources.map(source => source.id));
  const catalogs = { productCodes: "products", planCodes: "plans", quotaWindowCodes: "quotaWindows" } as const;
  for (const key of Object.values(catalogs)) unique(snapshot.catalog[key].map(entry => entry.code), ["catalog", key]);
  snapshot.events.forEach((event, index) => {
    unique(event.sourceIds, ["events", index, "sourceIds"]);
    event.sourceIds.forEach(id => { if (!sourceIds.has(id)) issue(["events", index, "sourceIds"], "Unknown source ID"); });
    for (const [field, catalog] of Object.entries(catalogs) as [keyof typeof catalogs, (typeof catalogs)[keyof typeof catalogs]][]) {
      unique(event.scope[field], ["events", index, "scope", field]);
      const codes = new Set(snapshot.catalog[catalog].map(entry => entry.code));
      event.scope[field].forEach(code => { if (!codes.has(code)) issue(["events", index, "scope", field], "Unknown catalog code"); });
    }
  });
  for (const key of ["latestDirectResetEventId", "latestCompletedResetEventId"] as const) {
    const id = snapshot.overview[key];
    if (id !== null) {
      const event = events.get(id);
      if (!event || event.type !== "direct_reset" || (key === "latestCompletedResetEventId" && event.status !== "completed")) {
        issue(["overview", key], "Reference must point to the appropriate direct reset event");
      }
    }
  }
  snapshot.history.eventIds.forEach(id => { if (!events.has(id)) issue(["history", "eventIds"], "Unknown event ID"); });
  if (snapshot.history.total !== snapshot.history.eventIds.length) issue(["history", "total"], "Complete snapshot total must equal supplied records");
  if (snapshot.calendar.range === null && snapshot.calendar.marks.length > 0) issue(["calendar", "range"], "Calendar marks require a calendar range");
  snapshot.calendar.marks.forEach((mark, index) => {
    const event = events.get(mark.eventId);
    if (!event) issue(["calendar", "marks", index, "eventId"], "Unknown event ID");
    if (mark.kind !== "event" && event?.type !== "bonus_credit") issue(["calendar", "marks", index, "kind"], "Bonus milestone must reference a bonus event");
    if (mark.time.kind === "unknown") issue(["calendar", "marks", index, "time"], "Unknown times cannot mark a calendar date");
    if (snapshot.calendar.range && !calendarCoversTime(snapshot.calendar.range, mark.time)) {
      issue(["calendar", "range"], "Calendar range must cover each date-only mark, and the UTC anchor date plus one day on each side for precise marks");
    }
    const sourceTime = mark.kind === "event" ? event?.time : mark.kind === "claim_deadline" ? event?.bonusCredit?.claimDeadline : event?.bonusCredit?.expiresAt;
    if (!sourceTime || !sameTime(sourceTime, mark.time)) issue(["calendar", "marks", index, "time"], "Calendar mark must match its referenced event time");
  });
});
export type ResetSnapshot = z.infer<typeof resetSnapshotSchema>;
export type ResetEvent = z.infer<typeof resetEventSchema>;
export type BonusCredit = z.infer<typeof bonusCreditSchema>;

/** Reviewed data is private storage, never an extra field on the public response. */
export const reviewedEventSchema = eventObjectSchema.pick({
  status: true, publishedAt: true, title: true, summary: true, details: true,
  time: true, announcement: true, scope: true, bonusCredit: true,
}).extend({
  evidenceVersion: text,
  evidence: z.array(z.strictObject({ postId: text, excerpt: text })).min(1),
  timeResolutions: z.array(z.strictObject({
    field: z.enum(["claimDeadline", "expiresAt"]), time: eventTimeSchema,
    postId: text, excerpt: text, activityAnchor: timestampSchema,
    yearBasis: z.enum(["explicit", "activity"]), timeZone: text,
    zoneBasis: z.enum(["expression", "post", "activity", "publication"]),
  })).optional(),
  /** Preserve v1's nullable presentation when this is the only stored addition. */
  legacyPresentationWasNull: z.boolean().optional(),
});
export type ReviewedEvent = z.infer<typeof reviewedEventSchema>;
export type PublicV2Config = {
  platform: ResetSnapshot["platform"];
  catalog: z.infer<typeof catalogSchema>;
};
