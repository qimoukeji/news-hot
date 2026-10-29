import type { EventList, EventStatus } from "../public-v2.ts";

export type LocalizedText = Partial<Record<"en" | "zh" | "zh-Hant" | "ja" | "ko" | "ru" | "es", string>>;
export type EventKind = EventList["list"][number]["type"];
export type EventDraft = { type: EventKind; title: string; summary: string; scope: string };
export type Scope = Omit<EventList["list"][number]["scope"], "note"> & { note: LocalizedText | null };
export type ActionKind = EventList["list"][number]["updates"][number]["action"];
export type Pagination = { page: number; total: number; totalPages: number; pageSize: number };
export type AdminEvent = Omit<EventList["list"][number], "title" | "summary" | "scope" | "status" | "time"> & { title: LocalizedText | null; summary: LocalizedText | null; scope: Scope | null; version: string; withdrawn: boolean; status: EventStatus | null; time: string | null; actionCount: number; sourcePostCount: number };
export type ProcessingStatus = "pending" | "processed" | "needs_attention" | "failed";
export type ReplyTarget = { postId: string | null; author: string | null };
export type AdminPost = { id: string; author: string; publishedAt: string; title: LocalizedText | null; summary: LocalizedText | null; url: string; text?: string | null; quotedPost?: { text: string; url?: string; author?: string } | null; replyTo: ReplyTarget | null; filteredOut: boolean; processingStatus: ProcessingStatus; reviewReason?: string | null; version: string; events?: Array<{ id: string; title: LocalizedText | null; type: EventKind }>; actionCount?: number };
export type AdminPosts = Pagination & { rows: AdminPost[] };
export type AdminTimelineAction = { id: string; action: ActionKind; invalidatesEvent: boolean; title: LocalizedText; summary: LocalizedText | null; time: string | null; sequence: number; publishedAt: string; sources: AdminPost[] };
export type AdminTimelineEvent = AdminEvent & { timeline: AdminTimelineAction[]; latestAt: string };
export type AdminEntries = Pagination & { rows: Array<{ kind: "event"; event: AdminTimelineEvent; latestAt: string } | { kind: "post"; post: AdminPost; latestAt: string }> };
export type ActionFact = { action: ActionKind; invalidatesEvent: boolean; title: LocalizedText; summary: LocalizedText | null; time: string | null };
export type ReviewAction = ActionFact & { id: string; eventId: string; sequence: number; sources: Array<{ postId: string }>; version: string };
export type ReviewEvent = { id: string; type: EventKind; title: LocalizedText | null; summary?: LocalizedText | null; scope: Scope | null; version: string; status?: EventStatus | null; time?: string | null; withdrawn?: boolean; unsourcedConfirmationId?: string | null };
export type ReviewVersions = { events: Record<string, string>; actions: Record<string, string>; posts: Record<string, string> };
export type AdminReviewDetail = { version: string; versions: ReviewVersions; post?: AdminPost; event?: ReviewEvent; actions: ReviewAction[]; options: { events: ReviewEvent[]; actions: ReviewAction[]; posts: AdminPost[] } };
export type AdminEventDetail = Omit<AdminReviewDetail, "event"> & { event: AdminTimelineEvent };
export type ReviewCommands = {
  keepPost?: true;
  events: { create: Array<{ localKey: string; type: EventKind; title?: LocalizedText; summary?: LocalizedText | null; scope?: Scope }>; update: Array<{ id: string; scope: Scope }> };
  actions: { create: Array<ActionFact & { localKey: string; eventId?: string; eventKey?: string }>; update: Array<ActionFact & { id: string }> };
  sources: { add: Array<{ actionId?: string; actionKey?: string; postId: string }>; remove: Array<{ actionId: string; postId: string }> };
  orders: Array<{ eventId: string; actionIds: string[] }>;
};
export type ReviewPreview = {
  previewToken: string;
  postChange?: { before: { processingStatus: ProcessingStatus; reviewReason: string | null; filteredOut: boolean }; after: { processingStatus: ProcessingStatus; reviewReason: string | null; filteredOut: boolean } } | null;
  changes: Array<{ eventId: string; before: { status: EventStatus | null; time: string | null; title?: LocalizedText | null } | null; after: { status: EventStatus | null; time: string | null; title?: LocalizedText | null } | null }>;
  actionChanges: Array<{ actionId: string; eventId: string; before: ActionFact | null; after: ActionFact | null }>;
  sourceChanges: Array<{ actionId: string; eventId: string; before: string[]; after: string[] }>;
  orderChanges: Array<{ eventId: string; before: string[]; after: string[] }>;
  lastSourceRemovals: Array<{ actionId: string; eventId: string; message: string }>;
};
export const emptyScope = (): Scope => ({ type: "unknown", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null });
