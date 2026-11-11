import "./standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runStatistics } from "@aihot/backend/admin/run-statistics";
import { runResult } from "../apps/web/app/features/admin/run-result.ts";
import { reviewNotificationStatistics } from "../modules/reset-monitor/backend/review-notification-runs.ts";
import { reviewNotificationCounts, type ReviewNotificationRun } from "../modules/reset-monitor/review-notification-run-data.ts";
import { reviewNotificationRunResult } from "../modules/reset-monitor/web/review-notification-run-result.ts";

test("run statistics expose only bounded counters and known control values", () => {
  assert.deepEqual(runStatistics({ processed: 5, reviewed: 3, outcome: "needs_review", complete: true, reason: "page_limit",
    schemaFailures: -1, pending: 1.5, pages: Infinity, returned: "4", modelResponse: "private source", text: "private source", unknown: 9 }),
  { processed: 5, reviewed: 3, complete: true, outcome: "needs_review", reason: "page_limit" });
  for (const value of [null, [], "source", { text: "private source", outcome: "private source", reason: "private source" }]) assert.equal(runStatistics(value), null);
});

test("failed searches expose recovery information without raw responses or arbitrary error text", () => {
  const failure = { author: "grok", receiptId: 169, billingUnknown: true, recovery: "next_scan" as const, reason: "network_unknown" as const };
  const detail = runStatistics({ reason: "search_failed", searchFailures: [{ ...failure, text: "private source", error: "private error" },
    { ...failure, author: "private source text" }, { ...failure, recovery: "private error" }] });
  assert.deepEqual(detail, { reason: "search_failed", searchFailures: [failure] });
  const result = runResult({ job: "grok-reset.tick", status: "failed", detail });
  assert.equal(result.tone, "bad"); assert.match(result.summary!, /@grok.*回执 #169.*计费未知.*下次定时续采/);
  const invalid = runResult({ job: "grok-reset.tick", status: "failed", detail: { searchFailures: [{ ...failure, reason: "invalid_response", billingUnknown: false, recovery: "manual" }] } });
  assert.match(invalid.summary!, /响应无效.*需人工处理/);
});

test("a historical ok monitor run with reviewed records shows review rather than complete", () => {
  const result = runResult({ job: "monitor.tick", status: "ok", detail: { processed: 5, reviewed: 3, failed: 0, pages: 2, stored: 3 } });
  assert.equal(result.label, "已结束，需复核"); assert.equal(result.tone, "warn");
  assert.match(result.summary!, /已处理 2 条/); assert.match(result.summary!, /待复核 3 条/); assert.match(result.summary!, /技术失败 0 条/);
});

test("a limited run is explicitly incomplete and ready for continuation", () => {
  const result = runResult({ job: "grok-reset.tick", status: "ok", detail: { outcome: "partial", complete: false, pages: 5, windowPages: 10, stored: 24, reason: "page_limit", processed: 0 } });
  assert.equal(result.label, "采集未完成"); assert.equal(result.tone, "warn");
  assert.match(result.summary!, /累计 10 页/); assert.match(result.summary!, /达到分页上限，等待续采/);
  assert.doesNotMatch(result.summary!, /已处理/);
});

test("completed zero-result runs, schema failures and explicit review outcomes retain their meaning", () => {
  const empty = runResult({ job: "claude-reset.tick", status: "ok", detail: { complete: true, outcome: "completed", pages: 1, stored: 0, processed: 0, reviewed: 0, failed: 0 } });
  assert.equal(empty.label, "已完成"); assert.match(empty.summary!, /新增 0 条/);
  const invalid = runResult({ job: "monitor.tick", status: "ok", detail: { processed: 1, reviewed: 1, schemaFailures: 1 } });
  assert.equal(invalid.tone, "warn"); assert.match(invalid.summary!, /结构失败 1 组/);
  assert.equal(runResult({ job: "monitor.tick", status: "ok", detail: { outcome: "needs_review" } }).label, "已结束，需复核");
});

test("technical failure, running, skipped and unrelated jobs do not become successful business judgments", () => {
  assert.deepEqual(runResult({ job: "monitor.tick", status: "failed", detail: { outcome: "completed" } }), { label: "执行失败", tone: "bad", summary: null });
  assert.equal(runResult({ job: "monitor.tick", status: "running" }).label, "运行中");
  assert.equal(runResult({ job: "monitor.tick", status: "ok", detail: { skipped: true } }).label, "已跳过");
  assert.deepEqual(runResult({ job: "ops.backup", status: "ok", detail: { reviewed: 4 } }), { label: "已完成", tone: "ok", summary: null });
  assert.equal(runResult({ job: "monitor.tick", status: "ok", detail: { processed: 2, failed: 2 } }).tone, "bad");
  const mixed = runResult({ job: "monitor.tick", status: "ok", detail: { processed: 3, reviewed: 1, failed: 1 } });
  assert.equal(mixed.tone, "bad"); assert.match(mixed.summary!, /已处理 1 条/); assert.match(mixed.summary!, /待复核 1 条/);
});

const monitorId = "configured-monitor";
const monitors = { [monitorId]: { product: "Configured Product", adminPath: "/admin/configured-monitor" } };
const monitorIds = new Set(Object.keys(monitors));
const counts = { sent: 1, failed: 0, unknown: 0, cancelled: 2, skippedQuota: 3, skippedExpired: 4, disabled: false };
const showRun = (source: unknown, status: ReviewNotificationRun["status"] = "ok") => reviewNotificationRunResult({
  id: "1", status, startedAt: "2026-11-11T00:00:00Z", finishedAt: null, detail: reviewNotificationStatistics(source, monitorIds, status),
}, monitors);

test("a complete notification run requires valid counters, but a failed run retains partial progress", () => {
  for (const key of reviewNotificationCounts) {
    for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined, true]) {
      const source = { ...counts, [key]: value };
      assert.equal(reviewNotificationStatistics(source, monitorIds, "ok"), null, `${key}=${String(value)}`);
      assert.equal(reviewNotificationStatistics(source, monitorIds, "failed")?.[key], undefined);
    }
  }
  assert.equal(showRun({ ...counts, disabled: "false" }).label, "通知统计不可用");
  assert.deepEqual(showRun({ sent: 3, unknown: 1, failed: "invalid" }, "failed"), {
    label: "执行失败", tone: "bad", summary: "已发送 3 条 · 结果未知 1 条",
  });
});

