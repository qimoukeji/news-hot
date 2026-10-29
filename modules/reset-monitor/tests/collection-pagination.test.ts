import { stub, Reply } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { inMonitor } from "../backend/context.ts";
import { collectPosts, collectionProgressKey } from "../backend/collection.ts";
import { monitorTick } from "../backend/scan.ts";
import { loadActionInput } from "../backend/action-store.ts";
import type { Tweet } from "../backend/providers/collectors.ts";

const since = "2026-10-28T00:00:00Z", startedAt = new Date("2026-10-29T08:00:00Z");
const local = (value: string) => ({ en: value, zh: value, "zh-Hant": value, ja: value, ko: value, ru: value, es: value });
const tweet = (id: string, author: string, patch: Partial<Tweet> = {}): Tweet => ({ id_str: id,
  user: { screen_name: author, name: author }, full_text: `Saved post ${id}`, tweet_created_at: "2026-10-28T12:00:00Z", ...patch });
let pages: Record<string, Tweet[][]> = {}, refusal: string | null = null, repeatedCursor = false, modelCalls = 0;
const calls: Array<{ author: string; cursor: string | null }> = [], lookups: string[] = [];
const collector = await stub((_hit, request) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname !== "/twitter/search" && !url.pathname.endsWith("/advanced_search")) {
    const id = url.pathname.split("/").at(-1)!; lookups.push(id);
    return tweet(id, "OfficialA", { tweet_created_at: "2026-10-27T12:00:00Z", full_text: "Earlier saved context" });
  }
  const author = /from:(\w+)/.exec(url.searchParams.get("query")!)![1]!, cursor = url.searchParams.get("cursor");
  calls.push({ author, cursor });
  if (`${author}:${cursor ?? "0"}` === refusal) return new Reply(429, { error: "Synthetic search refusal" });
  const index = Number(cursor ?? 0), configured = pages[author] ?? [[]];
  const tweets = configured[index] ?? [], next = repeatedCursor ? "repeat" : index + 1 < configured.length ? String(index + 1) : null;
  return url.pathname.endsWith("/advanced_search") ? { status: "success", tweets: tweets.map(post => ({ id: post.id_str, text: post.full_text,
    createdAt: post.tweet_created_at, author: { name: post.user.name, userName: post.user.screen_name } })), has_next_page: !!next, next_cursor: next }
    : { tweets, next_cursor: next };
});
const model = await stub((_hit, request) => {
  modelCalls++;
  const input = JSON.parse(JSON.parse(request.body).messages[1].content);
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ posts: input.targets.map((post: { id: string }) => ({ postId: post.id,
    relevant: false, needsReview: false, reviewReason: null, title: local("Unrelated saved post"), summary: null, actions: [] })) }) } }] };
});
Object.assign(process.env, { CODEX_RESET_PROVIDER: "socialdata", SOCIALDATA_BASE_URL: collector.url, SOCIALDATA_API_KEY: "synthetic",
  TWITTERAPI_IO_BASE_URL: collector.url, TWITTERAPI_IO_API_KEY: "synthetic",
  MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "synthetic", LLM_MODEL: "synthetic-pages" });
config.allowPrivateNetworkFetch = true;
const definition = (limit?: number, authors = ["OfficialA", "OfficialB"]) => ({ ...codex,
  authors: authors.map(handle => ({ handle, name: handle })), collection: { includeReplies: false, includeSelfReplies: true, resetOnly: false,
    keywords: [], ...(limit === undefined ? {} : { maxPagesPerRun: limit }) } });
installModules([createMonitorServer(definition())]);
const run = (limit?: number, authors?: string[], resume = false) => inMonitor(definition(limit, authors), () => collectPosts({ startedAt, roundId: "pagination-round", resume }));
const saved = () => inMonitor(definition(), () => loadActionInput());
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM receipts`; await sql`DELETE FROM budgets`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('socialdata',1000,1000,1000)`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex','cursor:socialdata',${sql.json({ checkpointVersion: 2, scannedThrough: since })})`;
  pages = {}; refusal = null; repeatedCursor = false; calls.length = 0; lookups.length = 0; modelCalls = 0;
  process.env.COLLECT_ENABLED = "true"; config.modelCallsEnabled = true;
  process.env.CODEX_RESET_PROVIDER = "socialdata";
});
after(async () => { await collector.close(); await model.close(); installModules([]); await closeDb(); });

test("a search-page allowance is shared across authors and the next run starts at the saved cursor", async () => {
  pages = { officiala: [[tweet("101", "OfficialA")], [tweet("102", "OfficialA")], [tweet("103", "OfficialA")]], officialb: [[tweet("104", "OfficialB")]] };
  const first = await run(2);
  assert.equal(first.collectionComplete, false); assert.equal(first.pageLimitReached, true); assert.equal(first.paidPages, 2); assert.equal(first.windowPages, 2);
  const second = await run(2, undefined, true);
  assert.equal(second.collectionComplete, true); assert.equal(second.paidPages, 2); assert.equal(second.windowPages, 4);
  assert.deepEqual(calls, [{ author: "officiala", cursor: null }, { author: "officiala", cursor: "1" }, { author: "officiala", cursor: "2" }, { author: "officialb", cursor: null }]);
  assert.equal((await saved()).posts.length, 4);
});

