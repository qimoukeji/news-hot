import { Reply, stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { inMonitor } from "../backend/context.ts";
import { collectPosts, monitorTick } from "../backend/scan.ts";
import { backendDefinition } from "../../grok-reset/backend-definition.ts";
import { paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { installModules } from "@aihot/backend/modules";
import module from "../../grok-reset/server.ts";

installModules([module]);

// Synthetic pages and account credentials; requests only reach a local service.
const now = Date.now();
const initialRange = { since: new Date(now - 3600_000).toISOString(), until: new Date(now - 1000).toISOString() };
const definition = { ...backendDefinition, collectionFilter: {
  query: ["-filter:replies", "filter:replies quota"], version: "synthetic-v1", reason: "Synthetic initialization", accepts: () => true,
} };
const scoped = <T>(run: () => T) => inMonitor(definition, run);
const calls: Array<{ query: string; cursor: string | null }> = [];
let fail = "";
let repeated = false;
let extraPost = false;
let withReply = false;
let failParent = false;
const lookups: string[] = [];
const tweet = (id: string, author: string) => ({ id_str: id, tweet_created_at: new Date(now - 60_000).toISOString(), full_text: "Synthetic ordinary update.", user: { screen_name: author, name: author } });
const provider = await stub((_hit, req) => {
  const url = new URL(req.url, "http://stub");
  if (url.pathname.startsWith("/twitter/tweets/")) {
    const id = url.pathname.split("/").at(-1)!;
    lookups.push(id);
    if (id === "901" && failParent) return new Reply(402, { message: "Synthetic context account exhausted" });
    return { ...tweet(id, "alice"), ...(id === "900" ? { in_reply_to_status_id_str: "901" } : {}) };
  }
  const query = url.searchParams.get("query")!; const cursor = url.searchParams.get("cursor");
  calls.push({ query, cursor });
  const author = /from:(\w+)/.exec(query)![1]!;
  const reply = query.includes("filter:replies quota");
  const name = `${author}:${reply ? "reply" : "original"}:${cursor ?? "start"}`;
  if (name === fail) return new Reply(402, { message: "Synthetic exhausted account" });
  const id = `${author === "bot" ? "1" : "2"}${reply ? "2" : "1"}${cursor ? "2" : "1"}`;
  return { tweets: [{ ...tweet(id, author), ...(withReply && id === "111" ? { in_reply_to_status_id_str: "900" } : {}) }, ...(extraPost && !cursor ? [tweet("999", author)] : [])], next_cursor: cursor && !repeated ? null : "next" };
});
const model = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ relevant: false, translationZh: null, contextZh: [], outage: null, needsReview: false, propositions: [] }) }, finish_reason: "stop" }] }));
process.env.SOCIALDATA_BASE_URL = provider.url;
process.env.GROK_RESET_PROVIDER = "socialdata";
process.env.MONITOR_MODEL = "deepseek-flash";
process.env.DEEPSEEK_BASE_URL = model.url;
process.env.DEEPSEEK_API_KEY = "synthetic-model-key";
config.allowPrivateNetworkFetch = true;
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts`;
  await sql`DELETE FROM budgets`;
  calls.length = 0; lookups.length = 0; fail = ""; repeated = false; extraPost = false; withReply = false; failParent = false;
  config.modelCallsEnabled = true;
  process.env.COLLECT_ENABLED = "true"; process.env.SOCIALDATA_API_KEY = "synthetic-account-one";
});
after(async () => { await provider.close(); await model.close(); await closeDb(); });
const progress = async () => (await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key='initial:socialdata'`)[0]!.value;

