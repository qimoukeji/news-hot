// Shared reset monitor DTOs: the public v1 snapshot and the page data
// the site builds from the same snapshot.

export type ResetMonitorEventKind = "direct_reset" | "reset_credit" | "bonus_credit";

/** Original source words and an explicitly sourced Beijing instant; null never means midnight. */
export type ResetMonitorBonusTime = {
  source: string;
  at: string | null;
};

export type ResetMonitorBonusCredit = {
  amount: string | null;
  eligibility: string | null;
  claimMethod: string | null;
  usageTerms?: string | null;
  claimDeadline: ResetMonitorBonusTime | null;
  expiresAt: ResetMonitorBonusTime | null;
};

export interface ResetMonitorContextPost {
  id: string;
  author: string;
  relation: "reply" | "quote";
  text: string | null;
  originalText: string;
  url: string;
}

export interface ResetMonitorPost {
  id: string;
  author: string;
  authorAvatar: string | null;
  publishedAt: string | null;
  stage: string;
  text: string;
  originalText: string;
  fullText: string | null;
  fullOriginalText: string | null;
  context: ResetMonitorContextPost[];
  url: string;
}

export type ResetMonitorPresentationStatus = "announced" | "in_progress" | "confirmed" | "expired_unconfirmed" | "likely_completed" | "available" | "claim_closed" | "expired";

export interface ResetMonitorEvent {
  id: string;
  type: ResetMonitorEventKind;
  label: string;
  displayLabel: string;
  presentation: {
    reportedAt?: string | null;
    status: ResetMonitorPresentationStatus;
    scopeKnown: boolean;
    scopeLabel: string | null;
    kindExplicit: boolean;
    timeInferred: boolean;
    audienceZh: string | null;
    productsZh: string | null;
    quotaScope?: string | null;
    bonusCredit?: ResetMonitorBonusCredit | null;
  } | null;
  estimate: { from: string | null; through: string | null; basis: string; label: string; reason: string } | null;
  status: "announced" | "confirmed";
  title: string;
  scope: string;
  createdAt: string | null;
  updatedAt: string | null;
  confirmedAt: string | null;
  occurredOn: string | null;
  confirmationBasis: "source_post" | "receipt_review" | null;
  schedule: { precision: string; from: string | null; through: string | null; label: string } | null;
  posts: ResetMonitorPost[];
  url: string;
}

export interface ResetMonitorActivity {
  id: string;
  author: string;
  authorAvatar: string | null;
  publishedAt: string | null;
  eventIds: string[];
  kind: "event_update" | "related";
  text: string | null;
  originalText: string;
  context: ResetMonitorContextPost[];
  statusChanged: boolean;
  action: string | null;
  url: string;
}

export interface ResetMonitorMonitor {
  status: "healthy" | "delayed" | "attention" | "unknown";
  lastAttemptAt: string | null;
  lastCollectedAt: string | null;
  lastVerifiedAt: string | null;
  pendingCount: number;
  reviewCount: number;
}

export interface ResetMonitorOutage {
  postId: string;
  author: string;
  authorAvatar: string | null;
  publishedAt: string | null;
  text: string | null;
  originalText: string;
  recoveredAt: string | null;
  resetEventId: string | null;
  url: string;
}

export interface ResetMonitorSnapshot {
  schemaVersion: 1;
  timezone: "Asia/Shanghai";
  today: string;
  checkedAt: string | null;
  historyFrom: string | null;
  count: number;
  events: ResetMonitorEvent[];
  activities: ResetMonitorActivity[];
  monitor: ResetMonitorMonitor | null;
  outage: ResetMonitorOutage | null;
}

export interface ResetMonitorCalendarMark {
  date: string;
  eventId: string;
  type: ResetMonitorEventKind;
  state: "confirmed" | "likely" | "pending";
  label: string;
  milestone?: "claim_deadline" | "expiry";
}

export interface ResetMonitorPageData extends ResetMonitorSnapshot {
  scanMinutes: number;
  current: ResetMonitorEvent | null;
  lastLanded: ResetMonitorEvent | null;
  /** The monitored author's X avatar (proxied), when a source post has been collected. */
  authorAvatar: string | null;
  stats: { resets90: number; credits90: number; bonuses90: number; medianIntervalDays: number | null; lastResetDate: string | null };
  calendar: ResetMonitorCalendarMark[];
  /** Beijing minute of day (0–1439) of each source-confirmed direct reset, for the timing chart. */
  confirmMinutes: number[];
  version: string;
}

