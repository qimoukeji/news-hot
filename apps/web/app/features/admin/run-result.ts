import type { AdminRunStatistics } from "@aihot/contracts/admin";

interface Run { job: string; status: string; detail?: AdminRunStatistics | null }
interface Result { label: string; tone: "ok" | "warn" | "bad" | "muted"; summary: string | null }

/** The task can end normally while some business judgments still need an administrator. */
export function runResult(run: Run): Result {
  if (run.status === "failed") {
    const failures = run.detail?.searchFailures;
    const reason = { network_unknown: "网络结果未知", http_rejected: "请求被拒绝", invalid_response: "响应无效", request_busy: "请求尚未完成" };
    return { label: "执行失败", tone: "bad", summary: failures?.length ? failures.map(f =>
      `@${f.author}${f.receiptId ? ` · 回执 #${f.receiptId}` : ""} · ${reason[f.reason]}${f.httpStatus ? ` HTTP ${f.httpStatus}` : ""}${f.billingUnknown ? " · 计费未知" : ""} · ${f.recovery === "next_scan" ? "下次定时续采" : "需人工处理"}`).join("；") : null };
  }
  if (run.status !== "ok") return { label: run.status === "running" || !run.status ? "运行中" : run.status, tone: "muted", summary: null };
  const detail = run.detail;
  if (!detail || !/^(?:monitor\.tick|[a-z][a-z0-9-]*-reset\.tick)$/.test(run.job)) return { label: "已完成", tone: "ok", summary: null };
  if (detail.skipped) return { label: "已跳过", tone: "muted", summary: null };
  const parts: string[] = [];
  if (detail.pages !== undefined) parts.push(`采集 ${detail.pages} 页`);
  if (detail.stored !== undefined) parts.push(`新增 ${detail.stored} 条`);
  if (detail.outcome === "partial" || detail.complete === false || detail.collectionComplete === false) {
    if (detail.windowPages !== undefined) parts.push(`累计 ${detail.windowPages} 页`);
    parts.push(detail.reason === "page_limit" ? "达到分页上限，等待续采" : "等待续采");
    return { label: "采集未完成", tone: "warn", summary: parts.join(" · ") };
  }
  if (detail.processed !== undefined) {
    parts.push(`已处理 ${Math.max(0, detail.processed - (detail.reviewed ?? 0) - (detail.failed ?? 0))} 条`);
    parts.push(`待复核 ${detail.reviewed ?? 0} 条`);
    parts.push(`技术失败 ${detail.failed ?? 0} 条`);
  } else {
    if (detail.reviewed !== undefined) parts.push(`待复核 ${detail.reviewed} 条`);
    if (detail.failed !== undefined) parts.push(`技术失败 ${detail.failed} 条`);
  }
  if (detail.schemaFailures !== undefined) parts.push(`结构失败 ${detail.schemaFailures} 组`);
  if ((detail.failed ?? 0) > 0) return { label: "已结束，存在失败", tone: "bad", summary: parts.join(" · ") || null };
  if (detail.outcome === "needs_review" || (detail.reviewed ?? 0) > 0 || (detail.schemaFailures ?? 0) > 0) {
    return { label: "已结束，需复核", tone: "warn", summary: parts.join(" · ") || null };
  }
  return { label: "已完成", tone: "ok", summary: parts.join(" · ") || null };
}
