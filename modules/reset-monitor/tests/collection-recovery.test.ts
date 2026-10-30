import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import timers from "node:timers/promises";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { recordRun } from "@aihot/backend/jobs/queue";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { CollectionIncompleteError } from "../backend/collection.ts";
import { monitorTick } from "../backend/scan.ts";
import { runStatistics } from "@aihot/backend/admin/run-statistics";

const since = "2026-10-28T00:00:00.000Z", started = Date.parse("2026-10-29T08:00:00Z");
let mode: "loss" | "ok" | "invalid_json" | "invalid_schema" | "refused" | "valve" = "loss";
let calls: Array<{ author: string; cursor: string | null }> = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://localhost"), query = url.searchParams.get("query")!;
  const author = /from:(\w+)/.exec(query)![1]!, cursor = url.searchParams.get("cursor");
  calls.push({ author, cursor });
  if (author === "officiala" && cursor === "1") {
    if (mode === "loss" || mode === "valve") {
      if (mode === "valve") process.env.COLLECT_ENABLED = "false";
      req.socket.destroy(); return;
    }
    if (mode === "refused") { res.writeHead(401); res.end('{}'); return; }
    if (mode === "invalid_json") { res.end("not JSON"); return; }
    if (mode === "invalid_schema") { res.end('{"tweets":[{"malformed":true}]}'); return; }
  }
  const id = author === "officiala" ? cursor ? "102" : "101" : "103";
  const hasMore = author === "officiala" && !cursor;
  const at = "2026-10-28T12:00:00Z";
  const post = url.pathname.endsWith("advanced_search")
    ? { id, text: "Unrelated", createdAt: at, author: { userName: author, name: author } }
    : { id_str: id, full_text: "Unrelated", tweet_created_at: at, user: { screen_name: author, name: author } };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ tweets: [post], next_cursor: hasMore ? "1" : null, has_next_page: hasMore }));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
Object.assign(process.env, { SOCIALDATA_BASE_URL: base, SOCIALDATA_API_KEY: "synthetic", TWITTERAPI_IO_BASE_URL: base, TWITTERAPI_IO_API_KEY: "synthetic" });
config.allowPrivateNetworkFetch = true;
// Pacing has its own tests; these tests exercise real local HTTP disconnects without the paid-service delay.
mock.method(timers, "setTimeout", async () => {});
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM job_runs`; await sql`DELETE FROM receipts`; await sql`DELETE FROM budgets`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('socialdata',1000,1000,1000),('twitterapi_io',1000,1000,1000)`;
  process.env.COLLECT_ENABLED = "true"; config.modelCallsEnabled = true; calls = []; mode = "loss";
  mock.timers.enable({ apis: ["Date"], now: started });
});
afterEach(() => mock.timers.reset());
after(async () => { mock.restoreAll(); await new Promise<void>(resolve => server.close(() => resolve())); await closeDb(); });

