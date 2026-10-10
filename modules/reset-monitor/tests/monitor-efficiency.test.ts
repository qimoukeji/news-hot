import { installModules } from "@aihot/backend/modules";

import monitorModule from "../../codex-reset/server.ts";

installModules([monitorModule]);

// Failure modes before optimizing collection: quiet scans keep buying old posts; an overlap drops a

// late-indexed reply below the newest id; an id-only cursor kept from an earlier version, downtime or

// daily lookback advances past an unread interval; failed pages advance the cursor; bounded pagination

// loses its original query; repeated replies buy the same parent again.

// Public reads must retain the full archive and conditional 304, while advertising the smaller

// polling endpoint.

import { Reply, stub } from "../../../tests/setup.ts";

import assert from "node:assert/strict";

import { after, beforeEach, test } from "node:test";

import { config } from "@aihot/backend/config";

import { closeDb, sql } from "@aihot/backend/db";

import { stopBoss } from "@aihot/backend/jobs/queue";

import { collectPosts, collectPendingContext, monitorTick } from "../../codex-reset/backend/scan.ts";

import type { SdTweet } from "@aihot/backend/providers/socialdata";

import { buildApp } from "../../../apps/api/src/app.ts";



const NOW = Date.parse("2026-10-01T12:00:00Z");

const MINUTE = 60_000;

let answer: (url: URL) => unknown = () => ({ tweets: [] });

const requests: URL[] = [];

const provider = await stub((_hit, req) => {

  const url = new URL(req.url, "http://stub"); requests.push(url); return answer(url);

});

process.env.SOCIALDATA_BASE_URL = provider.url;

process.env.SOCIALDATA_API_KEY = "test-key";

config.allowPrivateNetworkFetch = true;

const model = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ relevant: false, translationZh: "普通帖子", contextZh: [], propositions: [], outage: null, needsReview: false }) }, finish_reason: "stop" }] }));

process.env.DEEPSEEK_BASE_URL = model.url;

process.env.DEEPSEEK_API_KEY = "test-key";

process.env.MONITOR_MODEL = "deepseek-flash";

const app = await buildApp();



