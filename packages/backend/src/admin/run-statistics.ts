import type { AdminRunStatistics } from "@aihot/contracts/admin";

const counts = ["pages", "paidPages", "reusedPages", "windowPages", "stored", "returned", "processed", "reviewed", "failed", "groups", "modelCalls", "schemaFailures", "pending"] as const;

/** Task details may contain arbitrary content; only known counters and enums reach the runs page. */
export function runStatistics(value: unknown): AdminRunStatistics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>, result: AdminRunStatistics = {};
  for (const key of counts) {
    const count = source[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) result[key] = count;
  }
  for (const key of ["complete", "collectionComplete", "skipped"] as const) if (typeof source[key] === "boolean") result[key] = source[key];
  if (source.outcome === "partial" || source.outcome === "needs_review" || source.outcome === "completed") result.outcome = source.outcome;
  if (source.reason === "page_limit") result.reason = source.reason;
  return Object.keys(result).length ? result : null;
}
