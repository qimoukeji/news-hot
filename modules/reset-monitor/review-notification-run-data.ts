export const reviewNotificationCounts = ["sent", "failed", "unknown", "cancelled", "skippedQuota", "skippedExpired"] as const;
type Count = typeof reviewNotificationCounts[number];

export interface ReviewNotificationError {
  monitorId: string;
  code: "invalid_key" | "http" | "rejected" | "unconfirmed" | "transport";
  status?: number;
  providerCode?: number;
}

export type ReviewNotificationStatistics = Partial<Record<Count, number>> & {
  disabled?: boolean;
  errors: ReviewNotificationError[];
};

export interface ReviewNotificationRun {
  id: string;
  status: "running" | "ok" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string | null;
  detail: ReviewNotificationStatistics | null;
}

export interface ReviewNotificationIssue {
  monitorId: string;
  postId: string;
  status: "unknown" | "failed";
  attemptedAt: string;
  error: ReviewNotificationError | null;
}

export interface ReviewNotificationRunData {
  monitors: Record<string, { product: string; adminPath: string }>;
  latest: ReviewNotificationRun | null;
  history: ReviewNotificationRun[];
  issues: ReviewNotificationIssue[];
}
