import { reviewNotificationCounts, type ReviewNotificationError, type ReviewNotificationRun, type ReviewNotificationRunData } from "../review-notification-run-data.ts";

const countLabels = {
  sent: "已发送", failed: "发送失败", unknown: "结果未知", cancelled: "已取消", skippedQuota: "超额跳过", skippedExpired: "跨日跳过",
};

export function reviewNotificationErrorMessage(error: ReviewNotificationError) {
  switch (error.code) {
    case "invalid_key": return "需要有效的 Server酱 Turbo SendKey";
    case "http": return error.status === undefined ? "Server酱请求失败" : `Server酱返回 HTTP ${error.status}`;
    case "rejected": return error.providerCode === undefined ? "Server酱拒绝发送" : `Server酱拒绝发送（code=${error.providerCode}）`;
    case "unconfirmed": return "Server酱响应无法确认是否发送成功；不重试";
    case "transport": return "Server酱请求超时、网络异常或响应不可读；不重试";
  }
}

export function reviewNotificationRunResult(run: ReviewNotificationRun, monitors: ReviewNotificationRunData["monitors"]) {
  const { status, detail } = run;
  const counts = reviewNotificationCounts.flatMap(key => detail?.[key] === undefined ? [] : [`${countLabels[key]} ${detail[key]} 条`]);
  const errors = detail?.errors.map(error => `${monitors[error.monitorId]?.product ?? error.monitorId}：${reviewNotificationErrorMessage(error)}`) ?? [];
  const summary = [...counts, ...errors].join(" · ") || null;
  if (status === "failed") return { label: "执行失败", tone: "bad", summary } as const;
  if (status === "running") return { label: "运行中", tone: "muted", summary: null } as const;
  if (status === "skipped") return { label: "已跳过", tone: "muted", summary: null } as const;
  if (!detail) return { label: "通知统计不可用", tone: "warn", summary: null } as const;
  if ((detail.failed ?? 0) > 0) return { label: "已结束，存在发送失败", tone: "bad", summary } as const;
  if ((detail.unknown ?? 0) > 0) return { label: "已结束，存在结果未知", tone: "warn", summary } as const;
  if (detail.errors.length) return { label: "已结束，存在通知错误", tone: "warn", summary } as const;
  if (detail.disabled) return { label: "通知已禁用", tone: "muted", summary } as const;
  return detail.sent ? { label: "已发送", tone: "ok", summary } as const : { label: "无通知发送", tone: "muted", summary } as const;
}