test("initialization resumes the unfinished query and page after switching provider accounts", async () => {
  fail = "grok:original:next";
  await assert.rejects(scoped(() => collectPosts({ initialRange })), /402/);
  assert.equal(calls.length, 6);
  assert.equal((await progress()).queryIndex, 2);
  assert.equal((await progress()).cursor, "next");
  assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_posts`)[0]!.n, 5);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key='cursor:socialdata'`).length, 0);
  process.env.SOCIALDATA_API_KEY = "synthetic-account-two"; fail = "";
  calls.length = 0;
  assert.deepEqual(await scoped(() => collectPosts({ initialRange })), { stored: 3, pages: 3 });
  assert.equal(calls[0]!.cursor, "next");
  assert.ok(calls.every(c => c.query.startsWith("from:grok ")));
  assert.match(calls[1]!.query, /filter:replies quota/);
  assert.equal(calls[1]!.cursor, null);
  assert.equal((await progress()).queryIndex, 4);
  assert.deepEqual(await scoped(() => collectPosts({ initialRange })), { stored: 0, pages: 0 });
  assert.equal(calls.length, 3);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE status='completed'`)[0]!.n, 8);
});

test("range, author order, query and filter version mismatches reject before another paid request", async () => {
  fail = "bot:original:next";
  await assert.rejects(scoped(() => collectPosts({ initialRange })), /402/);
  const hits = calls.length; const saved = await progress();
  await assert.rejects(scoped(() => collectPosts({ initialRange: { ...initialRange, since: new Date(now - 7200_000).toISOString() } })), /different range/);
  for (const changed of [
    { ...definition, authors: [...definition.authors].reverse() },
    { ...definition, collectionFilter: { ...definition.collectionFilter, query: ["quota"] } },
    { ...definition, collectionFilter: { ...definition.collectionFilter, version: "synthetic-v2" } },
  ]) await assert.rejects(inMonitor(changed, () => collectPosts({ initialRange })), /different range/);
  assert.equal(calls.length, hits);
  assert.deepEqual(await progress(), saved);
});

test("posts, completed receipt and next-page progress commit together", async () => {
  await sql`CREATE FUNCTION reject_synthetic_post() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='999' THEN RAISE EXCEPTION 'synthetic write failure'; END IF; RETURN NEW; END $$`;
  await sql`CREATE TRIGGER reject_synthetic_post BEFORE INSERT ON monitor_posts FOR EACH ROW EXECUTE FUNCTION reject_synthetic_post()`;
  extraPost = true;
  try {
    await assert.rejects(scoped(() => collectPosts({ initialRange })), /synthetic write failure/);
    assert.equal((await sql`SELECT id FROM monitor_posts`).length, 0);
    assert.equal((await sql`SELECT status FROM receipts`)[0]!.status, "received");
    assert.equal((await progress()).queryIndex, 0);
    assert.equal((await progress()).cursor, null);
  } finally {
    await sql`DROP TRIGGER reject_synthetic_post ON monitor_posts`;
    await sql`DROP FUNCTION reject_synthetic_post()`;
  }
  extraPost = false;
  const hits = calls.length;
  await scoped(() => collectPosts({ initialRange }));
  assert.equal(calls.length - hits, 7); // The first paid response is reused, not purchased again.
  assert.equal((await sql`SELECT id FROM monitor_posts WHERE id='999'`).length, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n, 8);
});

test("a repeated cursor across a restart aborts without advancing the saved page", async () => {
  fail = "bot:original:next";
  await assert.rejects(scoped(() => collectPosts({ initialRange })), /402/);
  const saved = await progress(); fail = ""; repeated = true;
  await assert.rejects(scoped(() => collectPosts({ initialRange })), /repeated page cursor/);
  assert.deepEqual(await progress(), saved);
  assert.equal((await sql`SELECT id FROM monitor_posts`).length, 1);
});

test("normal scans and lookbacks refuse unfinished initialization before another paid request", async () => {
  fail = "bot:original:next";
  await assert.rejects(scoped(() => collectPosts({ initialRange })), /402/);
  const saved = await progress(); fail = "";
  await sql`INSERT INTO monitor_state (monitor_id,key,value) VALUES ('grok','cursor:socialdata',${sql.json({ checkpointVersion: 2, scannedThrough: initialRange.since })})`;
  for (const options of [{}, { lookbackHours: 24 }]) {
    calls.length = 0;
    await assert.rejects(scoped(() => collectPosts(options)), /unfinished initialization/);
    assert.equal(calls.length, 0);
    assert.deepEqual(await progress(), saved);
  }
});

test("saved initialization progress is isolated by monitor and provider", async () => {
  fail = "bot:original:next";
  await assert.rejects(scoped(() => collectPosts({ initialRange })), /402/);
  const saved = await progress(); fail = ""; calls.length = 0;
  await inMonitor({ ...definition, monitorId: "synthetic-other" }, () => collectPosts({ initialRange }));
  assert.equal(calls[0]!.cursor, null);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE monitor_id='synthetic-other' AND key='initial:socialdata'`).length, 1);
  process.env.GROK_RESET_PROVIDER = "twitterapi_io";
  try {
    await assert.rejects(scoped(() => collectPosts({ initialRange })), /TWITTERAPI_IO_API_KEY/);
    assert.equal((await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key='initial:twitterapi_io'`)[0]!.value.cursor, null);
  } finally { process.env.GROK_RESET_PROVIDER = "socialdata"; }
  assert.deepEqual(await progress(), saved);
});

test("an unknown billing attempt blocks repeated initialization with the same page identity", async () => {
  fail = "bot:original:start";
  await assert.rejects(scoped(() => collectPosts({ initialRange })), /402/);
  const saved = await progress();
  await assert.rejects(paidRequest({ service: "socialdata", purpose: "reset_monitor.grok.scan", retryFailed: true,
    identity: { query: calls[0]!.query, type: "Latest", cursor: null, window: saved.pageWindow } }, async () => {
      throw new Error("synthetic connection lost after sending");
    }), ReceiptUnknownError);
  fail = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(scoped(() => collectPosts({ initialRange })), ReceiptUnknownError);
    assert.deepEqual(await progress(), saved);
  }
  assert.equal(calls.length, 1);
});

test("collect-only saves all pages without context, recognition, pushes or a success checkpoint", async () => {
  withReply = true;
  config.modelCallsEnabled = false;
  const hits = model.hits();
  const result = await scoped(() => monitorTick({ initialRange, collectOnly: true }));
  assert.equal("collectOnly" in result && result.collectOnly, true);
  assert.equal((await progress()).queryIndex, 4);
  assert.equal(model.hits(), hits);
  assert.equal(lookups.length, 0);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key LIKE 'cursor:%'`).length, 0);
  assert.equal((await sql`SELECT id FROM receipts WHERE purpose LIKE '%context' OR purpose LIKE '%recognize'`).length, 0);
  assert.equal((await sql`SELECT id FROM monitor_posts WHERE processed_at IS NOT NULL`).length, 0);
  assert.equal((await sql`SELECT raw->>'contextPending' AS pending FROM monitor_posts WHERE id='111'`)[0]!.pending, "true");
});

