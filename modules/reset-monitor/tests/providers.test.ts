import { Reply, stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import timers from "node:timers/promises";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { collectPosts, processPending } from "../../codex-reset/backend/scan.ts";
import { paidRequest } from "@aihot/backend/providers/receipts";
import { searchTweets, tweetText } from "../../codex-reset/backend/providers/collectors.ts";
import { normalizeTweet } from "../../codex-reset/backend/providers/twitterapi.ts";
import { scanCron, scanMinutes } from "../../codex-reset/config.ts";
import { codexResetPage, codexResetVersion } from "../../codex-reset/backend/read.ts";

const calls: URL[] = [];
// Transport integration tests skip the real wait; the fixed interval is tested with a controlled clock.
mock.method(timers, "setTimeout", async () => undefined);
const post = (id: string) => ({ id, text: "Reset &amp; see https://t.co/a", createdAt: "2026-10-08T01:00:00Z", author: { name: "Tibo", userName: "thsottiaux" },
  entities: { urls: [{ url: "https://t.co/a", expanded_url: "https://example.com/reset" }] } });
let answer: (url: URL) => unknown = () => ({ tweets: [], has_next_page: false, next_cursor: "" });
const provider = await stub((_hit, req) => { const url = new URL(req.url, "http://stub"); calls.push(url); return answer(url); });
process.env.TWITTERAPI_IO_BASE_URL = provider.url;
process.env.TWITTERAPI_IO_API_KEY = "test-key";
process.env.SOCIALDATA_BASE_URL = provider.url;
process.env.SOCIALDATA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;
beforeEach(async () => {
  process.env.CODEX_RESET_PROVIDER = "twitterapi_io";
  process.env.COLLECT_ENABLED = "true";
  config.modelCallsEnabled = true;
  calls.length = 0;
  answer = () => ({ tweets: [], has_next_page: false, next_cursor: "" });
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts WHERE purpose LIKE 'monitor.%'`;
  await sql`DELETE FROM budgets WHERE service = 'twitterapi_io'`;
});
after(async () => { await provider.close(); await closeDb(); });

test("scan cadence defaults to fifteen minutes and keeps scheduling, page and version consistent", async () => {
  const original = process.env.CODEX_RESET_SCAN_MINUTES;
  try {
    delete process.env.CODEX_RESET_SCAN_MINUTES;
    assert.equal(scanMinutes(), 15);
    assert.equal(scanCron(), "*/15 * * * *");
    const now = Date.now();
    const first = await codexResetVersion(now);
    for (const minutes of [10, 15, 30, 60]) {
      process.env.CODEX_RESET_SCAN_MINUTES = String(minutes);
      assert.equal(scanCron(), `${minutes === 60 ? "0" : `*/${minutes}`} * * * *`);
      const page = await codexResetPage(now);
      assert.equal(page.scanMinutes, minutes);
      assert.equal(page.version, (await codexResetVersion(now)).version);
      if (minutes !== 15) assert.notEqual(page.version, first.version);
    }
    for (const value of ["0", "-1", "7", "16", "61", "1.5", "invalid"]) {
      process.env.CODEX_RESET_SCAN_MINUTES = value;
      assert.throws(scanCron, /positive divisor of 60/);
    }
    assert.equal(calls.length, 0);
  } finally {
    if (original === undefined) delete process.env.CODEX_RESET_SCAN_MINUTES;
    else process.env.CODEX_RESET_SCAN_MINUTES = original;
  }
});

test("TwitterAPI.io maps quoted posts, replies and links without losing source context", () => {
  const t = normalizeTweet({ ...post("101"), inReplyToId: "100", inReplyToUsername: "thsottiaux", quoted_tweet: post("99"), likeCount: 3 });
  assert.equal(t.in_reply_to_status_id_str, "100");
  assert.equal(t.quoted_status?.id_str, "99");
  assert.equal(t.favorite_count, 3);
  assert.equal(tweetText(t), "Reset & see https://example.com/reset");
  assert.throws(() => normalizeTweet({ ...post("101"), createdAt: "invalid" }));
  assert.equal(normalizeTweet({ ...post("101"), quoted_tweet: { id: "99", text: "", createdAt: "", author: {} } }).quoted_status, null);
  assert.throws(() => normalizeTweet({ ...post("101"), quoted_tweet: { ...post("99"), createdAt: "invalid" } }));
});

test("request budgets and safety valves stop requests before external calls", async () => {
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('twitterapi_io', 0, 0, 0)`;
  await assert.rejects(searchTweets("from:thsottiaux", { purpose: "monitor.scan", subject: "x:thsottiaux", window: "stopped" }), /Budget for twitterapi_io exhausted/);
  process.env.COLLECT_ENABLED = "false";
  assert.deepEqual(await collectPosts(), { stored: 0, pages: 0 });
  config.modelCallsEnabled = false;
  assert.deepEqual(await processPending(), { processed: 0, failed: 0 });
  assert.equal(calls.length, 0);
});

test("an upstream refusal cannot put the API key in errors or receipt logs", async () => {
  answer = () => new Reply(401, { message: "Invalid key: test-key" });
  await assert.rejects(searchTweets("from:thsottiaux", { purpose: "monitor.scan", subject: "x:thsottiaux", window: "refused" }), error => {
    assert.ok(String(error).includes("[redacted]"));
    assert.ok(!String(error).includes("test-key"));
    return true;
  });
  const [receipt] = await sql`SELECT error FROM receipts WHERE service = 'twitterapi_io'`;
  assert.ok(!receipt!.error.includes("test-key"));
});

test("page two failure preserves page one and the last full-success time", async () => {
  const checkpoint = { checkpointVersion: 2, scannedThrough: "2026-10-08T00:00:00.000Z" };
  await sql`INSERT INTO monitor_state (key, value) VALUES ('cursor:twitterapi_io', ${sql.json(checkpoint)})`;
  answer = url => url.searchParams.has("cursor") ? new Reply(402, { message: "Credits is not enough" })
    : { tweets: [post("400")], has_next_page: true, next_cursor: "tail" };
  await assert.rejects(collectPosts(), /HTTP 402/);
  assert.deepEqual((await sql`SELECT id FROM monitor_posts`).map(p => p.id), ["400"]);
  assert.deepEqual((await sql`SELECT value FROM monitor_state WHERE key='cursor:twitterapi_io'`)[0]!.value, checkpoint);
  const firstQuery = calls[0]!.searchParams.get("query");
  answer = () => ({ tweets: [post("400")], has_next_page: false });
  assert.equal((await collectPosts()).stored, 0);
  assert.equal(calls.at(-1)!.searchParams.get("cursor"), null, "new round starts its window from the first page");
  assert.equal(calls.at(-1)!.searchParams.get("query")!.split(" until_time:")[0], firstQuery!.split(" until_time:")[0]);
  assert.equal((await sql`SELECT count(*)::int n FROM receipts WHERE purpose='monitor.scan'`)[0]!.n, 3);
});
