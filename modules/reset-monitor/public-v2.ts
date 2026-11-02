import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

const text = z.string().min(1).regex(/\S/, "Text must not be blank");
// Explicit HTTP(S) authority, no user-info, whitespace or backslash normalization.
// The final lookahead makes the end absolute, including after a trailing newline.
export const sourceUrlPattern = /^[hH][tT][tT][pP][sS]?:\/\/[^\s/@?#\\]+(?:[/?#][^\s\\]*)?$(?![\s\S])/;
export const sourceUrlSchema = z.string().regex(sourceUrlPattern, "Source URL requires an explicit HTTP(S) authority without credentials, whitespace or backslashes")
  .pipe(z.url()).refine(value => {
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch { return false; }
  }, "Source URL must use HTTP(S) without credentials")
  .meta({ format: "uri", pattern: sourceUrlPattern.source });
export const timestampSchema = z.iso.datetime({ offset: true });
const businessTimestampSchema = timestampSchema
  .regex(/^(?!.*\.\d{10})/, "Business timestamps support at most nine fractional-second digits")
  .refine(value => {
    try { Temporal.Instant.from(value); return true; } catch { return false; }
  }, "Business timestamps require a valid instant")
  .meta({ format: "date-time", description: "Offset timestamp with at most nine fractional-second digits; public instants are normalized to UTC." });
export const calendarDate = z.iso.date();
export const localizedTextSchema = z.strictObject({
  en: text, zh: text, "zh-Hant": text, ja: text, ko: text, ru: text, es: text,
});
const identifier = text;
export const platformSchema = z.enum(["codex", "claude-code", "grok"]);
export const updateSourceSchema = z.strictObject({ postId: identifier, sourceId: identifier, url: sourceUrlSchema });
export const updateActions = ["announce", "confirm", "progress", "amend"] as const;
const timeZone = text.refine(value => {
  try { return !/^[+-]/.test(new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone); } catch { return false; }
}, "Invalid source time zone");
export const businessTimeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("instant"), at: businessTimestampSchema }),
  z.strictObject({ kind: z.literal("date"), date: calendarDate, timeZone }),
  z.strictObject({ kind: z.literal("range"), from: businessTimestampSchema, through: businessTimestampSchema })
    .refine(value => {
      // Zod may run a refinement even when a child string has format issues.
      try { return Temporal.Instant.compare(value.through, value.from) >= 0; } catch { return false; }
    }, "Range requires valid endpoints with its end at or after its start"),
  z.strictObject({ kind: z.literal("deadline"), at: businessTimestampSchema }),
]);
export type BusinessTime = z.infer<typeof businessTimeSchema>;
export const eventTimeSchema = z.union([businessTimeSchema, z.strictObject({ kind: z.literal("unknown") })]);
export type EventTime = z.infer<typeof eventTimeSchema>;

export const publicTimeSchema = businessTimeSchema;
export type PublicTime = z.infer<typeof publicTimeSchema>;
const updateFields = { id: identifier, publishedAt: timestampSchema, title: localizedTextSchema, summary: localizedTextSchema.nullable() };
function updateSchema() {
  const fields = { ...updateFields, time: publicTimeSchema };
  return z.discriminatedUnion("action", [
  z.strictObject({ ...fields, action: z.literal("confirm"), invalidatesEvent: z.literal(false), sources: z.array(updateSourceSchema) }),
  z.strictObject({ ...fields, action: z.enum(["announce", "progress"]), invalidatesEvent: z.literal(false), sources: z.array(updateSourceSchema).min(1) }),
  z.strictObject({ ...fields, action: z.literal("amend"), invalidatesEvent: z.boolean(), sources: z.array(updateSourceSchema).min(1) }),
  ]);
}
export const eventUpdateSchema = updateSchema();
export const rawEventUpdateSchema = eventUpdateSchema;
/** Preserve date precision and fractional seconds while expressing instants in UTC. */
export function normalizePublicTime(time: PublicTime): PublicTime {
  const value = publicTimeSchema.parse(time);
  const utc = (at: string) => at.endsWith("Z") ? at : Temporal.Instant.from(at).toString();
  if (value.kind === "date") return value;
  if (value.kind === "range") return { kind: "range", from: utc(value.from), through: utc(value.through) };
  return { ...value, at: utc(value.at) };
}
export function serializeEventTime(time: EventTime): PublicTime {
  if (time.kind === "unknown") throw new Error("Unknown time cannot be public");
  return normalizePublicTime(time);
}