test("only known monitor IDs and safe structured notification fields reach the panel", () => {
  const raw = "https://sctapi.ftqq.com/SCTSyntheticPrivateKey.send private response";
  const allowed = [{ monitorId, code: "invalid_key" }, { monitorId, code: "http", status: 503 }, { monitorId, code: "rejected", providerCode: -40001 },
    { monitorId, code: "unconfirmed" }, { monitorId, code: "transport" }];
  const source = { ...counts, errors: [null, raw, { monitorId: raw, code: "transport" }, { monitorId: "claude", code: "transport" },
    { monitorId, code: raw }, ...allowed.map(error => ({ ...error, response: raw, url: raw })), { monitorId, code: "http", status: 502 }], rawResponse: raw };
  const detail = reviewNotificationStatistics(source, monitorIds, "ok");
  assert.deepEqual(detail, { ...counts, errors: allowed });
  const result = showRun(source);
  assert.equal(result.tone, "warn");
  assert.match(result.summary!, /Configured Product：Server酱拒绝发送（code=-40001）/);
  assert.doesNotMatch(JSON.stringify({ detail, result }), /SCTSyntheticPrivateKey|sctapi\.ftqq\.com|private response/);

  const malformed = [{ monitorId, code: "http", status: 999, providerCode: 123 }, { monitorId, code: "http", status: "503" },
    { monitorId, code: "rejected", providerCode: Number.MAX_SAFE_INTEGER + 1, status: 400 }, { monitorId, code: "rejected", providerCode: 1.5 },
    { monitorId, code: "transport", status: 503, providerCode: 1 }];
  assert.deepEqual(reviewNotificationStatistics({ ...counts, errors: malformed }, monitorIds, "ok")?.errors,
    malformed.map(({ code }) => ({ monitorId, code })));
});

test("the notification panel distinguishes delivery failure, unknown results, disabled and empty runs", () => {
  const failed = showRun({ ...counts, sent: 2, failed: 1, unknown: 1 });
  assert.equal(failed.label, "已结束，存在发送失败");
  assert.equal(failed.tone, "bad");
  for (const text of ["已发送 2 条", "发送失败 1 条", "结果未知 1 条", "已取消 2 条", "超额跳过 3 条", "跨日跳过 4 条"]) assert.ok(failed.summary!.includes(text));
  assert.equal(showRun({ ...counts, unknown: 1 }).label, "已结束，存在结果未知");
  assert.equal(showRun({ ...counts, sent: 0, disabled: true }).label, "通知已禁用");
  assert.equal(showRun(counts).label, "已发送");
  assert.equal(showRun({ ...counts, sent: 0 }).label, "无通知发送");
  assert.equal(showRun(null).label, "通知统计不可用");
  assert.equal(showRun(null, "running").label, "运行中");
});