function definition(base: ResetMonitorBackendDefinition, limit = 5): ResetMonitorBackendDefinition {
  return { ...base, authors: [{ handle: "OfficialA", name: "A" }, { handle: "OfficialB", name: "B" }],
    collection: { ...base.collection, maxPagesPerRun: limit } };
}
async function setup(def: ResetMonitorBackendDefinition, provider: string) {
  process.env[def.providerEnv] = provider;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${def.monitorId},${`cursor:${provider}`},${sql.json({ checkpointVersion: 2, scannedThrough: since })})`;
}
const tick = (def: ResetMonitorBackendDefinition) => inMonitor(def, () => recordRun(def.names.tick, monitorTick));
async function failedTick(def: ResetMonitorBackendDefinition) {
  let failure: CollectionIncompleteError | undefined;
  await assert.rejects(tick(def), (error: unknown) => { assert.ok(error instanceof CollectionIncompleteError); failure = error; return true; });
  return failure!;
}

for (const provider of ["socialdata", "twitterapi_io"]) for (const baseDef of [codex, claude, grok]) {
  test(`${baseDef.monitorId}/${provider}: a lost search page leaves other authors running and the next task recovers only that page`, async () => {
    const def = definition(baseDef); await setup(def, provider);
    const first = await failedTick(def);
    assert.equal(first.detail.paidPages, 3); assert.equal(first.detail.windowPages, 2); assert.equal(first.detail.pending, 2);
    assert.deepEqual(calls, [{ author: "officiala", cursor: null }, { author: "officiala", cursor: "1" }, { author: "officialb", cursor: null }]);
    const failure = first.detail.searchFailures[0]!;
    assert.equal(failure.billingUnknown, true); assert.equal(failure.recovery, "next_scan");
    const [savedRun] = await sql`SELECT status,detail FROM job_runs ORDER BY id DESC LIMIT 1`;
    assert.equal(savedRun.status, "failed"); assert.deepEqual(runStatistics(savedRun.detail)?.searchFailures, first.detail.searchFailures);
    const [window] = await sql`SELECT value FROM monitor_state WHERE monitor_id=${def.monitorId} AND key=${`collection:window:${provider}`}`;
    const [cutoff] = await sql`SELECT value FROM monitor_state WHERE monitor_id=${def.monitorId} AND key=${`cursor:${provider}`}`;
    assert.equal(cutoff.value.scannedThrough, since);
    // Simulate a new worker task using only persisted state. No pending posts need model calls in this test.
    await sql`UPDATE monitor_source_posts SET processing_status='processed' WHERE monitor_id=${def.monitorId}`;
    mode = "ok"; mock.timers.tick(15 * 60_000);
    // Seed a previously handled version of the returned post, so this recovery test needs no model.
    await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status)
      VALUES(${def.monitorId},'102','officiala','2026-10-28T12:00:00Z','https://x.com/officiala/status/102','Unrelated','processed')`;
    const second = await tick(def);
    assert.ok("complete" in second && second.complete);
    assert.ok("paidPages" in second && second.paidPages === 1);
    assert.deepEqual(calls.slice(3), [{ author: "officiala", cursor: "1" }]);
    const [replacement] = await sql`SELECT request,attempts FROM receipts WHERE request->>'replacesReceiptId'=${String(failure.receiptId)}`;
    assert.equal(replacement.request.replacesReceiptId, failure.receiptId); assert.equal(replacement.attempts, 1);
    const [original] = await sql`SELECT status,attempts FROM receipts WHERE id=${failure.receiptId!}`;
    assert.equal(original.status, "failed"); assert.equal(original.attempts, 1);
    assert.equal((await sql`SELECT status FROM receipt_attempts WHERE receipt_id=${failure.receiptId!}`)[0]!.status, "unknown");
    const [advanced] = await sql`SELECT value FROM monitor_state WHERE monitor_id=${def.monitorId} AND key=${`cursor:${provider}`}`;
    assert.equal(advanced.value.scannedThrough, window.value.startedAt);
    const [watermarks] = await sql`SELECT value FROM monitor_state WHERE monitor_id=${def.monitorId} AND key=${`watermarks:${provider}`}`;
    assert.equal(watermarks.value.lastAttemptAt, new Date().toISOString()); assert.equal(watermarks.value.windowStartedAt, window.value.startedAt);
    assert.equal((await sql`SELECT 1 FROM monitor_state WHERE monitor_id=${def.monitorId} AND key LIKE 'collection:window:%'`).length, 0);
  });
}

