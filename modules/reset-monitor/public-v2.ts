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
export const eventTimeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("instant"), at: timestampSchema }),
  z.strictObject({ kind: z.literal("date"), date: calendarDate, timeZone }),
  z.strictObject({ kind: z.literal("range"), from: timestampSchema, through: timestampSchema })
    .refine(value => Date.parse(value.through) >= Date.parse(value.from), "Range end precedes start"),
  z.strictObject({ kind: z.literal("deadline"), at: timestampSchema }),
  z.strictObject({ kind: z.literal("unknown") }),
]);
export type EventTime = z.infer<typeof eventTimeSchema>;

export const publicTimeSchema = z.union([timestampSchema, calendarDate, z.string().refine(value => {
  const parts = value.split("/");
  return parts.length === 2 && parts.every(part => timestampSchema.safeParse(part).success) && Date.parse(parts[1]!) >= Date.parse(parts[0]!);
}, "Time requires an ISO timestamp, date or timestamp interval")]);
export type PublicTime = z.infer<typeof publicTimeSchema>;
const updateFields = { id: identifier, publishedAt: timestampSchema, time: publicTimeSchema.describe("Saved action time. When unresolved, announce defaults to the earliest source's Beijing calendar date and completes only after that day ends; other actions default to source publication time."), title: localizedTextSchema, summary: localizedTextSchema.nullable() };
export const eventUpdateSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...updateFields, action: z.literal("confirm"), invalidatesEvent: z.literal(false), sources: z.array(updateSourceSchema) }),
  z.strictObject({ ...updateFields, action: z.enum(["announce", "progress"]), invalidatesEvent: z.literal(false), sources: z.array(updateSourceSchema).min(1) }),
  z.strictObject({ ...updateFields, action: z.literal("amend"), invalidatesEvent: z.boolean(), sources: z.array(updateSourceSchema).min(1) }),
]);
/** Preserve date precision and fractional seconds while expressing instants in UTC. */
export function normalizePublicTime(time: PublicTime): PublicTime {
  if (time.length === 10) return time;
  return time.split("/").map(at => at.endsWith("Z") ? at : Temporal.Instant.from(at).toString()).join("/");
}
export function serializeEventTime(time: EventTime): PublicTime {
  if (time.kind === "unknown") throw new Error("Unknown time cannot be public");
  return normalizePublicTime(time.kind === "date" ? time.date : time.kind === "range" ? `${time.from}/${time.through}` : time.at);
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
const timeKey = (time: PublicTime) => Date.parse(time.split("/")[0]!);
function validateEventOrder(events: Array<{ id: string; time: PublicTime }>, context: z.RefinementCtx, path: string) {
  if (new Set(events.map(event => event.id)).size !== events.length) context.addIssue({ code: "custom", path: [path], message: "Event IDs must be unique" });
  events.forEach((event, index) => {
    const prior = events[index - 1];
    if (prior && (timeKey(prior.time) < timeKey(event.time) || timeKey(prior.time) === timeKey(event.time) && prior.id > event.id)) {
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
