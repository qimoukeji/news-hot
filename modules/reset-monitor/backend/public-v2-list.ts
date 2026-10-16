import { Temporal } from "@js-temporal/polyfill";
import { decodeCursor, encodeCursor, queryBinding } from "@aihot/backend/lib/cursor";
import { calendarDate, eventListSchema, type ResetSnapshot } from "../public-v2.ts";
import { timeBoundary } from "./public-v2.ts";

export class PublicV2QueryError extends Error {}
export interface PublicV2Query { from: string; to: string; timeZone: string; limit: number | null; cursor: string | null }

export function parsePublicV2Query(query: Record<string, unknown>, now = Date.now()): PublicV2Query {
  for (const [key, value] of Object.entries(query)) {
    if (!["from", "to", "timeZone", "limit", "cursor"].includes(key) || typeof value !== "string") throw new PublicV2QueryError("Unknown or repeated query parameter");
  }
  let timeZone: string;
  try {
    timeZone = new Intl.DateTimeFormat("en", { timeZone: (query.timeZone as string | undefined)?.trim() || "UTC" }).resolvedOptions().timeZone;
    if (/^[+-]/.test(timeZone)) throw new Error("Numeric offsets are not named time zones");
  } catch { throw new PublicV2QueryError("Time zone must be a valid IANA name"); }
  let from = (query.from as string | undefined)?.trim() || null;
  let to = (query.to as string | undefined)?.trim() || null;
  if (from && !calendarDate.safeParse(from).success || to && !calendarDate.safeParse(to).success) throw new PublicV2QueryError("Dates must be valid YYYY-MM-DD values");
  const month = Temporal.PlainDate.from(from ?? to ?? Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate());
  from ??= month.with({ day: 1 }).toString();
  to ??= month.with({ day: month.daysInMonth }).toString();
  const start = Temporal.PlainDate.from(from), end = Temporal.PlainDate.from(to);
  if (from > to || (end.year - start.year) * 12 + end.month - start.month > 5) throw new PublicV2QueryError("Date range must span at most six calendar months in ascending order");
  const rawLimit = (query.limit as string | undefined)?.trim() || null;
  const limit = rawLimit === null ? null : Number(rawLimit);
  if (rawLimit !== null && (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit! > 100)) throw new PublicV2QueryError("Limit must be an integer from 1 to 100");
  const cursor = query.cursor as string | undefined;
  if (cursor !== undefined && (!cursor || cursor.length > 4096 || !/^rmv2\.[A-Za-z0-9_-]+$/.test(cursor) || limit === null)) throw new PublicV2QueryError("Cursor requires a valid limit and encoding");
  return { from, to, timeZone, limit, cursor: cursor ?? null };
}

export function paginatePublicV2(snapshot: ResetSnapshot, query: PublicV2Query) {
  const { from, to, timeZone, limit, cursor } = query;
  const binding = queryBinding({ platform: snapshot.platform, from, to, timeZone, limit });
  const start = Temporal.PlainDate.from(from).toZonedDateTime(timeZone).epochMilliseconds;
  const end = Temporal.PlainDate.from(to).add({ days: 1 }).toZonedDateTime(timeZone).epochMilliseconds;
  const events = snapshot.events.filter(event => {
    if (event.time.length === 10) return event.time >= from && event.time <= to;
    const at = Date.parse(timeBoundary(event.time)!);
    return at >= start && at < end;
  });
  let remaining = events;
  if (cursor) {
    try {
      const value = decodeCursor<{ binding: string; at: number; id: string }>("rmv2", cursor);
      if (limit === null || value.binding !== binding || !Number.isFinite(value.at) || typeof value.id !== "string" || !value.id.trim()) throw new Error("Cursor does not match the query");
      remaining = events.filter(event => {
        const at = Date.parse(timeBoundary(event.time)!);
        return at < value.at || at === value.at && event.id > value.id;
      });
    } catch { throw new PublicV2QueryError("Cursor is malformed or does not match the query"); }
  }
  const list = limit === null ? remaining : remaining.slice(0, limit);
  const hasMore = remaining.length > list.length;
  const last = list.at(-1);
  return eventListSchema.parse({ list: list.map(({ bonusCredit: _bonusCredit, ...event }) => event), pagination: {
    limit, total: events.length, hasMore,
    nextCursor: hasMore && last ? encodeCursor("rmv2", { binding, at: Date.parse(timeBoundary(last.time)!), id: last.id }) : null,
  } });
}
