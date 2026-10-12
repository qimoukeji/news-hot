import { Reply, stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { inMonitor } from "@aihot/reset-monitor/backend/context";
import { collectPosts, monitorTick, screenPendingPosts } from "@aihot/reset-monitor/backend/scan";
import { backendDefinition } from "../backend-definition.ts";
import server from "../server.ts";

// Synthetic transport and model responses; no external service is called.
const scoped = <T>(run: () => T) => inMonitor(backendDefinition, run);
const now = Date.now();
const initialRange = { since: new Date(now - 3600_000).toISOString(), until: new Date(now - 1000).toISOString() };
const tweet = (id: string, author: string) => ({ id_str: id, tweet_created_at: new Date(now - 60_000).toISOString(), full_text: "An ordinary product update.", user: { screen_name: author, name: author } });
const calls: URL[] = [];
const modelInputs: string[] = [];
let failedAuthor = false;
let failedModel = false;
const provider = await stub((_hit, req) => {
  const url = new URL(req.url, "http://stub");
  calls.push(url);
  if (url.pathname.startsWith("/twitter/tweets/")) return tweet("101", "bot");
  const handle = /from:(\w+)/.exec(url.searchParams.get("query")!)![1];
  if (handle === "grok" && failedAuthor) return new Reply(500, { error: "synthetic collection failure" });
  const next = url.searchParams.get("cursor");
  if (handle === "bot") return { tweets: next ? [tweet("101", "BOT")] : [tweet("101", "BOT"), tweet("999", "reader")], next_cursor: next ? null : "same-next" };
  return { tweets: next ? [tweet("103", "GROK")] : [{ ...tweet("102", "GrOk"), in_reply_to_status_id_str: "101" }], next_cursor: next ? null : "same-next" };
});
const model = await stub((_hit, req) => {
  modelInputs.push(JSON.parse(req.body).messages.at(-1).content);
  if (failedModel) return new Reply(500, { error: "synthetic model failure" });
  return { choices: [{ message: { content: JSON.stringify({ relevant: false, translationZh: null, contextZh: [], outage: null, needsReview: false, propositions: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});
Object.assign(process.env, { SOCIALDATA_BASE_URL: provider.url, SOCIALDATA_API_KEY: "test-key", GROK_RESET_PROVIDER: "socialdata",
  MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "synthetic-monitor" });
config.allowPrivateNetworkFetch = true;
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts`;
  await sql`DELETE FROM budgets`;
  calls.length = 0; modelInputs.length = 0;
  failedAuthor = false; failedModel = false;
  process.env.COLLECT_ENABLED = "true"; config.modelCallsEnabled = true;
  installModules([server]);
});
after(async () => { installModules([]); await provider.close(); await model.close(); await closeDb(); });

test("both accounts share one window, paginate independently, keep their own author and deduplicate overlap", async () => {
  const first = await scoped(() => collectPosts({ initialRange, roundId: "first" }));
  assert.deepEqual(first, { stored: 3, pages: 4 });
  const queries = calls.map(url => url.searchParams.get("query")!);
  assert.match(queries[0]!, /^from:bot /);
  assert.match(queries[2]!, /^from:grok /);
  assert.equal(queries[0]!.split(" ").slice(1).join(" "), queries[2]!.split(" ").slice(1).join(" "));
  assert.equal(calls[1]!.searchParams.get("cursor"), "same-next");
  assert.equal(calls[2]!.searchParams.get("cursor"), null);
  assert.equal(calls[3]!.searchParams.get("cursor"), "same-next");
  const posts = await sql`SELECT id,author,url FROM monitor_posts ORDER BY id`;
  assert.deepEqual(posts.map(p => p.author), ["bot", "grok", "grok"]);
  assert.equal(posts[1]!.url, "https://x.com/grok/status/102");
  assert.equal((await scoped(() => collectPosts({ initialRange, roundId: "overlap" }))).stored, 0);
});

test("second account failure and model failure preserve posts without advancing successful coverage", async () => {
  failedAuthor = true;
  await assert.rejects(scoped(() => monitorTick({ initialRange })), /500|synthetic collection failure/);
  assert.equal((await sql`SELECT id FROM monitor_posts`).length, 1);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key='cursor:socialdata'`).length, 0);
  assert.equal(modelInputs.length, 0);
  const beforeResume = calls.length;
  failedAuthor = false; failedModel = true;
  await assert.rejects(scoped(() => monitorTick({ initialRange })), /500|synthetic model failure/);
  assert.ok(calls.slice(beforeResume).every(url => url.searchParams.get("query")?.startsWith("from:grok ")));
  assert.equal((await sql`SELECT id FROM monitor_posts`).length, 3);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key='cursor:socialdata'`).length, 0);
  failedModel = false;
  const collectionHits = calls.length;
  const completed = await scoped(() => monitorTick({ initialRange }));
  assert.equal(calls.length, collectionHits);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE monitor_id='grok' AND key='initial:socialdata'`).length, 0);
  assert.equal("pending" in completed ? completed.pending : -1, 0);
  const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key='cursor:socialdata'`;
  assert.equal(Date.parse(cursor!.value.scannedThrough), Math.floor(Date.parse(initialRange.until) / 1000) * 1000);
  assert.equal((await sql`SELECT id FROM monitor_posts WHERE processed_at IS NULL`).length, 0);
  assert.ok(modelInputs.some(input => input.includes("作者 @bot")));
  assert.ok(modelInputs.some(input => input.includes("作者 @grok")));
  const modelCount = modelInputs.length;
  await scoped(() => monitorTick());
  assert.equal(modelInputs.length, modelCount);
  const previous = (await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key='cursor:socialdata'`)[0]!.value;
  failedAuthor = true;
  await assert.rejects(scoped(() => monitorTick()), /500|synthetic collection failure/);
  assert.deepEqual((await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key='cursor:socialdata'`)[0]!.value, previous);
});

test("an explicit collection filter preserves earlier excluded replies without purchasing their context or model result", async () => {
  await scoped(() => collectPosts({ lookbackHours: 1 }));
  const definition = { ...backendDefinition, collectionFilter: {
    query: "(-filter:replies OR quota)", version: "synthetic-scope-v1", reason: "Synthetic operator-selected scope",
    accepts: ({ text, isReply }: { text: string; isReply: boolean }) => !isReply || /\bquota\b/i.test(text),
  } };
  const result = await inMonitor(definition, () => monitorTick({ initialRange }));
  assert.equal("screened" in result ? result.screened : 0, 1);
  assert.equal(modelInputs.length, 2);
  assert.ok(modelInputs.every(input => !input.startsWith("帖子 102，")));
  const [excluded] = await sql`SELECT text,raw,recognition,processed_at FROM monitor_posts WHERE monitor_id='grok' AND id='102'`;
  assert.equal(excluded!.text, "An ordinary product update.");
  assert.equal(excluded!.raw.contextPending, false);
  assert.equal(excluded!.recognition.collectionFilter.version, "synthetic-scope-v1");
  assert.equal(excluded!.recognition.modelResult, undefined);
  assert.ok(excluded!.processed_at);
  assert.ok(calls.some(url => url.searchParams.get("query")?.includes("(-filter:replies OR quota)")));
  assert.equal(calls.filter(url => url.pathname.startsWith("/twitter/tweets/")).length, 0);
});

test("collection screening leaves already processed review decisions unchanged", async () => {
  await scoped(() => collectPosts({ initialRange }));
  await sql`UPDATE monitor_posts SET processed_at=now(),recognition='{"relevant":true,"manualReview":{"by":"synthetic-admin"}}'::jsonb WHERE monitor_id='grok' AND id='102'`;
  const [before] = await sql`SELECT * FROM monitor_posts WHERE monitor_id='grok' AND id='102'`;
  await inMonitor({ ...backendDefinition, collectionFilter: { query: "-filter:replies", version: "synthetic", reason: "Synthetic scope", accepts: ({ isReply }) => !isReply } }, () => screenPendingPosts());
  const [after] = await sql`SELECT * FROM monitor_posts WHERE monitor_id='grok' AND id='102'`;
  assert.deepEqual(after, before);
});

test("separate scope queries paginate independently for each author and deduplicate their union", async () => {
  const definition = { ...backendDefinition, collectionFilter: { query: ["-filter:replies", "filter:replies quota"], version: "synthetic-union", reason: "Synthetic union", accepts: () => true } };
  const result = await inMonitor(definition, () => collectPosts({ initialRange }));
  assert.deepEqual(result, { stored: 3, pages: 8 });
  const queries = calls.map(url => url.searchParams.get("query")!);
  assert.match(queries[0]!, /^from:bot -filter:replies /);
  assert.match(queries[2]!, /^from:bot filter:replies quota /);
  assert.match(queries[4]!, /^from:grok -filter:replies /);
  assert.match(queries[6]!, /^from:grok filter:replies quota /);
  for (const index of [0, 2, 4, 6]) {
    assert.equal(calls[index]!.searchParams.get("cursor"), null);
    assert.equal(calls[index + 1]!.searchParams.get("cursor"), "same-next");
    assert.match(queries[index]!, new RegExp(`since_time:${Math.floor(Date.parse(initialRange.since) / 1000)} until_time:${Math.floor(Date.parse(initialRange.until) / 1000)}$`));
  }
});
