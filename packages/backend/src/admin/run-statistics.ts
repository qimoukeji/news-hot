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
  if (source.reason === "page_limit" || source.reason === "search_failed") result.reason = source.reason;
  if (Array.isArray(source.searchFailures)) {
    const failures: NonNullable<AdminRunStatistics["searchFailures"]> = [];
    for (const item of source.searchFailures.slice(0, 20)) {
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      if (typeof f.author !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(f.author) || typeof f.billingUnknown !== "boolean"
        || f.recovery !== "next_scan" && f.recovery !== "manual"
        || f.reason !== "network_unknown" && f.reason !== "http_rejected" && f.reason !== "invalid_response" && f.reason !== "request_busy") continue;
      failures.push({ author: f.author, billingUnknown: f.billingUnknown, recovery: f.recovery, reason: f.reason,
        ...(typeof f.receiptId === "number" && Number.isSafeInteger(f.receiptId) && f.receiptId > 0 ? { receiptId: f.receiptId } : {}),
        ...(typeof f.httpStatus === "number" && Number.isInteger(f.httpStatus) && f.httpStatus >= 100 && f.httpStatus <= 599 ? { httpStatus: f.httpStatus } : {}) });
    }
    if (failures.length) result.searchFailures = failures;
  }
  return Object.keys(result).length ? result : null;
}