test("initialization reuses a received first parent after the second parent fails and the account changes", async () => {
  withReply = true; failParent = true;
  await assert.rejects(scoped(() => monitorTick({ initialRange })), /402/);
  const saved = await progress();
  assert.equal(saved.queryIndex, 4);
  assert.deepEqual(lookups, ["900", "901"]);
  const pageHits = calls.length;
  process.env.SOCIALDATA_API_KEY = "synthetic-account-two";
  failParent = false; lookups.length = 0;
  await scoped(() => monitorTick({ initialRange }));
  assert.deepEqual(lookups, ["901"]);
  assert.equal(calls.length, pageHits);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key='initial:socialdata'`).length, 0);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key='cursor:socialdata'`).length, 1);
});

test("initialization reuses a valid model response after business write failure", async () => {
  await sql`CREATE FUNCTION reject_synthetic_recognition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='111' AND NEW.processed_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic recognition write failure'; END IF; RETURN NEW; END $$`;
  await sql`CREATE TRIGGER reject_synthetic_recognition BEFORE UPDATE ON monitor_posts FOR EACH ROW EXECUTE FUNCTION reject_synthetic_recognition()`;
  const hits = model.hits();
  try {
    await assert.rejects(scoped(() => monitorTick({ initialRange })), /synthetic recognition write failure/);
    assert.equal(model.hits() - hits, 1);
    assert.equal((await sql`SELECT status FROM receipts WHERE purpose='reset_monitor.grok.recognize'`)[0]!.status, "received");
  } finally {
    await sql`DROP TRIGGER reject_synthetic_recognition ON monitor_posts`;
    await sql`DROP FUNCTION reject_synthetic_recognition()`;
  }
  await scoped(() => monitorTick({ initialRange }));
  assert.equal(model.hits() - hits, 8); // One successful response per post; no repeat purchase of 111.
});

test("explicit supplemental queries preserve the original unfinished page and complete missing scope", async () => {
  fail = "grok:reply:next";
  await assert.rejects(scoped(() => collectPosts({ initialRange })), /402/);
  const saved = await progress();
  const expanded = { ...definition, collectionFilter: { ...definition.collectionFilter, supplementalQueries: ["filter:replies reward"] } };
  fail = ""; calls.length = 0;
  await inMonitor(expanded, () => collectPosts({ initialRange }));
  assert.match(calls[0]!.query, /^from:grok filter:replies quota/);
  assert.equal(calls[0]!.cursor, saved.cursor);
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(1).every(c => c.query.includes("filter:replies reward")));
  assert.equal((await progress()).queryIndex, 6);
  assert.equal((await progress()).processingWindow, saved.processingWindow);
});
