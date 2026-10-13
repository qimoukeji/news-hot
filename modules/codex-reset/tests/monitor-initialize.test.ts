import "../../reset-monitor/tests/automatic-fixture.ts";
import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import monitor from "../server.ts";
import { collectPosts, monitorTick, processPending } from "../backend/scan.ts";
import { initialRangeFromArgs } from "../scripts/initialize.ts";

installModules([monitor]);
const unrelated = { relevant: false, translationZh: null, contextZh: [], outage: null, needsReview: false, propositions: [] };
let collected: unknown = { tweets: [] };
let recognized: unknown = unrelated;
let modelUser = "";
const queries: string[] = [];
const provider = await stub((_hit, request) => { queries.push(new URL(request.url, "http://stub").searchParams.get("query")!); return collected; });
const model = await stub((_hit, request) => {
  modelUser = JSON.parse(request.body).messages.at(-1).content;
  return { choices: [{ message: { content: JSON.stringify(recognized) }, finish_reason: "stop" }] };
});
process.env.SOCIALDATA_BASE_URL = provider.url;
process.env.SOCIALDATA_API_KEY = "test-key";
process.env.DEEPSEEK_BASE_URL = model.url;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.MONITOR_MODEL = "deepseek-flash";
config.allowPrivateNetworkFetch = true;

beforeEach(async () => {
  process.env.CODEX_RESET_PROVIDER = "socialdata";
  process.env.COLLECT_ENABLED = "true";
  config.modelCallsEnabled = true;
  collected = { tweets: [] }; recognized = unrelated; modelUser = ""; queries.length = 0;
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts WHERE purpose LIKE 'monitor.%'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service IN ('socialdata', 'deepseek')`;
});
after(async () => { await provider.close(); await model.close(); await stopBoss(); await closeDb(); });

const range = () => ({ since: new Date(Date.now() - 24 * 3600_000).toISOString(), until: new Date(Date.now() - 60_000).toISOString() });
const tweet = () => ({ id_str: "100", full_text: "ordinary words", tweet_created_at: new Date(Date.now() - 120_000).toISOString(), user: { screen_name: "thsottiaux", name: "Tibo" } });

test("uninitialized normal schedules and collector calls reject before any paid work", async () => {
  const modelHits = model.hits();
  await assert.rejects(collectPosts(), /not initialized/);
  await assert.rejects(monitor.schedules![0].run(), /not initialized/);
  assert.equal(queries.length, 0); assert.equal(model.hits(), modelHits);
  assert.equal((await sql`SELECT id FROM receipts WHERE purpose LIKE 'monitor.%'`).length, 0);
  assert.equal((await sql`SELECT value FROM monitor_state WHERE key = 'cursor:socialdata'`).length, 0);
});

test("daily bounded lookback cannot initialize a normal success checkpoint", async () => {
  await monitorTick({ lookbackHours: 24 });
  assert.match(queries[0], /since_time:\d+ until_time:\d+/);
  assert.equal((await sql`SELECT value FROM monitor_state WHERE key = 'cursor:socialdata'`).length, 0);
  await assert.rejects(monitorTick(), /not initialized/);
  assert.equal(queries.length, 1);
});

test("failed initialization keeps saved posts and establishes no checkpoint until the complete round succeeds", async () => {
  const initialRange = range();
  collected = { tweets: [tweet()] }; recognized = {};
  await assert.rejects(monitorTick({ initialRange }), /unusable output/);
  assert.equal((await sql`SELECT id FROM monitor_posts`).length, 1);
  assert.equal((await sql`SELECT value FROM monitor_state WHERE key = 'cursor:socialdata'`).length, 0);
  const hits = queries.length;
  await assert.rejects(monitorTick(), /unfinished initialization/);
  await assert.rejects(monitorTick({ lookbackHours: 24 }), /unfinished initialization/);
  assert.equal(queries.length, hits);
  recognized = unrelated;
  await monitorTick({ initialRange });
  const checkpoint = (await sql`SELECT value FROM monitor_state WHERE key = 'cursor:socialdata'`)[0]!.value;
  assert.equal(checkpoint.scannedThrough, new Date(Math.floor(Date.parse(initialRange.until) / 1000) * 1000).toISOString());
  await monitorTick();
  assert.equal(queries.at(-1)!.match(/since_time:(\d+)/)![1], String(Math.floor(Date.parse(initialRange.until) / 1000)));
  await assert.rejects(monitorTick({ initialRange }), /requires a new collector checkpoint/);
});

test("initialization preserves the configured budget and does not create a watermark after a refusal", async () => {
  const initialRange = range();
  await sql`UPDATE budgets SET per_minute = 0 WHERE service = 'socialdata'`;
  await assert.rejects(monitorTick({ initialRange }), /Budget for socialdata exhausted/);
  assert.equal(queries.length, 0);
  assert.equal((await sql`SELECT per_minute FROM budgets WHERE service = 'socialdata'`)[0]!.per_minute, 0);
  assert.equal((await sql`SELECT value FROM monitor_state WHERE key = 'cursor:socialdata'`).length, 0);
});

test("initialization CLI validates a finite explicit range and performs the complete bounded round", async () => {
  const now = new Date("2026-10-09T00:00:00Z");
  assert.deepEqual(initialRangeFromArgs(["--since", "2026-10-08T00:00:00Z", "--until", "2026-10-08T01:00:00Z"], now), { since: "2026-10-08T00:00:00Z", until: "2026-10-08T01:00:00Z" });
  for (const args of [[], ["--since", "2026-10-08"], ["--since", "2026-10-08T00:00:00Z", "--until", "2026-10-10T00:00:00Z"], ["--since", "2026-10-08T01:00:00Z", "--until", "2026-10-08T00:00:00Z"]]) assert.throws(() => initialRangeFromArgs(args, now));
  assert.equal(initialRangeFromArgs(["--help"]), null);
  collected = { tweets: [tweet()] };
  const initialRange = range();
  const command = fileURLToPath(new URL("../scripts/initialize.ts", import.meta.url));
  const result = await promisify(execFile)(process.execPath, ["--import", fileURLToPath(new URL("../../reset-monitor/tests/automatic-fixture.ts", import.meta.url)), command, "--since", initialRange.since, "--until", initialRange.until], { env: { ...process.env, ALLOW_PRIVATE_NETWORK_FETCH: "true" }, timeout: 20_000 });
  assert.equal(JSON.parse(result.stdout).pending, 0);
  assert.equal((await sql`SELECT processed_at FROM monitor_posts WHERE id = '100'`)[0]!.processed_at instanceof Date, true);
  assert.equal((await sql`SELECT value FROM monitor_state WHERE key = 'cursor:socialdata'`)[0]!.value.checkpointVersion, 2);
});

test("collect-only CLI needs no model credentials and retains the unfinished initialization", async () => {
  collected = { tweets: [{ ...tweet(), in_reply_to_status_id_str: "101" }] };
  const initialRange = range();
  const hits = model.hits();
  const command = fileURLToPath(new URL("../scripts/initialize.ts", import.meta.url));
  const result = await promisify(execFile)(process.execPath, ["--import", fileURLToPath(new URL("../../reset-monitor/tests/automatic-fixture.ts", import.meta.url)), command, "--since", initialRange.since, "--until", initialRange.until, "--collect-only"], {
    env: { ...process.env, ALLOW_PRIVATE_NETWORK_FETCH: "true", MODEL_CALLS_ENABLED: "false", DEEPSEEK_API_KEY: "", LLM_API_KEY: "" }, timeout: 20_000,
  });
  assert.equal(JSON.parse(result.stdout).collectOnly, true);
  assert.equal(model.hits(), hits);
  assert.equal((await sql`SELECT processed_at FROM monitor_posts WHERE id='100'`)[0]!.processed_at, null);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key='initial:socialdata'`).length, 1);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key='cursor:socialdata'`).length, 0);
  assert.equal((await sql`SELECT id FROM receipts WHERE purpose IN ('monitor.context','monitor.recognize')`).length, 0);
});

async function existingEvent(id: string, source: string, at: Date, withdrawn = false) {
  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url, processed_at) VALUES (${source}, 'thsottiaux', ${at}, 'All reset for everyone.', ${`https://x.com/i/status/${source}`}, ${at}) ON CONFLICT (monitor_id, id) DO NOTHING`;
  await sql`INSERT INTO monitor_events (id, type, status, title, created_at, updated_at, confirmed_at, confirmation_basis, withdrawn)
    VALUES (${id}, 'direct_reset', 'confirmed', 'Codex reset', ${at}, ${at}, ${at}, 'source_post', ${withdrawn})`;
  await sql`INSERT INTO monitor_event_posts (event_id, post_id, stage, action, text, original_text)
    VALUES (${id}, ${source}, 'confirmation', 'confirm', '全部重置', 'All reset for everyone.')`;
}