test("a capped formal task defers context and recognition, then completes the fixed window on continuation", async () => inMonitor(definition(2), async () => {
  pages = { officiala: [[tweet("101", "OfficialA", { is_reply: true, in_reply_to_status_id_str: "90" })], [tweet("102", "OfficialA")]], officialb: [[tweet("103", "OfficialB")]] };
  const first = await monitorTick();
  assert.ok("outcome" in first);
  assert.equal(first.outcome, "partial"); assert.equal(first.complete, false); assert.equal(first.modelCalls, 0);
  assert.equal(first.pending, 2);
  assert.equal(modelCalls, 0); assert.equal(lookups.length, 0);
  const [window] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='collection:window:socialdata'`;
  const [before] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`;
  assert.equal(before.value.scannedThrough, since);
  const second = await monitorTick();
  assert.ok("verifiedAt" in second);
  assert.equal(second.complete, true); assert.equal(second.collectionComplete, true); assert.equal(second.windowPages, 3);
  assert.equal(second.verifiedAt, window.value.startedAt); assert.equal(lookups.length, 1); assert.ok(modelCalls > 0);
  const [afterCursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`;
  assert.equal(afterCursor.value.scannedThrough, window.value.startedAt);
  assert.equal((await sql`SELECT 1 FROM monitor_state WHERE monitor_id='codex' AND (key LIKE 'collection:window:%' OR key LIKE 'collection:progress:%')`).length, 0);
}));

test("a final page exactly at the allowance completes without creating an artificial next page", async () => {
  pages = { officiala: Array.from({ length: 5 }, (_, index) => [tweet(String(101 + index), "OfficialA")]) };
  const result = await run(5, ["OfficialA"]);
  assert.equal(result.collectionComplete, true); assert.equal(result.pageLimitReached, false); assert.equal(result.paidPages, 5);
  assert.equal(calls.length, 5);
});

test("received pages replayed after an interrupted progress write do not consume the next allowance", async () => {
  pages = { officiala: Array.from({ length: 5 }, (_, index) => [tweet(String(101 + index), "OfficialA")]) };
  await run(2, ["OfficialA"]);
  const key = inMonitor(definition(), () => collectionProgressKey("pagination-round"));
  await sql`DELETE FROM monitor_state WHERE monitor_id='codex' AND key=${key}`;
  const second = await run(2, ["OfficialA"], true);
  assert.equal(second.collectionComplete, false); assert.equal(second.reusedPages, 2); assert.equal(second.paidPages, 2); assert.equal(second.pages, 4);
  assert.equal(calls.length, 4, "two replayed pages reuse receipts instead of reaching the fake supplier");
  const third = await run(2, ["OfficialA"], true);
  assert.equal(third.collectionComplete, true); assert.equal(third.paidPages, 1); assert.equal(calls.length, 5);
  assert.equal((await saved()).posts.length, 5);
});

test("a definite refusal preserves the failing cursor and resumes without repurchasing successful pages", async () => {
  pages = { officiala: Array.from({ length: 4 }, (_, index) => [tweet(String(101 + index), "OfficialA")]) };
  refusal = "officiala:2";
  await assert.rejects(run(5, ["OfficialA"]), /429/);
  refusal = null;
  const result = await run(5, ["OfficialA"], true);
  assert.equal(result.collectionComplete, true); assert.equal(result.paidPages, 2); assert.equal(result.windowPages, 4);
  assert.deepEqual(calls.map(call => call.cursor), [null, "1", "2", "2", "3"]);
  const attempts = await sql`SELECT attempts FROM receipts ORDER BY id`;
  assert.deepEqual(attempts.map(row => row.attempts), [1, 1, 2, 1]);
});

test("repeated pagination cursors are detected across separate capped tasks", async () => {
  pages = { officiala: [[tweet("101", "OfficialA")]] }; repeatedCursor = true;
  assert.equal((await run(1, ["OfficialA"])).pageLimitReached, true);
  await assert.rejects(run(1, ["OfficialA"], true), /repeated page cursor/);
});

test("omitting a page allowance preserves complete collection and configuration changes cannot alter a saved window", async () => {
  pages = { officiala: Array.from({ length: 6 }, (_, index) => [tweet(String(101 + index), "OfficialA")]) };
  assert.equal((await run(undefined, ["OfficialA"])).paidPages, 6);
  await assert.rejects(run(2, ["OfficialB"], true), /window configuration changed/);
});

test("TwitterAPI search responses obey the same allowance and resume the next cursor", async () => {
  process.env.CODEX_RESET_PROVIDER = "twitterapi_io";
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('twitterapi_io',1000,1000,1000)`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex','cursor:twitterapi_io',${sql.json({ checkpointVersion: 2, scannedThrough: since })})`;
  pages = { officiala: [[tweet("101", "OfficialA")], [tweet("102", "OfficialA")]] };
  const first = await run(1, ["OfficialA"]);
  assert.equal(first.pageLimitReached, true); assert.equal(first.paidPages, 1);
  const second = await run(1, ["OfficialA"], true);
  assert.equal(second.collectionComplete, true); assert.equal(second.paidPages, 1); assert.equal(second.windowPages, 2);
  assert.deepEqual(calls.map(call => call.cursor), [null, "1"]);
});
