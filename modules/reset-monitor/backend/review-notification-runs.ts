import { ModuleRunResults } from "@aihot/backend/modules";
import { sql } from "@aihot/backend/db";
import { REVIEW_NOTIFICATION_JOB } from "../subscriptions-module.ts";
import { reviewNotificationCounts, type ReviewNotificationError, type ReviewNotificationIssue, type ReviewNotificationRun, type ReviewNotificationRunData, type ReviewNotificationStatistics } from "../review-notification-run-data.ts";
import type { ResetMonitorBackendDefinition } from "./context.ts";
import { reviewNotificationIssues } from "./review-notifications.ts";

type Monitor = Pick<ResetMonitorBackendDefinition, "monitorId" | "product" | "adminPath">;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function reviewNotificationError(monitorId: string, value: unknown): ReviewNotificationError | null {
  const error = record(value);
  if (!error) return null;
  const { code, status, providerCode } = error;
  switch (code) {
    case "http":
      return { monitorId, code, ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
    case "rejected":
      return { monitorId, code, ...(typeof providerCode === "number" && Number.isSafeInteger(providerCode) ? { providerCode } : {}) };
    case "invalid_key":
    case "unconfirmed":
    case "transport":
      return { monitorId, code };
    default:
      return null;
  }
}

/** Project only the documented fields. A failed run can report progress up to the failure. */
export function reviewNotificationStatistics(value: unknown, monitorIds: ReadonlySet<string>, status: ReviewNotificationRun["status"]): ReviewNotificationStatistics | null {
  const source = record(value);
  if (!source || status !== "ok" && status !== "failed") return null;
  const detail: ReviewNotificationStatistics = { errors: [] };
  for (const key of reviewNotificationCounts) {
    const count = source[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) detail[key] = count;
  }
  if (typeof source.disabled === "boolean") detail.disabled = source.disabled;
  // A completed run with missing counters must not be shown as an empty or successful delivery.
  if (status === "ok" && (detail.disabled === undefined || reviewNotificationCounts.some(key => detail[key] === undefined))) return null;
  if (Array.isArray(source.errors)) for (const item of source.errors) {
    const monitorId = record(item)?.monitorId;
    if (typeof monitorId !== "string" || !monitorIds.has(monitorId)) continue;
    const error = reviewNotificationError(monitorId, item);
    if (error) detail.errors.push(error);
    if (detail.errors.length === 5) break;
  }
  return detail;
}

function projectIssue(value: unknown, monitorIds: ReadonlySet<string>): ReviewNotificationIssue | null {
  const row = record(value);
  if (!row) return null;
  const { monitorId, postId, status, attemptedAt } = row;
  if (typeof monitorId !== "string" || !monitorIds.has(monitorId) || typeof postId !== "string" || !/^\d{1,20}$/.test(postId)
    || status !== "unknown" && status !== "failed") return null;
  const time = attemptedAt instanceof Date ? attemptedAt.getTime() : typeof attemptedAt === "string" ? Date.parse(attemptedAt) : NaN;
  if (!Number.isFinite(time)) return null;
  return { monitorId, postId, status, attemptedAt: new Date(time).toISOString(), error: reviewNotificationError(monitorId, row.error) };
}

export async function reviewNotificationRuns(definitions: readonly Monitor[]) {
  const monitors = Object.fromEntries(definitions.map(({ monitorId, product, adminPath }) => [monitorId, { product, adminPath }]));
  const monitorIds = new Set(Object.keys(monitors));
  const [runs, recentIssues] = await Promise.all([
    sql<{ id: string; status: ReviewNotificationRun["status"]; started_at: Date; finished_at: Date | null; detail: unknown }[]>`
      SELECT id::text AS id, status, started_at, finished_at, detail FROM job_runs
      WHERE job = ${REVIEW_NOTIFICATION_JOB} ORDER BY started_at DESC, job_runs.id DESC LIMIT 10`,
    reviewNotificationIssues(),
  ]);
  const [latest = null, ...history] = runs.map(run => ({
    id: run.id,
    status: run.status,
    startedAt: run.started_at.toISOString(),
    finishedAt: run.finished_at?.toISOString() ?? null,
    detail: reviewNotificationStatistics(run.detail, monitorIds, run.status),
  }));
  const issues = recentIssues.flatMap(row => {
    const issue = projectIssue(row, monitorIds);
    return issue ? [issue] : [];
  });
  return new ModuleRunResults<ReviewNotificationRunData>([REVIEW_NOTIFICATION_JOB], { monitors, latest, history, issues });
}
