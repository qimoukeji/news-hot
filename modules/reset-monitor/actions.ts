import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import {
  localizedTextSchema,
  publicTimeSchema,
  scopeSchema,
  updateActions,
  sourceUrlSchema,
  timestampSchema,
  type ResetEvent,
  type BusinessTime,
} from "./public-v2.ts";

export const actionKinds = updateActions;
export type ActionKind = (typeof actionKinds)[number];
export type EditorialText = Partial<
  Record<"en" | "zh" | "zh-Hant" | "ja" | "ko" | "ru" | "es", string>
>;
export const editorialTextSchema = localizedTextSchema
  .partial()
  .refine(
    (value) => Object.values(value).some((text) => text?.trim()),
    "至少填写一种语言",
  );
export const editorialScopeSchema = scopeSchema.extend({
  note: editorialTextSchema.nullable(),
});
export type EditorialScope = z.infer<typeof editorialScopeSchema>;
export const actionDraftSchema = z.strictObject({
  id: z.string().min(1).optional(),
  eventId: z.string().min(1).nullable(),
  action: z.enum(actionKinds),
  invalidatesEvent: z.boolean().optional(),
  title: editorialTextSchema,
  summary: editorialTextSchema.nullable(),
  time: publicTimeSchema,
}).refine(value => !value.invalidatesEvent || value.action === "amend", "只有修订动作可以使事件失效");
export type ActionDraft = z.infer<typeof actionDraftSchema>;
export const postProcessingStatuses = ["pending", "processed", "needs_attention", "failed"] as const;
export type PostProcessingStatus = (typeof postProcessingStatuses)[number];
export const quotedPostSchema = z.strictObject({
  id: z.string().trim().min(1), author: z.string().trim().min(1), relation: z.literal("quote"),
  text: z.string(), publishedAt: timestampSchema.nullable(), url: sourceUrlSchema,
  replyTo: z.object({ postId: z.string().nullable(), author: z.string().nullable() }).nullable().optional(),
});
export type QuotedPost = z.infer<typeof quotedPostSchema>;
export const replyToSchema = z.strictObject({ postId: z.string().trim().min(1).nullable(), author: z.string().trim().min(1).nullable() });
export type ReplyTo = z.infer<typeof replyToSchema>;
export interface SourcePostRow {
  id: string;
  context_only?: boolean;
  author: string;
  published_at: Date | string;
  url: string;
  text: string | null;
  quoted_post: QuotedPost | null;
  reply_to: ReplyTo | null;
  filtered_out: boolean;
  title: EditorialText | null;
  summary: EditorialText | null;
  source_receipt_id: number | null;
  model_receipt_id: number | null;
  processing_status: PostProcessingStatus;
  review_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
export interface EventRow {
  id: string;
  type: ResetEvent["type"];
  title: EditorialText | null;
  summary: EditorialText | null;
  scope: EditorialScope | null;
  withdrawn: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}
export interface ActionRow {
  id: string;
  event_id: string;
  action: ActionKind;
  invalidates_event: boolean;
  title: EditorialText;
  summary: EditorialText | null;
  time: BusinessTime;
  sequence: number;
  sources: Array<{ postId: string }>;
  created_at: Date | string;
  updated_at: Date | string;
}
export interface ActionInput {
  events: EventRow[];
  posts: SourcePostRow[];
  actions: ActionRow[];
  editorials?: Record<string, { version: string; status: string; recordVersion?: string }>;
  standaloneFollowupIds?: ReadonlySet<string>;
  invalidatedInferenceIds?: ReadonlySet<string>;
  manualConfirmationIds?: ReadonlySet<string>;
}
export const languages = [
  "en",
  "zh",
  "zh-Hant",
  "ja",
  "ko",
  "ru",
  "es",
] as const;
export function translated(
  value: EditorialText | null | undefined,
): value is Record<(typeof languages)[number], string> {
  return (
    !!value &&
    languages.every(
      (language) =>
        typeof value[language] === "string" && value[language]!.trim(),
    )
  );
}
export const iso = (value: Date | string) => new Date(value).toISOString();
/** Defaults are chosen once on write and never recomputed by readers. */
export function defaultActionTime(action: ActionKind, publishedAt: Date | string, now = Date.now()): BusinessTime {
  const sourceAt = publishedAt instanceof Date ? iso(publishedAt) : Temporal.Instant.from(publishedAt).toString();
  if (action === "announce") {
    const boundary = `${sourceAt.slice(0, 10)}T18:00:00.000Z`;
    return { kind: "instant", at: now > Date.parse(boundary) ? `${sourceAt.slice(0, 10)}T23:59:00.000Z` : boundary };
  }
  if (action !== "amend") return { kind: "instant", at: sourceAt };
  const publication = Temporal.Instant.from(publishedAt instanceof Date ? sourceAt : publishedAt);
  const sameDay = Temporal.Instant.from(`${sourceAt.slice(0, 10)}T10:00:00Z`);
  const at = Temporal.Instant.compare(publication, sameDay) > 0 ? sameDay.add({ hours: 24 }) : sameDay;
  return { kind: "instant", at: at.toString({ fractionalSecondDigits: 3 }) };
}
export function sourcedConfirmationTime(posts: Iterable<{ published_at: Date | string }>, prior?: BusinessTime): Extract<BusinessTime, { kind: "instant" }> | null {
  let at: string | null = null;
  for (const post of posts) {
    const publication = post.published_at instanceof Date ? iso(post.published_at) : post.published_at;
    const normalized = publication.endsWith("Z") ? publication : Temporal.Instant.from(publication).toString();
    if (at === null || Temporal.Instant.compare(normalized, at) < 0) at = normalized;
  }
  if (at === null) return null;
  return prior?.kind === "instant" && Temporal.Instant.compare(prior.at, at) === 0 ? prior : { kind: "instant", at };
}
export function sourcedActions(event: EventRow, input: ActionInput) {
  return input.actions
    .filter((action) => action.event_id === event.id)
    .flatMap((action) => {
      publicTimeSchema.parse(action.time);
      const seen = new Set<string>();
      const posts = action.sources
        .filter(source => {
          if (seen.has(source.postId)) return false;
          seen.add(source.postId);
          return true;
        })
        .map((source) => input.posts.find((post) => post.id === source.postId))
        .filter((post): post is SourcePostRow => !!post && !post.context_only)
        .sort(
          (a, b) =>
            Date.parse(iso(a.published_at)) - Date.parse(iso(b.published_at)) ||
            a.id.localeCompare(b.id),
        );
      return posts.length
        ? [{ action, posts, publishedAt: iso(posts[0]!.published_at) }]
        : action.action === "confirm" && action.sources.length === 0 && action.time
          ? [{ action, posts, publishedAt: iso(action.created_at) }]
          : [];
    })
    .sort(
      (a, b) =>
        a.action.sequence - b.action.sequence || a.action.id.localeCompare(b.action.id),
    );
}

export const eventIdsForPost = (input: ActionInput, postId: string) => [...new Set(input.actions.filter(action => action.sources.some(source => source.postId === postId)).map(action => action.event_id))].sort();

export function isInferredConfirmation(action: Pick<ActionRow, "id" | "action" | "sources">, manualConfirmationIds?: ReadonlySet<string>) {
  return action.action === "confirm" && !action.sources.length && /^inferred-[a-f0-9]{64}$/.test(action.id)
    && !manualConfirmationIds?.has(action.id);
}

/** Keep prior inferred actions in the timeline but retire their effect when their plan changes. */
export function inferencesAfterAnnouncement(announcement: ActionRow, actions: Pick<ActionRow, "id" | "event_id" | "sequence" | "action" | "invalidates_event" | "sources">[], manualConfirmationIds?: ReadonlySet<string>) {
  const later = actions.filter(action => action.event_id === announcement.event_id && action.sequence > announcement.sequence)
    .sort((a, b) => a.sequence - b.sequence);
  const end = later.findIndex(action => action.action === "announce" || action.invalidates_event);
  return (end === -1 ? later : later.slice(0, end)).filter(action => isInferredConfirmation(action, manualConfirmationIds)).map(action => action.id);
}

/** Original source text is restricted to source storage and authenticated review. */
export function withoutPostOriginal<T extends { text?: unknown; quoted_post?: unknown }>(post: T) {
  const { text: _text, quoted_post: _quote, ...snapshot } = post;
  return snapshot;
}

/** Source-free confirmations are provisional; later official arrangements supersede them. */
export function reduceEvent(event: EventRow, input: ActionInput) {
  const actions = sourcedActions(event, input);
  const initial = actions.find(
    ({ action }) => action.action === "announce" || action.action === "confirm" || input.standaloneFollowupIds?.has(action.id),
  );
  if (!initial) return null;
  let status: ResetEvent["status"] = initial.action.action === "amend" ? "in_progress" : "announced";
  let time: BusinessTime = initial.action.time;
  let announcedTime: BusinessTime | null = null;
  let confirmedTime: BusinessTime | null = null;
  let confirmationId: string | null = null;
  let officialConfirmed = false;
  for (const update of actions.slice(actions.indexOf(initial))) {
    const action = update.action;
    if (action.action === "amend" && action.invalidates_event) {
      status = "cancelled";
      time = action.time;
      announcedTime = confirmedTime = null;
      confirmationId = null;
      officialConfirmed = false;
    } else if (action.action === "confirm" && status !== "cancelled") {
      if (isInferredConfirmation(action, input.manualConfirmationIds) && input.invalidatedInferenceIds?.has(action.id)) continue;
      if (!action.sources.length && officialConfirmed) continue;
      status = "completed";
      time = action.time;
      confirmedTime = time;
      confirmationId = action.id;
      officialConfirmed = action.sources.length > 0;
      announcedTime = null;
    } else if (action.action === "announce" && status !== "cancelled" && !officialConfirmed) {
      status = "announced";
      time = action.time;
      announcedTime = time;
      confirmedTime = confirmationId = null;
    } else if (
      action.action === "progress" &&
      status !== "cancelled" && !officialConfirmed
    ) {
      status = "in_progress";
      time = action.time;
      announcedTime = confirmedTime = confirmationId = null;
    } else if (action.action === "amend" && status === "in_progress") {
      time = action.time;
    }
  }
  return {
    status,
    time,
    announcedTime,
    confirmedTime,
    confirmationId,
    scope: event.scope,
    actions,
    publishedAt: iso(event.created_at),
  };
}

export function currentUnsourcedConfirmation(event: EventRow, input: ActionInput) {
  const reduced = reduceEvent(event, input);
  return reduced?.confirmationId ? input.actions.find(action => action.id === reduced.confirmationId && action.sources.length === 0) ?? null : null;
}
