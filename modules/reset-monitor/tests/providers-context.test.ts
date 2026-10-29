import { stub, Reply } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { lookupTweets, searchTweets } from "../backend/providers/collectors.ts";

const at = "2026-10-28T02:43:38Z";
const socialPost = (id: string) => ({ id_str: id, full_text: "Quota update", tweet_created_at: at,
  user: { name: "Official", screen_name: "Official" } });
const twitterPost = (id: string) => ({ id, text: "Quota update", createdAt: at,
  author: { name: "Official", userName: "Official" } });
const requests: URL[] = [];
let answer: (url: URL) => unknown;
const provider = await stub((_hit, req) => {
  const url = new URL(req.url, "http://localhost"); requests.push(url);
  return answer(url);
});
Object.assign(process.env, { SOCIALDATA_BASE_URL: provider.url, SOCIALDATA_API_KEY: "synthetic",
  TWITTERAPI_IO_BASE_URL: provider.url, TWITTERAPI_IO_API_KEY: "synthetic" });
config.allowPrivateNetworkFetch = true;
const lookup = async (ids: string[]) => inMonitor(codex, () => lookupTweets(ids, { purpose: "monitor.context", subject: "x:official" }));

beforeEach(async () => {
  await sql`DELETE FROM receipts`;
  await sql`DELETE FROM budgets`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('socialdata',1000,1000,1000),('twitterapi_io',1000,1000,1000)`;
  requests.length = 0;
  process.env.COLLECT_ENABLED = "true";
  process.env.CODEX_RESET_PROVIDER = "twitterapi_io";
});
after(async () => { await provider.close(); await closeDb(); });

test("TwitterAPI lookup matches IDs, retains nested reply relations and reuses paid responses", async () => {
  answer = () => ({ status: "success", code: 0, tweets: [twitterPost("3"), { id: "" },
    { ...twitterPost("1"), quoted_tweet: { ...twitterPost("90"), isReply: true, inReplyToId: "80", inReplyToUsername: null } }] });
  const result = await lookup(["3", "1", "2", "1"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.pathname, "/twitter/tweets");
  assert.equal(requests[0]!.searchParams.get("tweet_ids"), "1,2,3");
  assert.deepEqual(result.tweets.map(post => post.id_str), ["1", "3"]);
  assert.deepEqual(result.missingIds, ["2"]);
  assert.equal(result.tweets[0]!.quoted_status!.in_reply_to_status_id_str, "80");
  assert.equal(result.tweets[0]!.quoted_status!.in_reply_to_screen_name, null);
  assert.ok(result.receiptIds.every(id => Object.values(result.receiptById).includes(id)));
  assert.equal(result.reused, false);
  const again = await lookup(["2", "1", "3"]);
  assert.equal(requests.length, 1);
  assert.equal(again.reused, true);
  assert.deepEqual(again.receiptIds, result.receiptIds);
  for (const id of result.receiptIds) await completeReceipt(sql, id);
  const completed = await lookup(["3", "2", "1"]);
  assert.equal(completed.reused, true);
  assert.equal(requests.length, 1);
});

test("TwitterAPI lookup splits 51 unique IDs into stable batches of at most 50", async () => {
  const ids = Array.from({ length: 51 }, (_, index) => String(index + 1));
  answer = url => ({ status: "success", tweets: url.searchParams.get("tweet_ids")!.split(",").reverse().map(twitterPost) });
  const result = await lookup([...ids].reverse());
  assert.deepEqual(requests.map(url => url.searchParams.get("tweet_ids")!.split(",").length), [50, 1]);
  assert.equal(result.tweets.length, 51);
  assert.equal(result.receiptIds.length, 2);
  assert.deepEqual(Object.keys(result.receiptById).sort(), [...ids].sort());
  assert.deepEqual(result.missingIds, []);
  const again = await lookup(ids);
  assert.equal(again.reused, true);
  assert.equal(requests.length, 2);
});

test("TwitterAPI error envelopes are failures rather than absent parents, and are not repurchased", async () => {
  answer = () => ({ status: "error", code: 500, msg: "Synthetic upstream failure", tweets: [] });
  await assert.rejects(lookup(["1"]), /unsuccessful/);
  const [row] = await sql`SELECT status,attempts FROM receipts`;
  assert.equal(row.status, "failed"); assert.equal(row.attempts, 1);
  await assert.rejects(lookup(["1"]));
  assert.equal(requests.length, 1);
});

test("TwitterAPI rejects a returned post that was not requested", async () => {
  answer = () => ({ status: "success", tweets: [twitterPost("99")] });
  await assert.rejects(lookup(["1"]), /unrequested/);
  assert.equal((await sql`SELECT status FROM receipts`)[0].status, "failed");
});

test("a received null TwitterAPI response is retained and schema-rejected rather than marked billing-unknown", async () => {
  answer = () => null;
  await assert.rejects(lookup(["1"]));
  const [receipt] = await sql`SELECT status,response FROM receipts`;
  const [attempt] = await sql`SELECT status FROM receipt_attempts`;
  assert.equal(receipt.status, "failed"); assert.equal(receipt.response, null);
  assert.equal(attempt.status, "received");
  await assert.rejects(lookup(["1"]));
  assert.equal(requests.length, 1);
});

test("search summaries retain the pagination cursor", async () => {
  answer = () => ({ tweets: [], has_next_page: false });
  await inMonitor(codex, () => searchTweets("from:official", { purpose: "monitor.scan", subject: "x:official", window: "window", cursor: "next-page" }));
  assert.equal(requests[0]!.searchParams.get("cursor"), "next-page");
  assert.equal((await sql`SELECT request FROM receipts`)[0].request.cursor, "next-page");
  process.env.CODEX_RESET_PROVIDER = "socialdata";
  answer = () => ({ tweets: [], next_cursor: null });
  await inMonitor(codex, () => searchTweets("from:official", { purpose: "monitor.scan", subject: "x:official", window: "window", cursor: "social-next" }));
  const [receipt] = await sql`SELECT request FROM receipts WHERE service='socialdata'`;
  assert.equal(receipt.request.cursor, "social-next");
});

test("SocialData 404 is recorded as missing, while successful parents and replies are retained", async () => {
  process.env.CODEX_RESET_PROVIDER = "socialdata";
  answer = url => url.pathname.endsWith("/2") ? new Reply(404, { message: "Tweet not found" })
    : { ...socialPost("1"), is_reply: true, in_reply_to_status_id_str: "80", in_reply_to_screen_name: null };
  const result = await lookup(["2", "1", "1"]);
  assert.deepEqual(requests.map(url => url.pathname), ["/twitter/tweets/1", "/twitter/tweets/2"]);
  assert.deepEqual(result.tweets.map(post => post.id_str), ["1"]);
  assert.equal(result.tweets[0]!.in_reply_to_status_id_str, "80");
  assert.deepEqual(result.missingIds, ["2"]);
  assert.equal(result.receiptIds.length, 2);
  assert.equal(result.receiptById["1"], result.receiptIds[0]);
  assert.equal(result.receiptById["2"], result.receiptIds[1]);
  assert.equal((await lookup(["1", "2"])).reused, true);
  assert.equal(requests.length, 2);
});

test("SocialData HTTP failure is not converted to missing or retried automatically", async () => {
  process.env.CODEX_RESET_PROVIDER = "socialdata";
  answer = () => new Reply(503, { message: "Synthetic failure" });
  await assert.rejects(lookup(["1"]), /503/);
  await assert.rejects(lookup(["1"]));
  assert.equal(requests.length, 1);
});

test("SocialData validates a lookup response against its requested ID", async () => {
  process.env.CODEX_RESET_PROVIDER = "socialdata";
  answer = () => socialPost("99");
  await assert.rejects(lookup(["1"]), /different context post ID/);
  assert.equal((await sql`SELECT status FROM receipts`)[0].status, "failed");
});

test("context lookups obey collection valve, budget and input validation", async () => {
  for (const providerName of ["socialdata", "twitterapi_io"]) {
    process.env.CODEX_RESET_PROVIDER = providerName;
    process.env.COLLECT_ENABLED = "false";
    await assert.rejects(lookup(["1"]), /COLLECT_ENABLED/);
    process.env.COLLECT_ENABLED = "true";
    await assert.rejects(lookup(["not-an-id"]), /Invalid context post ID/);
    await sql`UPDATE budgets SET per_day=0 WHERE service=${providerName}`;
    await assert.rejects(lookup(["1"]), /Budget/);
    assert.equal(requests.length, 0);
  }
});

for (const providerName of ["socialdata", "twitterapi_io"] as const) {
  const search = (resume = false) => inMonitor(codex, () => searchTweets("from:official", {
    purpose: "monitor.scan", subject: "x:official", window: "persisted-window", resume,
  }));
  const emptyPage = () => ({ tweets: [], next_cursor: null, has_next_page: false });

  test(`${providerName}: a later resumed search can continue a definite refusal without rebuying completed pages`, async () => {
    process.env.CODEX_RESET_PROVIDER = providerName;
    answer = () => new Reply(429, { error: "Synthetic definite refusal" });
    await assert.rejects(search(), /429/);
    answer = emptyPage;
    await assert.rejects(search(), /failed/);
    assert.equal(requests.length, 1, "the same round does not retry its failed request");
    const resumed = await search(true);
    assert.equal(requests.length, 2);
    assert.equal(resumed.reused, false);
    await completeReceipt(sql, resumed.receiptId);
    assert.equal((await search(true)).reused, true);
    assert.equal(requests.length, 2);
    const [receipt] = await sql`SELECT status,attempts FROM receipts`;
    assert.equal(receipt.status, "completed"); assert.equal(receipt.attempts, 2);
  });

  test(`${providerName}: resuming never buys another response after a paid schema rejection`, async () => {
    process.env.CODEX_RESET_PROVIDER = providerName;
    answer = () => ({ tweets: [{ malformed: true }], next_cursor: null, has_next_page: false });
    await assert.rejects(search());
    assert.equal((await sql`SELECT status FROM receipt_attempts`)[0].status, "received");
    answer = emptyPage;
    await assert.rejects(search(true));
    assert.equal(requests.length, 1);
    assert.equal((await sql`SELECT attempts FROM receipts`)[0].attempts, 1);
  });

  test(`${providerName}: resuming never rebills an unknown attempt or an earlier unknown attempt`, async () => {
    process.env.CODEX_RESET_PROVIDER = providerName;
    answer = () => new Reply(429, { error: "Synthetic refusal used to seed persisted billing states" });
    await assert.rejects(search());
    const [receipt] = await sql`SELECT id FROM receipts`;
    await sql`UPDATE receipt_attempts SET status='unknown' WHERE receipt_id=${receipt.id}`;
    answer = emptyPage;
    await assert.rejects(search(true));
    assert.equal(requests.length, 1);
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status) VALUES(${receipt.id},2,${providerName},'failed')`;
    await sql`UPDATE receipts SET attempts=2,status='failed' WHERE id=${receipt.id}`;
    await assert.rejects(search(true));
    assert.equal(requests.length, 1, "central receipt claiming still refuses a previous unknown billing outcome");
  });
}