for (const relation of ["reply", "quote"]) test(`${relation} context supplies an old confirmed target before all recent candidates`, async () => {
  const now = new Date(); const old = new Date(now.getTime() - 10 * 86400_000);
  await existingEvent("old-confirmed", "101", old);
  for (let i = 0; i < 9; i++) await existingEvent(`recent-${i}`, String(200 + i), new Date(now.getTime() - (i + 1) * 3600_000));
  const context = [{ id: "101", author: "thsottiaux", relation, text: "All reset for everyone.", publishedAt: old.toISOString() }];
  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url, raw)
    VALUES ('1000', 'thsottiaux', ${now}, 'All reset for everyone.', 'https://x.com/i/status/1000', ${sql.json({ context })})`;
  recognized = { ...unrelated, relevant: true, propositions: [{ kind: "direct_reset", kindExplicit: true, action: "confirm", real: true, count: 1, relatesTo: "old-confirmed", excerpt: "All reset for everyone.", excerptZh: "全部重置", statedTime: null, timeInferred: false, expectedLanding: null, scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null } }] };
  await processPending();
  assert.match(modelUser, /old-confirmed｜direct_reset｜confirmed/);
  assert.ok(modelUser.indexOf("- old-confirmed｜") < modelUser.indexOf("- recent-0｜"));
  assert.equal((modelUser.match(/- recent-\d+｜/g) ?? []).length, 8);
  assert.deepEqual((await sql`SELECT event_id FROM monitor_event_posts WHERE post_id = '1000'`).map(row => row.event_id), ["old-confirmed"]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_events`)[0]!.n, 10);
});

test("all events associated with explicit context survive the recent-candidate limit", async () => {
  const now = new Date(); const old = new Date(now.getTime() - 10 * 86400_000);
  for (let i = 0; i < 9; i++) await existingEvent(`thread-${i}`, "101", old);
  await existingEvent("withdrawn-thread", "101", old, true);
  await existingEvent("future-thread", "101", new Date(now.getTime() + 3600_000));
  const context = [{ id: "101", author: "thsottiaux", relation: "reply", text: "All reset for everyone.", publishedAt: old.toISOString() }];
  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url, raw)
    VALUES ('1000', 'thsottiaux', ${now}, 'Related explanation', 'https://x.com/i/status/1000', ${sql.json({ context })})`;
  await processPending();
  assert.equal((modelUser.match(/- thread-\d+｜/g) ?? []).length, 9);
  assert.ok(!modelUser.includes("withdrawn-thread｜"));
  assert.ok(!modelUser.includes("future-thread｜"));
});