for (const provider of ["socialdata", "twitterapi_io"]) {
  for (const invalid of ["invalid_json", "invalid_schema", "refused"] as const) test(`${provider}: ${invalid} is saved for review and never repurchased`, async () => {
    const def = definition(grok); await setup(def, provider); mode = invalid;
    const first = await failedTick(def);
    assert.equal(first.detail.searchFailures[0]!.recovery, "manual"); assert.equal(first.detail.searchFailures[0]!.billingUnknown, false);
    mode = "ok";
    await failedTick(def);
    assert.equal(calls.length, 3, "other author succeeds, but neither successful nor rejected pages are purchased again");
    assert.equal((await sql`SELECT status FROM receipt_attempts WHERE receipt_id=${first.detail.searchFailures[0]!.receiptId!}`)[0]!.status,
      invalid === "refused" ? "failed" : "received");
  });
  test(`${provider}: failed requests count toward the shared page allowance`, async () => {
    const def = definition(grok, 2); await setup(def, provider);
    const first = await failedTick(def);
    assert.equal(first.detail.paidPages, 2); assert.equal(first.detail.pageLimitReached, true); assert.equal(calls.length, 2);
    await failedTick(def);
    assert.deepEqual(calls.slice(2), [{ author: "officiala", cursor: "1" }, { author: "officialb", cursor: null }]);
  });
  test(`${provider}: the budget stops collection before another author reserves a request`, async () => {
    const def = definition(grok); await setup(def, provider);
    await sql`UPDATE budgets SET per_day=2 WHERE service=${provider}`;
    await assert.rejects(tick(def), BudgetExceededError);
    assert.equal(calls.length, 2); assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0]!.n, 2);
    const [cutoff] = await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key=${`cursor:${provider}`}`;
    assert.equal(cutoff.value.scannedThrough, since);
  });
  test(`${provider}: closing the collection valve prevents the other author's request`, async () => {
    const def = definition(grok); await setup(def, provider); mode = "valve";
    await assert.rejects(tick(def), /COLLECT_ENABLED/);
    assert.equal(calls.length, 2);
  });
}

test("a recovery response survives an interrupted business write without another purchase", async () => {
  const def = definition(grok); await setup(def, "twitterapi_io");
  await failedTick(def);
  await sql`UPDATE monitor_source_posts SET processing_status='processed' WHERE monitor_id='grok'`;
  await sql`ALTER TABLE monitor_source_posts ADD CONSTRAINT recovery_write_refusal CHECK(id<>'102') NOT VALID`;
  mode = "ok";
  try { await assert.rejects(tick(def), /recovery_write_refusal/); }
  finally { await sql`ALTER TABLE monitor_source_posts DROP CONSTRAINT recovery_write_refusal`; }
  assert.equal(calls.length, 4);
  const [paid] = await sql`SELECT id,status FROM receipts WHERE request ? 'replacesReceiptId'`;
  assert.equal(paid.status, "received");
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status)
    VALUES('grok','102','officiala','2026-10-28T12:00:00Z','https://x.com/officiala/status/102','Unrelated','processed')`;
  const result = await tick(def);
  assert.ok("paidPages" in result && result.paidPages === 0);
  assert.ok("reusedPages" in result && result.reusedPages === 1);
  assert.equal(calls.length, 4);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${paid.id}`)[0]!.status, "completed");
});

test("a legacy window with an unknown receipt recovers without editing its cutoff or deleting state", async () => {
  const def = definition(grok); await setup(def, "twitterapi_io");
  const first = await failedTick(def), oldReceipt = first.detail.searchFailures[0]!.receiptId!;
  const [row] = await sql`SELECT key,value FROM monitor_state WHERE monitor_id='grok' AND key LIKE 'collection:progress:%'`;
  for (const author of row.value.authors) { delete author.failure; delete author.replacesReceiptId; }
  await sql`UPDATE monitor_state SET value=${sql.json(row.value)} WHERE monitor_id='grok' AND key=${row.key}`;
  const legacy = await failedTick(def);
  assert.equal(calls.length, 3); assert.equal(legacy.detail.searchFailures[0]!.receiptId, oldReceipt);
  await failedTick(def);
  assert.equal(calls.length, 4);
  const [replacement] = await sql`SELECT id,request FROM receipts WHERE request->>'replacesReceiptId'=${String(oldReceipt)}`;
  assert.equal(replacement.request.replacesReceiptId, oldReceipt);
  await failedTick(def);
  const [next] = await sql`SELECT id FROM receipts WHERE request->>'replacesReceiptId'=${String(replacement.id)}`;
  assert.ok(next.id, "repeated loss links each later task to its own failed search request");
});
