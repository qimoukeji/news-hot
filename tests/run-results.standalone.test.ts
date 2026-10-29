import "./standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runStatistics } from "@aihot/backend/admin/run-statistics";
import { runResult } from "../apps/web/app/features/admin/run-result.ts";

test("run statistics expose only bounded counters and known control values", () => {
  assert.deepEqual(runStatistics({ processed: 5, reviewed: 3, outcome: "needs_review", complete: true, reason: "page_limit",
    schemaFailures: -1, pending: 1.5, pages: Infinity, returned: "4", modelResponse: "private source", text: "private source", unknown: 9 }),
  { processed: 5, reviewed: 3, complete: true, outcome: "needs_review", reason: "page_limit" });
  for (const value of [null, [], "source", { text: "private source", outcome: "private source", reason: "private source" }]) assert.equal(runStatistics(value), null);
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
