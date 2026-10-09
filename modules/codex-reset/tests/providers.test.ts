import { Reply, stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { collectPosts, collectPendingContext, processPending } from "../backend/scan.ts";
import { paidRequest, ReceiptUnknownError, ProviderRejectedError, BudgetExceededError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";
import { searchTweets, getTweet, tweetText } from "../backend/providers/collectors.ts";
import { normalizeTweet } from "../backend/providers/twitterapi.ts";
import { scanCron, scanMinutes } from "../config.ts";
import { codexResetPage, codexResetVersion } from "../backend/read.ts";

const calls: URL[] = [];
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

test("TwitterAPI.io pagination and lookups use receipts; replay does not repurchase", async () => {
  answer = url => url.pathname.endsWith("advanced_search")
    ? { tweets: [post("101")], has_next_page: true, next_cursor: "next-page" }
    : { tweets: [post("100")] };
  const opts = { purpose: "monitor.scan", subject: "x:thsottiaux", window: "test-window", cursor: "first-page" };
  const first = await searchTweets("from:thsottiaux", opts);
  assert.equal(first.nextCursor, "next-page");
  assert.equal(calls[0]!.searchParams.get("queryType"), "Latest");
  assert.equal(calls[0]!.searchParams.get("cursor"), "first-page");
  assert.equal((await searchTweets("from:thsottiaux", opts)).reused, true);
  assert.equal(calls.length, 1);
  assert.equal((await getTweet("100", { purpose: "monitor.context", subject: "x:101" }))?.id_str, "100");
  assert.equal(calls[1]!.searchParams.get("tweet_ids"), "100");
  const [receipt] = await sql`SELECT service, response FROM receipts WHERE id = ${first.receiptId}`;
  assert.equal(receipt!.service, "twitterapi_io");
  assert.equal(receipt!.response.tweets[0].id, "101");
});

test("provider switching keeps independent cursors and deduplicates shared posts", async () => {
  answer = url => url.pathname.endsWith("/search") ? { tweets: [normalizeTweet(post("101"))], next_cursor: null }
    : { tweets: [post("101")], has_next_page: false };
  await collectPosts({ initialRange: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T02:00:00Z" } });
  process.env.CODEX_RESET_PROVIDER = "socialdata";
  await collectPosts({ initialRange: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T02:00:00Z" } });
  const cursors = await sql`SELECT key FROM monitor_state WHERE key LIKE 'cursor:%' ORDER BY key`;
  assert.equal(cursors.length, 0, "collection alone does not claim full-round success");
  assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_posts`)[0]!.n, 1);
  assert.ok(calls.every(u => !u.searchParams.has("cursor")));
  process.env.CODEX_RESET_PROVIDER = "unknown";
  await assert.rejects(collectPosts({ initialRange: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T02:00:00Z" } }), /Unknown CODEX_RESET_PROVIDER/);
});

test("malformed paid answers fail each round without advancing coverage", async () => {
  answer = () => ({ tweets: [post("101")], has_next_page: true });
  await assert.rejects(collectPosts({ initialRange: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T02:00:00Z" } }), /next cursor/);
  await assert.rejects(collectPosts({ initialRange: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T02:00:00Z" } }), /next cursor/);
  assert.equal(calls.length, 2);
  assert.ok((await sql`SELECT status FROM receipts WHERE purpose='monitor.scan'`).every(r => r.status === "failed"));
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key LIKE 'cursor:%'`).length, 0);
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

test("initial collection finishes all pages in one fixed window without cross-round cursors", async () => {
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('twitterapi_io', 1000, 10000, 100000)`;
  const range = { since: "2026-07-07T16:00:00Z", until: "2026-10-08T02:00:00Z" };
  answer = url => {
    const page = Number(url.searchParams.get("cursor") ?? 0);
    return { tweets: [post(String(200 - page))], has_next_page: page < 17, next_cursor: String(page + 1) };
  };
  assert.equal((await collectPosts({ initialRange: range })).pages, 18);
  assert.deepEqual(calls.map(u => u.searchParams.get("cursor")), [null, ...Array.from({ length: 17 }, (_, i) => String(i + 1))]);
  assert.ok(calls.every(u => u.searchParams.get("query") === `from:thsottiaux since_time:${Date.parse(range.since) / 1000} until_time:${Date.parse(range.until) / 1000}`));
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key LIKE 'cursor:%'`).length, 0);
});

test("context funding failures pause the task without putting individual posts in manual review", async () => {
  answer = url => url.pathname.endsWith("advanced_search")
    ? { tweets: ["101", "102"].map(id => ({ ...post(id), inReplyToId: "100" })), has_next_page: false }
    : new Reply(402, { message: "Insufficient balance" });
  await collectPosts({ initialRange: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T02:00:00Z" } });
  await assert.rejects(collectPendingContext(), error => error instanceof ProviderRejectedError && error.status === 402);
  assert.equal(calls.filter(u => u.pathname.endsWith("/tweets")).length, 1);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key LIKE 'context:%'`).length, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM monitor_posts WHERE raw->>'contextPending'='true'`)[0]!.n, 2);
  await sql`UPDATE receipts SET updated_at=now()-interval '1 minute' WHERE purpose='monitor.context'`;
  // Funding refusals also stop the task when the supplementary request reaches the attempt limit.
  await assert.rejects(collectPendingContext(), error => error instanceof ProviderRejectedError && error.status === 402);
  assert.equal(calls.filter(u => u.pathname.endsWith("/tweets")).length, 2);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key LIKE 'context:%'`).length, 0);
});

test("invalid initial intervals never call the provider", async () => {
  await assert.rejects(collectPosts({ initialRange: { since: "invalid", until: "2026-10-08T02:00:00Z" } }), /valid past interval/);
  await assert.rejects(collectPosts({ initialRange: { since: "2026-10-08T02:00:00Z", until: "2026-07-07T16:00:00Z" } }), /valid past interval/);
  assert.equal(calls.length, 0);
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

test("configured request spacing applies to paid calls while replay stays local", async () => {
  process.env.TWITTERAPI_IO_REQUEST_INTERVAL_MS = "40";
  const times: number[] = [];
  answer = url => { times.push(Date.now()); return { tweets: [post(url.searchParams.get("tweet_ids")!)] }; };
  try {
    await getTweet("1001", { purpose: "monitor.context", subject: "spacing" });
    await getTweet("1002", { purpose: "monitor.context", subject: "spacing" });
    await getTweet("1002", { purpose: "monitor.context", subject: "spacing" });
    assert.equal(times.length, 2);
    assert.ok(times[1]! - times[0]! >= 40);
  } finally {
    delete process.env.TWITTERAPI_IO_REQUEST_INTERVAL_MS;
  }
});

test("context failure stops immediately and a later normal round uses new request keys", async () => {
  answer = url => url.pathname.endsWith("advanced_search")
    ? { tweets: ["101", "102"].map(id => ({ ...post(id), inReplyToId: "100" })), has_next_page: false }
    : new Reply(503, { message: "temporary failure" });
  await collectPosts({ initialRange: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T02:00:00Z" } });
  for (let round = 0; round < 3; round++) await assert.rejects(collectPendingContext(), /HTTP 503/);
  const lookups = () => calls.filter(u => u.pathname.endsWith("/tweets"));
  assert.equal(lookups().length, 3, "one request per failed round, without retry or attempt limit");
  assert.equal((await autoReleaseUnknownReceipts(Date.now() + 3600_000)).released, 0);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE key LIKE 'context:%'`).length, 0);
  assert.ok((await sql`SELECT attempts FROM receipts WHERE purpose='monitor.context'`).every(r => r.attempts === 1));
  answer = () => ({ tweets: [post("100")] });
  assert.equal((await collectPendingContext()).completed, 2);
  assert.equal(lookups().length, 4, "shared parent is reused within the successful round");
  assert.equal((await collectPendingContext()).completed, 0);
});

test("switching context providers completes pending posts without manual release", async () => {
  answer = url => url.pathname.endsWith("advanced_search")
    ? { tweets: [{ ...post("101"), inReplyToId: "100" }], has_next_page: false }
    : new Reply(503, { message: "temporary failure" });
  await collectPosts({ initialRange: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T02:00:00Z" } });
  await assert.rejects(collectPendingContext(), /HTTP 503/);
  process.env.CODEX_RESET_PROVIDER = "socialdata";
  answer = () => normalizeTweet(post("100"));
  assert.equal((await collectPendingContext()).completed, 1);
  const receipts = await sql`SELECT service, attempts FROM receipts WHERE purpose='monitor.context' ORDER BY service`;
  assert.deepEqual(receipts.map(r => [r.service, r.attempts]), [["socialdata", 1], ["twitterapi_io", 1]]);
});

test("budget exhaustion aborts context without reserving a paid attempt", async () => {
  answer = url => url.pathname.endsWith("advanced_search")
    ? { tweets: [{ ...post("101"), inReplyToId: "100" }], has_next_page: false } : { tweets: [post("100")] };
  await collectPosts({ initialRange: { since: "2026-10-01T00:00:00Z", until: "2026-10-08T02:00:00Z" } });
  await sql`UPDATE budgets SET per_minute=0 WHERE service='twitterapi_io'`;
  await assert.rejects(collectPendingContext(), BudgetExceededError);
  assert.equal((await sql`SELECT id FROM receipts WHERE purpose='monitor.context'`).length, 0);
  await sql`UPDATE budgets SET per_minute=10 WHERE service='twitterapi_io'`;
  assert.equal((await collectPendingContext()).completed, 1);
});

test("SocialData custom base URLs use the configured egress proxy instead of local DNS", async () => {
  const originalBase = process.env.SOCIALDATA_BASE_URL;
  const originalProxy = config.egressProxyUrl;
  let proxyHits = 0;
  const proxy = createServer();
  proxy.on("connect", (_req, socket) => {
    proxyHits++;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  process.env.CODEX_RESET_PROVIDER = "socialdata";
  process.env.SOCIALDATA_BASE_URL = "https://socialdata.invalid";
  config.egressProxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    await assert.rejects(getTweet("100", { purpose: "monitor.context", subject: "proxy-routing-test" }), ReceiptUnknownError);
    assert.ok(proxyHits > 0, "the DNS request reaches only the local fake proxy");
  } finally {
    config.egressProxyUrl = originalProxy;
    if (originalBase === undefined) delete process.env.SOCIALDATA_BASE_URL;
    else process.env.SOCIALDATA_BASE_URL = originalBase;
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