/** The site sends bodies for the selected calendar day, while v1 keeps the complete snapshot. */
export interface ResetMonitorSitePage extends Omit<ResetMonitorPageData, "activities"> {
  selectedDate: string;
  /** Claimable or announced campaigns remain visible independently of the selected calendar day. */
  activeBonuses?: ResetMonitorEvent[];
}
export interface ResetMonitorDay { date: string; version: string; events: ResetMonitorEvent[] }
/** What the open reset page polls: a new version (or a new day) means the page reads itself again. */
export interface ResetMonitorVersion { version: string; checkedAt: string | null; today: string }

import type { Timestamp } from "@aihot/contracts/admin";

export interface AdminMonitorEventPost {
  postId: string;
  author: string;
  stage: string;
  action: string;
  text: string;
  originalText: string;
  publishedAt: Timestamp;
  url: string;
}

export interface AdminMonitorEvent {
  id: string;
  type: ResetMonitorEventKind;
  status: "announced" | "confirmed";
  label: string;
  display_label: string;
  scope: string;
  schedule: { precision: string; from: Timestamp; through: Timestamp; label: string } | null;
  estimate: { label: string; basis: string } | null;
  presentation: Record<string, any> | null;
  confirmed_at: Timestamp | null;
  occurred_on: Timestamp | null;
  confirmation_basis: string | null;
  withdrawn: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
  posts: AdminMonitorEventPost[];
  canReceiptReview: boolean;
}

export interface AdminMonitorPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminMonitorEvents extends AdminMonitorPagination {
  events: AdminMonitorEvent[];
}

export interface AdminMonitorPost {
  id: string;
  author: string;
  published_at: Timestamp;
  text: string;
  url: string;
  translation: string | null;
  processed_at: Timestamp | null;
  receipt_id: number | null;
  origin: string;
  propositions: Array<Record<string, any>> | null;
  needs_review: boolean | null;
  held: Array<{ action: string; excerpt: string; reason?: string }> | null;
  skipped: boolean | null;
  collection_failure?: { phase: "context" | "recognition"; at: string; error: string; receiptId?: number } | null;
  source_issue?: string | null;
  relevant: boolean | null;
  outage: unknown;
  links: Array<{ eventId: string; stage: string }>;
  manual_review?: { by: string; at: string; reason: string; decision: AdminMonitorReviewDraft["decision"] } | null;
}

export interface AdminMonitorPosts extends AdminMonitorPagination {
  filter: string;
  rows: AdminMonitorPost[];
}

export interface AdminMonitorReviewProposition {
  kind: ResetMonitorEventKind;
  kindExplicit: boolean;
  action: "announce" | "progress" | "confirm" | "amend" | "withdraw";
  count: number;
  excerpt: string;
  excerptZh: string;
  targetEventId: string | null;
  overrideEventFields?: boolean;
  scope: { audienceSource: string | null; plans: string[] | null; audienceZh: string | null; productsZh: string | null };
  schedule: { precision: "exact" | "approximate" | "deadline" | "date" | "window"; from: string; through: string } | null;
  occurredOn: string | null;
  bonusCredit?: ResetMonitorBonusCredit | null;
}

export interface AdminMonitorReviewDraft {
  decision: "unrelated" | "related" | "events";
  translationZh: string | null;
  contextZh: Array<{ id: string; textZh: string }>;
  outage: "outage" | "recovery" | null;
  propositions: AdminMonitorReviewProposition[];
}

export interface AdminMonitorPostDetail {
  post: AdminMonitorPost;
  context: Array<{ id: string; author: string; relation: "reply" | "quote"; textZh: string | null; originalText: string; publishedAt: string | null; url: string }>;
  originalRecognition: Record<string, unknown> | null;
  history: Array<{ at: string; actor: string; reason: string; before: unknown; after: unknown }>;
  version: string;
  draft: AdminMonitorReviewDraft;
}

export interface AdminMonitorReviewPreview {
  postId: string;
  version: string;
  previewToken: string;
  decision: AdminMonitorReviewDraft["decision"];
  changes: Array<{ eventId: string; before: AdminMonitorEvent | null; after: AdminMonitorEvent }>;
  removedLinks: string[];
  addedLinks: string[];
  outageChanges: Array<{ postId: string; before: unknown; after: unknown }>;
}