/** Ordering uses source-local midnight for dates; it never supplies an occurrence time. */
export function businessTimeBoundary(time: BusinessTime): string {
  if (time.kind === "date") return Temporal.PlainDate.from(time.date).toZonedDateTime(time.timeZone).toInstant().toString();
  return time.kind === "range" ? time.from : time.at;
}
export function compareBusinessTime(a: BusinessTime, b: BusinessTime): number {
  return Temporal.Instant.compare(businessTimeBoundary(a), businessTimeBoundary(b));
}
/** A calendar date has occurred only once that date starts in its source time zone. */
export function isFutureBusinessTime(time: BusinessTime, at: string): boolean {
  const instant = Temporal.Instant.from(at);
  return time.kind === "date" ? time.date > instant.toZonedDateTimeISO(time.timeZone).toPlainDate().toString()
    : Temporal.Instant.compare(time.kind === "range" ? time.through : time.at, instant) > 0;
}

export const eventStatuses = ["announced", "in_progress", "completed", "cancelled"] as const;
export type EventStatus = (typeof eventStatuses)[number];
export const scopeSchema = z.strictObject({
  type: z.enum(["all_users", "paid_users", "selected_users", "unknown"]).describe("unknown means audience mapping is unresolved, not confirmed eligibility for everyone."),
  productCodes: z.array(identifier).describe("Empty means no catalog product restriction can be applied; it does not confirm coverage of all products."), planCodes: z.array(identifier), quotaWindowCodes: z.array(identifier), note: localizedTextSchema.nullable().describe("Concise localized audience label, such as All users or Paid users; actual eligibility and product restrictions remain in summaries."),
});
const eventObjectSchema = z.strictObject({
  id: identifier, type: z.enum(["direct_reset", "reset_credit", "bonus_credit"]), status: z.enum(eventStatuses),
  publishedAt: timestampSchema, title: localizedTextSchema, summary: localizedTextSchema.nullable(),
  time: publicTimeSchema, updates: z.array(eventUpdateSchema).min(1), scope: scopeSchema,
});
function validateEvent(event: z.infer<typeof eventObjectSchema>, context: z.RefinementCtx) {
  for (const key of ["productCodes", "planCodes", "quotaWindowCodes"] as const) {
    if (new Set(event.scope[key]).size !== event.scope[key].length) context.addIssue({ code: "custom", path: ["scope", key], message: "Catalog references must be unique" });
  }
  const ids = new Set<string>();
  event.updates.forEach((update, index) => {
    if (new Set(update.sources.map(source => source.postId)).size !== update.sources.length) context.addIssue({ code: "custom", path: ["updates", index, "sources"], message: "Source posts must be unique" });
    if (ids.has(update.id)) context.addIssue({ code: "custom", path: ["updates", index, "id"], message: "Update IDs must be unique" });
    ids.add(update.id);
    const prior = event.updates[index - 1];
    if (prior && (Date.parse(prior.publishedAt) < Date.parse(update.publishedAt)
      || Date.parse(prior.publishedAt) === Date.parse(update.publishedAt) && prior.id > update.id)) {
      context.addIssue({ code: "custom", path: ["updates", index], message: "Updates must be in descending publication order with ID ascending ties" });
    }
  });
}
export const resetEventSchema = eventObjectSchema.superRefine(validateEvent);
export const rawResetEventSchema = eventObjectSchema.extend({ updates: z.array(rawEventUpdateSchema).min(1) }).superRefine(validateEvent);
const listEventSchema = resetEventSchema;
export const sourceSchema = z.strictObject({
  id: identifier, type: z.enum(["official_social", "official_blog", "official_docs", "community", "other"]), name: localizedTextSchema,
  url: sourceUrlSchema,
});
const catalogEntry = z.strictObject({ code: identifier, name: localizedTextSchema });
export const catalogSchema = z.strictObject({ products: z.array(catalogEntry), plans: z.array(catalogEntry), quotaWindows: z.array(catalogEntry) });
const count = z.number().int().nonnegative();
export const statisticsSchema = z.strictObject({
  typicalInterval: z.strictObject({ value: z.number().positive(), unit: z.enum(["hour", "day"]), sampleCount: count }).nullable(),
  resetsLast30Days: count.nullable(), cardsLast30Days: count.nullable(), bonusesLast30Days: count.nullable(),
});
const overviewFields = {
  platform: platformSchema, sources: z.array(sourceSchema), catalog: catalogSchema, statistics: statisticsSchema,
  predictedResetTime: publicTimeSchema.nullable(), announcedResetTime: publicTimeSchema.nullable(), resetTime: publicTimeSchema.nullable(),
};
type OverviewFields = {
  sources: z.infer<typeof sourceSchema>[]; catalog: z.infer<typeof catalogSchema>;
  announcedResetTime: PublicTime | null; resetTime: PublicTime | null;
};
function validateOverview(value: OverviewFields, context: z.RefinementCtx) {
  const unique = (ids: string[], path: (string | number)[]) => {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path, message: "IDs must be unique" });
  };
  unique(value.sources.map(source => source.id), ["sources"]);
  for (const key of ["products", "plans", "quotaWindows"] as const) unique(value.catalog[key].map(entry => entry.code), ["catalog", key]);
}
export const platformOverviewSchema = z.strictObject(overviewFields).superRefine(validateOverview);
export const overviewSchema = z.strictObject({
  schemaVersion: z.literal(2), generatedAt: timestampSchema, platforms: z.array(platformOverviewSchema),
}).superRefine((value, context) => {
  if (new Set(value.platforms.map(platform => platform.platform)).size !== value.platforms.length) {
    context.addIssue({ code: "custom", path: ["platforms"], message: "Platforms must be unique" });
  }
});
function validateEventOrder(events: Array<{ id: string; time: PublicTime }>, context: z.RefinementCtx, path: string) {
  if (new Set(events.map(event => event.id)).size !== events.length) context.addIssue({ code: "custom", path: [path], message: "Event IDs must be unique" });
  events.forEach((event, index) => {
    const prior = events[index - 1];
    if (prior && publicTimeSchema.safeParse(prior.time).success && publicTimeSchema.safeParse(event.time).success
      && (compareBusinessTime(prior.time, event.time) < 0 || compareBusinessTime(prior.time, event.time) === 0 && prior.id > event.id)) {
      context.addIssue({ code: "custom", path: [path, index], message: "Events must be in descending time order with ID ascending ties" });
    }
  });
}
/** Internal validated projection; HTTP exposes only overview or a filtered list. */
export const resetSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(2), generatedAt: timestampSchema, ...overviewFields, events: z.array(resetEventSchema),
}).superRefine((snapshot, context) => {
  validateOverview(snapshot, context);
  validateEventOrder(snapshot.events, context, "events");
  const sources = new Set(snapshot.sources.map(source => source.id));
  snapshot.events.forEach((event, index) => {
    event.updates.forEach((update, updateIndex) => {
      update.sources.forEach((source, sourceIndex) => {
        if (!sources.has(source.sourceId)) context.addIssue({ code: "custom", path: ["events", index, "updates", updateIndex, "sources", sourceIndex], message: "Unknown source account ID" });
      });
    });
    for (const [field, key] of [["productCodes", "products"], ["planCodes", "plans"], ["quotaWindowCodes", "quotaWindows"]] as const) {
      const codes = new Set(snapshot.catalog[key].map(entry => entry.code));
      if (event.scope[field].some(code => !codes.has(code))) context.addIssue({ code: "custom", path: ["events", index, "scope", field], message: "Unknown catalog code" });
    }
  });
});
export const rawResetSnapshotSchema = resetSnapshotSchema.safeExtend({
  announcedResetTime: publicTimeSchema.nullable(), events: z.array(rawResetEventSchema),
});
export const eventListSchema = z.strictObject({
  list: z.array(listEventSchema),
  pagination: z.strictObject({ limit: z.number().int().min(1).max(100).nullable(), total: count, hasMore: z.boolean(), nextCursor: text.nullable() }),
}).superRefine((value, context) => {
  validateEventOrder(value.list, context, "list");
  const page = value.pagination;
  if (page.total < value.list.length || page.limit !== null && value.list.length > page.limit
    || page.hasMore !== (page.nextCursor !== null) || page.hasMore && (!value.list.length || page.total <= value.list.length)
    || page.limit === null && (page.total !== value.list.length || page.hasMore || page.nextCursor !== null)) {
    context.addIssue({ code: "custom", path: ["pagination"], message: "Pagination does not match returned events" });
  }
});
export type ResetSnapshot = z.infer<typeof resetSnapshotSchema>;
export type ResetEvent = z.infer<typeof resetEventSchema>;
export type EventList = z.infer<typeof eventListSchema>;
export type PlatformOverview = z.infer<typeof platformOverviewSchema>;
export type Overview = z.infer<typeof overviewSchema>;

export type PublicV2Config = {
  platform: z.infer<typeof platformSchema>;
  catalog: z.infer<typeof catalogSchema>;
};
