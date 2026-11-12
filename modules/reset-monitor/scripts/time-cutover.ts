import { Temporal } from "@js-temporal/polyfill";
import type { Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import type { ActionInput, ActionRow, SourcePostRow } from "../actions.ts";
import { loadInvalidatedInferenceIds, loadManualConfirmationIds } from "../backend/action-store.ts";
import { businessTimeSchema, calendarDate, normalizePublicTime, type BusinessTime, type ResetEvent } from "../public-v2.ts";
import { editorialFacts, editorialPromptVersion, editorialRecordVersion } from "../backend/event-editorial.ts";
import { publicV2EventTitle } from "../backend/public-v2.ts";

/** Historical values never enter the current action reader or reducer. */
export type LegacyTime = BusinessTime | { kind: "date"; date: string; timeZone?: string }
  | { kind: "unknown" } | string | null;
export type LegacyAction = Omit<ActionRow, "time"> & { time: LegacyTime };
export type LegacyTimeInput = Omit<ActionInput, "actions"> & { actions: LegacyAction[] };
export interface TimeChange {
  actionId: string; eventId: string; before: LegacyTime; after: BusinessTime;
  reason: string; reviewPostIds: string[];
}

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
export function sourceInstant(value: Date | string) {
  const text = value instanceof Date ? value.toISOString() : value;
  return Temporal.Instant.from(text).toString();
}
export function legacySources(action: LegacyAction, input: LegacyTimeInput) {
  return input.posts.filter(post => !post.context_only && action.sources.some(source => source.postId === post.id))
    .sort((a, b) => Temporal.Instant.compare(sourceInstant(a.published_at), sourceInstant(b.published_at)) || a.id.localeCompare(b.id));
}
const atHour = (day: string, hour: string) => `${calendarDate.parse(day)}T${hour}:00:00Z`;
export function historicalDefault(action: LegacyAction["action"], publishedAt: string): BusinessTime {
  if (action === "announce") return { kind: "instant", at: atHour(publishedAt.slice(0, 10), "18") };
  if (action !== "amend") return { kind: "instant", at: publishedAt };
  const sameDay = Temporal.Instant.from(atHour(publishedAt.slice(0, 10), "10"));
  const boundary = Temporal.Instant.compare(sameDay, publishedAt) >= 0 ? sameDay : sameDay.add({ hours: 24 });
  return { kind: "instant", at: boundary.toString() };
}

function decode(value: LegacyTime): unknown {
  if (typeof value !== "string") return value;
  if (calendarDate.safeParse(value).success) return { kind: "date", date: value };
  const interval = value.split("/");
  return interval.length === 2 ? { kind: "range", from: interval[0], through: interval[1] } : { kind: "instant", at: value };
}

function convert(value: LegacyTime, action: LegacyAction["action"], publishedAt: string): BusinessTime {
  const decoded = decode(value);
  if (decoded === null || typeof decoded === "object" && "kind" in decoded && decoded.kind === "unknown") return historicalDefault(action, publishedAt);
  if (typeof decoded !== "object" || decoded === null || !("kind" in decoded)) throw new Error("Invalid historical time");
  if (decoded.kind === "date") {
    if (!("date" in decoded) || typeof decoded.date !== "string") throw new Error("Invalid historical date");
    calendarDate.parse(decoded.date);
    if ("timeZone" in decoded && decoded.timeZone !== undefined) {
      if (typeof decoded.timeZone !== "string") throw new Error("Invalid historical time zone");
      Temporal.PlainDate.from(decoded.date).toZonedDateTime(decoded.timeZone);
    }
    return action === "announce" ? { kind: "instant", at: atHour(decoded.date, "18") } : historicalDefault(action, publishedAt);
  }
  if (decoded.kind === "range" && "from" in decoded && "through" in decoded) {
    const endpoint = (value: unknown, start: boolean) => {
      if (typeof value !== "string") throw new Error("Invalid historical range endpoint");
      if (!calendarDate.safeParse(value).success) return value;
      return start ? value <= publishedAt.slice(0, 10) ? publishedAt : atHour(value, "08") : atHour(value, "18");
    };
    return normalizePublicTime(businessTimeSchema.parse({ kind: "range", from: endpoint(decoded.from, true), through: endpoint(decoded.through, false) }));
  }
  if (decoded.kind === "deadline" && "at" in decoded && typeof decoded.at === "string" && calendarDate.safeParse(decoded.at).success) {
    return { kind: "deadline", at: atHour(decoded.at, "18") };
  }
  return normalizePublicTime(businessTimeSchema.parse(decoded));
}

export function planTimeCutover(input: LegacyTimeInput) {
  const changes: TimeChange[] = [], problems: Array<{ actionId: string; eventId: string; before: LegacyTime; reason: string }> = [];
  const actions: ActionRow[] = input.actions.map(action => {
    let posts: SourcePostRow[], publishedAt: string;
    try {
      posts = legacySources(action, input);
      if (action.sources.length && posts.length !== new Set(action.sources.map(source => source.postId)).size) throw new Error("Missing or context-only source");
      if (!posts.length && (action.action !== "confirm" || action.invalidates_event)) throw new Error("Only confirmations may be source-free");
      publishedAt = sourceInstant(posts[0]?.published_at ?? action.created_at);
    } catch {
      problems.push({ actionId: action.id, eventId: action.event_id, before: action.time,
        reason: "No valid publication time or action source; repair evidence before cutover" });
      // This candidate cannot be applied; use a valid placeholder solely to finish the inventory.
      return { ...action, time: { kind: "instant", at: "1970-01-01T18:00:00Z" } };
    }
    let time: BusinessTime, reason = "Normalize historical business time", reviewPostIds: string[] = [];
    try {
      if (action.action === "confirm" && posts.length) {
        const stored = businessTimeSchema.safeParse(action.time);
        time = stored.success && stored.data.kind === "instant" && stored.data.at.endsWith("Z")
          && Temporal.Instant.compare(stored.data.at, publishedAt) === 0 ? stored.data : { kind: "instant", at: publishedAt };
        reason = "Official confirmation uses earliest source publication";
      } else if (action.action === "confirm" && !posts.length && typeof action.time === "object" && action.time?.kind === "instant") {
        // Keep accepted manual and inferred instants byte-for-byte, including historical 10:00/18:00 cutoffs.
        time = businessTimeSchema.parse(action.time);
      } else if (action.action === "confirm" && !posts.length) {
        if (action.time === null || typeof action.time === "object" && action.time.kind === "unknown") throw new Error("Missing source-free time");
        const converted = convert(action.time, "announce", publishedAt);
        time = { kind: "instant", at: converted.kind === "range" ? converted.through : converted.at };
      } else time = convert(action.time, action.action, publishedAt);
    } catch {
      time = historicalDefault("announce", publishedAt);
      reason = "Invalid historical time; publication-day 18:00 UTC fallback requires review";
      reviewPostIds = posts.map(post => post.id);
      if (!reviewPostIds.length) problems.push({ actionId: action.id, eventId: action.event_id, before: action.time,
        reason: "Invalid source-free confirmation requires operator repair" });
    }
    if (!same(action.time, time)) changes.push({ actionId: action.id, eventId: action.event_id, before: action.time, after: time, reason, reviewPostIds });
    return { ...structuredClone(action), time };
  });
  return { after: { ...structuredClone(input), actions } satisfies ActionInput, changes, problems };
}

/** The offline reader deliberately does not call loadActionInput, whose contract is current-only. */
export async function loadLegacyTimeInput(db: Db, monitorId: string): Promise<LegacyTimeInput> {
  const events = await db<LegacyTimeInput["events"]>`SELECT id,type,title,summary,scope,withdrawn,created_at,updated_at FROM monitor_event_records WHERE monitor_id=${monitorId} ORDER BY id`;
  const posts = await db<LegacyTimeInput["posts"]>`SELECT id,author,published_at,url,text,quoted_post,reply_to,context_only,filtered_out,title,summary,source_receipt_id,model_receipt_id,processing_status,review_reason,created_at,updated_at FROM monitor_source_posts WHERE monitor_id=${monitorId} ORDER BY id`;
  const actions = await db<LegacyAction[]>`SELECT id,event_id,sequence,action,invalidates_event,title,summary,time,sources,created_at,updated_at FROM monitor_event_actions WHERE monitor_id=${monitorId} ORDER BY id`;
  const editorials = await db<{ key: string; value: NonNullable<ActionInput["editorials"]>[string] }[]>`SELECT key,value FROM monitor_state WHERE monitor_id=${monitorId} AND starts_with(key,'public_v2:overview:') ORDER BY key`;
  const standalone = await db<{ key: string }[]>`SELECT key FROM monitor_state WHERE monitor_id=${monitorId} AND starts_with(key,'recognition:standalone-followup:') ORDER BY key`;
  return { events, posts, actions, editorials: Object.fromEntries(editorials.map(row => [row.key.slice("public_v2:overview:".length), row.value])),
    standaloneFollowupIds: new Set(standalone.map(row => row.key.slice("recognition:standalone-followup:".length))),
    invalidatedInferenceIds: await loadInvalidatedInferenceIds(db, monitorId),
    manualConfirmationIds: await loadManualConfirmationIds(db, monitorId) };
}

export const timeCutoverFingerprint = (value: unknown) => sha256(stableJson(value));

/** Reconstruct old display values only for verifying the saved notification fingerprint. */
export function legacyDisplayTime(value: LegacyTime, action: LegacyAction["action"], publishedAt: string) {
  const decoded = decode(value);
  if (decoded === null) {
    if (action === "announce") return null;
    const time = historicalDefault(action, publishedAt);
    return action === "amend" && time.kind === "instant" ? { ...time, at: new Date(time.at).toISOString() } : time;
  }
  if (typeof decoded === "object" && decoded && "kind" in decoded && decoded.kind === "date") {
    if (!("date" in decoded) || typeof decoded.date !== "string") throw new Error("Invalid old date");
    return { kind: "date", date: calendarDate.parse(decoded.date), timeZone: "timeZone" in decoded ? decoded.timeZone : "Asia/Shanghai" };
  }
  return normalizePublicTime(businessTimeSchema.parse(decoded));
}

export function legacyEventTime(eventId: string, input: LegacyTimeInput) {
  const actions = input.actions.filter(action => action.event_id === eventId).flatMap(action => {
    const posts = legacySources(action, input);
    return posts.length || action.action === "confirm" && !action.sources.length && action.time
      ? [{ action, publishedAt: new Date(posts[0]?.published_at ?? action.created_at).toISOString() }] : [];
  }).sort((a, b) => a.action.sequence - b.action.sequence || a.action.id.localeCompare(b.action.id));
  const first = actions.findIndex(({ action }) => action.action === "announce" || action.action === "confirm" || input.standaloneFollowupIds?.has(action.id));
  if (first < 0) return null;
  let status: ResetEvent["status"] = actions[first]!.action.action === "amend" ? "in_progress" : "announced";
  let time: ReturnType<typeof legacyDisplayTime> = null, official = false;
  for (const { action, publishedAt } of actions.slice(first)) {
    if (action.action === "amend" && action.invalidates_event) { status = "cancelled"; time = legacyDisplayTime(action.time, "amend", publishedAt); official = false; }
    else if (action.action === "confirm" && status !== "cancelled") {
      if (!action.sources.length && !input.manualConfirmationIds?.has(action.id) && input.invalidatedInferenceIds?.has(action.id)) continue;
      if (!action.sources.length && official) continue;
      status = "completed"; time = legacyDisplayTime(action.time, "confirm", publishedAt); official = action.sources.length > 0;
    } else if (action.action === "announce" && status !== "cancelled" && !official) { status = "announced"; time = legacyDisplayTime(action.time, "announce", publishedAt); }
    else if (action.action === "progress" && status !== "cancelled" && !official) { status = "in_progress"; time = legacyDisplayTime(action.time, "progress", publishedAt); }
    else if (action.action === "amend" && status === "in_progress") time = legacyDisplayTime(action.time, "amend", publishedAt);
  }
  return { status, time, actions };
}

/** Reuse the current projection for non-time fields, but hash the historical status and times. */
export function legacyProjectedEvent(row: LegacyTimeInput["events"][number], input: LegacyTimeInput,
  event: ResetEvent, projected: ActionInput, product: string) {
  const old = legacyEventTime(row.id, input);
  if (!old) return null;
  const latest = old.actions.at(-1)?.action.id;
  return { ...event, status: old.status, time: old.time,
    title: publicV2EventTitle(product, row, projected.actions.find(action => action.id === latest), old.status),
    updates: event.updates.map(update => {
      const { action, publishedAt } = old.actions.find(({ action }) => action.id === update.id)!;
      return { ...update, time: legacyDisplayTime(action.time, action.action, publishedAt) };
    }) };
}

export function legacyEditorialVersion(row: LegacyTimeInput["events"][number], input: LegacyTimeInput) {
  const facts = editorialFacts(row, planTimeCutover(input).after);
  const legacyFacts = facts && { ...facts, actions: facts.actions.map(action => ({ ...action, time: input.actions.find(old => old.id === action.id)!.time })) };
  return timeCutoverFingerprint({ prompt: editorialPromptVersion, facts: legacyFacts });
}

export function legacyEditorialStatus(row: LegacyTimeInput["events"][number], input: LegacyTimeInput): "ready" | "edited" | null {
  const state = input.editorials?.[row.id];
  if (!state || state.status !== "ready" && state.status !== "edited" || state.recordVersion !== editorialRecordVersion(row)) return null;
  return state.version === legacyEditorialVersion(row, input) ? state.status : null;
}
