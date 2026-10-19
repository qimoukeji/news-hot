import { installModules } from "@aihot/backend/modules";

import monitorModule from "../../codex-reset/server.ts";

installModules([monitorModule]);

// Quiet windows advance once; failed pages preserve the incomplete window.
// Public archives retain their full contract and conditional responses.
import { Reply, stub } from "../../../tests/setup.ts";

import assert from "node:assert/strict";

import { after, beforeEach, test } from "node:test";

import { config } from "@aihot/backend/config";

import { closeDb, sql } from "@aihot/backend/db";

import { stopBoss } from "@aihot/backend/jobs/queue";

import { collectPosts, monitorTick } from "../../codex-reset/backend/scan.ts";

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

  assert.equal(requests[0]!.searchParams.get("query"), `from:thsottiaux -filter:replies since_time:${(NOW - 10 * MINUTE) / 1000} until_time:${NOW / 1000}`);

  assert.equal((await cursor()).scannedThrough, new Date(NOW).toISOString());

  t.mock.timers.setTime(NOW + 10 * MINUTE);

  await monitorTick();

  assert.equal(requests[1]!.searchParams.get("query"), `from:thsottiaux -filter:replies since_time:${NOW / 1000} until_time:${(NOW + 10 * MINUTE) / 1000}`);

  assert.equal(requests.length, 2, "no full-history fallback on empty results");

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