beforeEach(async () => {

  process.env.CODEX_RESET_PROVIDER = "socialdata";

  requests.length = 0; answer = () => ({ tweets: [] });

  await sql`DELETE FROM monitor_event_posts`;

  await sql`DELETE FROM monitor_events`;

  await sql`DELETE FROM monitor_posts`;

  await sql`DELETE FROM monitor_state`;

  await sql`DELETE FROM receipts WHERE purpose LIKE 'monitor.%'`;

  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service IN ('socialdata', 'deepseek')`;

});

after(async () => { await app.close(); await provider.close(); await model.close(); await stopBoss(); await closeDb(); });



async function state(key: string, value: unknown) {

  await sql`INSERT INTO monitor_state (key, value) VALUES (${key}, ${sql.json(value as never)}) ON CONFLICT (monitor_id, key) DO UPDATE SET value = EXCLUDED.value`;

}

async function cursor() { return (await sql`SELECT value FROM monitor_state WHERE key = 'cursor:socialdata'`)[0]!.value; }

function tweet(id: string, at = NOW, parent: string | null = null): SdTweet {

  return { id_str: id, tweet_created_at: new Date(at).toISOString(), full_text: `post ${id}`, user: { name: "Tibo", screen_name: "thsottiaux" }, in_reply_to_status_id_str: parent };

}

async function stored(t: SdTweet) {

  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url, raw) VALUES (${t.id_str}, 'thsottiaux', ${new Date(t.tweet_created_at)}, ${t.full_text!}, ${`https://x.com/thsottiaux/status/${t.id_str}`}, ${sql.json({ tweet: t } as never)})`;

}



test("quiet whole rounds advance coverage with exact lower and upper bounds", async (t) => {

  t.mock.timers.enable({ apis: ["Date"], now: NOW });

  await state("cursor:socialdata", { checkpointVersion: 2, scannedThrough: new Date(NOW - 10 * MINUTE).toISOString() });

  await monitorTick();

  assert.equal(requests[0]!.searchParams.get("query"), `from:thsottiaux since_time:${(NOW - 10 * MINUTE) / 1000} until_time:${NOW / 1000}`);

  assert.equal((await cursor()).scannedThrough, new Date(NOW).toISOString());

  t.mock.timers.setTime(NOW + 10 * MINUTE);

  await monitorTick();

  assert.equal(requests[1]!.searchParams.get("query"), `from:thsottiaux since_time:${NOW / 1000} until_time:${(NOW + 10 * MINUTE) / 1000}`);

  assert.equal(requests.length, 2, "no full-history fallback on empty results");

});



test("daily 24-hour lookback accepts a late-indexed reply without advancing live coverage", async (t) => {

  t.mock.timers.enable({ apis: ["Date"], now: NOW });

  await stored(tweet("300", NOW - 12 * MINUTE));

  await state("cursor:socialdata", { checkpointVersion: 2, scannedThrough: new Date(NOW - 10 * MINUTE).toISOString() });

  answer = () => ({ tweets: [tweet("300", NOW - 12 * MINUTE), tweet("299", NOW - 13 * MINUTE)] });

  assert.equal((await collectPosts({ lookbackHours: 24 })).stored, 1);

  assert.equal((await sql`SELECT count(*) AS n FROM monitor_posts WHERE id = '299'`)[0]!.n, 1);

  assert.equal((await cursor()).scannedThrough, new Date(NOW - 10 * MINUTE).toISOString());

  assert.equal(requests[0]!.searchParams.get("query"), `from:thsottiaux since_time:${(NOW - 24 * 3600_000) / 1000} until_time:${NOW / 1000}`);

});



test("legacy collection-only coverage is not trusted as a full-round success", async (t) => {

  t.mock.timers.enable({ apis: ["Date"], now: NOW });

  await state("cursor:socialdata", { sinceId: "300", scannedThrough: new Date(NOW - 4 * 86400_000).toISOString(), backlog: [{ next: "old-page" }] });

  await monitorTick({ initialRange: { since: new Date(NOW - 24 * 3600_000).toISOString(), until: new Date(NOW).toISOString() } });

  assert.equal(requests[0]!.searchParams.get("query"), `from:thsottiaux since_time:${(NOW - 24 * 3600_000) / 1000} until_time:${NOW / 1000}`);

  assert.deepEqual(await cursor(), { checkpointVersion: 2, scannedThrough: new Date(NOW).toISOString() });

});



test("daily lookback never jumps the live cursor over an older unread gap", async (t) => {

  t.mock.timers.enable({ apis: ["Date"], now: NOW });

  const old = NOW - 4 * 86400_000;

  const before = { checkpointVersion: 2, scannedThrough: new Date(old).toISOString() };

  await state("cursor:socialdata", before);

  answer = () => ({ tweets: [tweet("400")] });

  await collectPosts({ lookbackHours: 24 });

  assert.deepEqual(await cursor(), before);

  await collectPosts();

  assert.equal(requests[1]!.searchParams.get("query"), `from:thsottiaux since_time:${old / 1000} until_time:${NOW / 1000}`);

});



test("a failed incremental search preserves coverage for the next attempt", async (t) => {

  t.mock.timers.enable({ apis: ["Date"], now: NOW });

  const before = { checkpointVersion: 2, scannedThrough: new Date(NOW - 10 * MINUTE).toISOString() };

  await state("cursor:socialdata", before);

  answer = () => new Reply(503, { error: "temporarily unavailable" });

  await assert.rejects(collectPosts(), /503/);

  assert.deepEqual(await cursor(), before);

  answer = () => ({ tweets: [tweet("301")] });

  assert.equal((await collectPosts()).stored, 1);

  assert.equal(requests[1]!.searchParams.get("query"), requests[0]!.searchParams.get("query"));

});



test("reply context reuses stored posts and one paid parent across different replies", async (t) => {

  t.mock.timers.enable({ apis: ["Date"], now: NOW });

  await stored(tweet("100", NOW - MINUTE));

  answer = (url) => url.pathname.includes("/tweets/")

    ? tweet(url.pathname.split("/").at(-1)!, NOW - MINUTE)

    : { tweets: [tweet("503", NOW, "100"), tweet("502", NOW, "400"), tweet("501", NOW, "400")] };

  assert.equal((await collectPosts({ initialRange: { since: new Date(NOW - 24 * 3600_000).toISOString(), until: new Date(NOW).toISOString() } })).stored, 3);

  assert.equal(requests.filter((u) => u.pathname.includes("/tweets/")).length, 0, "main collection never buys reply context");

  assert.equal((await collectPendingContext()).completed, 3);

  assert.deepEqual(requests.filter((u) => u.pathname.includes("/tweets/")).map((u) => u.pathname), ["/twitter/tweets/400"]);

  const posts = await sql`SELECT id, context FROM monitor_posts WHERE id IN ('501','502','503') ORDER BY id`;

  assert.deepEqual(posts.map((p) => p.context[0].id), ["400", "400", "100"]);

  assert.ok(posts.every((p) => p.context[0].originalText === `post ${p.context[0].id}`));

});



test("full archive keeps its contract and advertises the polling alternative on 200 and 304", async () => {

  const response = await app.inject({ url: "/api/v1/codex-resets" });

  assert.equal(response.statusCode, 200);

  assert.ok(Array.isArray(response.json().events));

  assert.ok(Array.isArray(response.json().activities));

  assert.ok(String(response.headers.link).startsWith(`<${config.siteUrl}/api/v1/codex-resets/recent>; rel="alternate"`));

  const unchanged = await app.inject({ url: "/api/v1/codex-resets", headers: { "if-none-match": String(response.headers.etag) } });

  assert.equal(unchanged.statusCode, 304);

  assert.equal(unchanged.body, "");

  assert.equal(unchanged.headers.link, response.headers.link);

});
