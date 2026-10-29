import { stub, Reply } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { inMonitor, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { collectPosts, monitorTick } from "../backend/scan.ts";
import { cursorKey } from "../config.ts";
import { loadActionInput } from "../backend/action-store.ts";
import type { Tweet } from "../backend/providers/collectors.ts";

const started = new Date("2026-10-26T12:00:00Z"), since = "2026-10-26T10:00:00.000Z", published = "2026-10-26T11:00:00Z";
const author = "Official";
const local = (text: string) => ({ en: text, zh: text, "zh-Hant": text, ja: text, ko: text, ru: text, es: text });
const post = (id: string, text = "We reset usage", patch: Partial<Tweet> = {}): Tweet => ({ id_str: id, full_text: text, tweet_created_at: published, user: { name: author, screen_name: author }, ...patch });
const fixtures = [
  post("101"), post("102", "A product launch"),
  post("103", "We reset usage", { is_reply: true, in_reply_to_status_id_str: "90", in_reply_to_screen_name: author }),
  post("104", "A credit is coming", { is_reply: true, in_reply_to_status_id_str: "91", in_reply_to_screen_name: "Other" }),
  post("105", "Please reset usage", { is_reply: true, in_reply_to_status_id_str: "101", in_reply_to_screen_name: author, user: { name: "Reader", screen_name: "Reader" } }),
  post("106", "We reset usage", { is_retweet: true }),
  post("107", "We reset usage", { quoted_status: post("80", "Question", { is_reply: true, in_reply_to_status_id_str: "79", user: { name: "Quoted", screen_name: "Quoted" } }) }),
  post("108", "A credit is coming", { is_reply: true }),
  post("109", "We are resetting usage"),
  post("110", "A product launch", { quoted_status: post("81", "Context", { user: { name: "Quoted", screen_name: "Quoted" } }) }),
  post("111", "今天重置额度"), post("112", "Extra credits"),
  post("113", "We reset usage", { tweet_created_at: "2026-10-26T09:59:59Z" }),
  post("114", "We reset usage", { tweet_created_at: "2026-10-26T12:00:01Z" }),
];
let pages: Tweet[][] = [], refusePage: number | null = null;
const queries: URL[] = [];
let bypassServerFilters = false;
const searchQueries = () => queries.filter(url => url.pathname === "/twitter/search" || url.pathname.includes("advanced_search"));
function twitterTweet(tweet: Tweet): unknown {
  return { id: tweet.id_str, text: tweet.full_text, createdAt: tweet.tweet_created_at,
    author: { name: tweet.user.name, userName: tweet.user.screen_name }, isReply: tweet.is_reply, isRetweet: tweet.is_retweet,
    inReplyToId: tweet.in_reply_to_status_id_str, inReplyToUsername: tweet.in_reply_to_screen_name,
    quoted_tweet: tweet.quoted_status ? twitterTweet(tweet.quoted_status) : undefined };
}
// The fake supplier applies its query contract. Local collection must not repeat reply-type filtering.
function serverMatches(tweet: Tweet, query: string): boolean {
  const handle = /from:(\w+)/.exec(query)?.[1];
  if (tweet.user.screen_name.toLowerCase() !== handle || tweet.is_retweet) return false;
  const at = Date.parse(tweet.tweet_created_at) / 1000;
  if (at < Number(/since_time:(\d+)/.exec(query)?.[1]) || at >= Number(/until_time:(\d+)/.exec(query)?.[1])) return false;
  if (tweet.is_reply) {
    const self = tweet.id_str === "108" || tweet.in_reply_to_screen_name?.toLowerCase() === handle;
    if (query.includes("OR to:") && !self || query.includes("OR -to:") && self) return false;
    if (query.includes("-filter:replies") && !query.includes("(-filter:replies OR")) return false;
  }
  if (query.includes('"reset"') && !/\b(?:reset|credit)\b|重置/i.test(tweet.full_text ?? "")) return false;
  return true;
}
const collector = await stub((_hit, request) => {
  const url = new URL(request.url, "http://localhost"); queries.push(url);
  if (url.pathname === "/twitter/tweets") return { status: "success", tweets: [] };
  if (url.pathname.startsWith("/twitter/tweets/")) return new Reply(404, { message: "Synthetic missing parent" });
  const index = Number(url.searchParams.get("cursor") ?? 0);
  if (refusePage === index) return new Reply(429, { error: "Synthetic refusal" });
  const tweets = (pages[index] ?? []).filter(tweet => bypassServerFilters || serverMatches(tweet, url.searchParams.get("query")!));
  const next = index + 1 < pages.length ? String(index + 1) : null;
  if (url.pathname.includes("advanced_search")) return { tweets: tweets.map(twitterTweet), has_next_page: next !== null, next_cursor: next };
  return { tweets, next_cursor: next };
});
let modelCalls = 0;
const model = await stub((_hit, request) => {
  modelCalls++;
  const input = JSON.parse(JSON.parse(request.body).messages[1].content);
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ posts: input.targets.map((post: {id:string}) => ({ postId: post.id, relevant: false, needsReview: false, reviewReason: null, title: local("Unrelated post"), summary: null, actions: [] })) }) } }] };
});
Object.assign(process.env, { SOCIALDATA_BASE_URL: collector.url, SOCIALDATA_API_KEY: "synthetic", TWITTERAPI_IO_BASE_URL: collector.url, TWITTERAPI_IO_API_KEY: "synthetic",
  MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "synthetic", LLM_MODEL: "synthetic-collection" });
config.allowPrivateNetworkFetch = true;
installModules([createMonitorServer(codex)]);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM receipts`; await sql`DELETE FROM budgets`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('socialdata',1000,1000,1000)`;
  pages = [fixtures]; queries.length = 0; refusePage = null; modelCalls = 0; bypassServerFilters = false;
  process.env.COLLECT_ENABLED = "true"; config.modelCallsEnabled = true;
});
after(async () => { await collector.close(); await model.close(); installModules([]); await closeDb(); });

function definition(provider: "socialdata" | "twitterapi_io", includeReplies = false, includeSelfReplies = false, resetOnly = false, base = codex): ResetMonitorBackendDefinition {
  process.env[base.providerEnv] = provider;
  return { ...base, authors: [{ handle: author, name: author }], collection: { includeReplies, includeSelfReplies, resetOnly, keywords: ["reset", "credit", "重置"] } };
}
async function checkpoint(value = since) {
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex',${cursorKey()},${sql.json({ checkpointVersion: 2, scannedThrough: value })})`;
}
const savedIds = async () => (await loadActionInput()).posts.filter(row => !row.context_only).map(row => row.id).sort();

for (const provider of ["socialdata", "twitterapi_io"] as const) {
  for (const includeReplies of [false, true]) for (const includeSelfReplies of [false, true]) for (const resetOnly of [false, true]) test(`${provider}: independent reply=${includeReplies}, selfReply=${includeSelfReplies} and resetOnly=${resetOnly} policies`, async () => inMonitor(definition(provider, includeReplies, includeSelfReplies, resetOnly), async () => {
    await checkpoint();
    const result = await collectPosts({ startedAt: started, roundId: `matrix-${provider}-${includeReplies}-${includeSelfReplies}-${resetOnly}` });
    const expected = resetOnly ? ["101", "107", "111"] : ["101", "102", "107", "109", "110", "111", "112"];
    if (includeSelfReplies) expected.push("103", "108");
    if (includeReplies) expected.push("104");
    assert.deepEqual(await savedIds(), expected.sort());
    assert.equal(result.stored, expected.length); assert.equal(result.pages, 1); assert.equal(modelCalls, 0);
    const query = searchQueries()[0]!.searchParams.get("query")!;
    assert.equal(query.includes("-filter:replies"), !includeReplies || !includeSelfReplies);
    assert.equal(query.includes("OR to:official"), includeSelfReplies && !includeReplies);
    assert.equal(query.includes("OR -to:official"), includeReplies && !includeSelfReplies);
    assert.match(query, /from:official .*since_time:1793008800 until_time:1793016000/);
    assert.equal(query.includes('("reset" OR "credit" OR "重置")'), resetOnly);
    const input = await loadActionInput();
    assert.equal(input.posts.find(row => row.id === "101")!.reply_to, null);
    assert.equal(input.posts.find(row => row.id === "107")!.quoted_post!.id, "80");
    if (includeSelfReplies) {
      assert.deepEqual(input.posts.find(row => row.id === "103")!.reply_to, { postId: "90", author });
    }
    if (includeReplies) {
      assert.deepEqual(input.posts.find(row => row.id === "104")!.reply_to, { postId: "91", author: "Other" });
    }
    if (includeSelfReplies) {
      assert.deepEqual(input.posts.find(row => row.id === "108")!.reply_to, { postId: null, author: null });
    }
    assert.ok(input.posts.every(row => !row.filtered_out));
  }));

  test(`${provider}: returned replies and keyword mismatches are not locally discarded`, async () => inMonitor(definition(provider, false, true, true), async () => {
    await checkpoint(); bypassServerFilters = true;
    pages = [[post("108", "A product launch", { is_reply: true })]];
    const result = await collectPosts({ startedAt: started, roundId: `trust-provider-${provider}` });
    assert.deepEqual(await savedIds(), ["108"]);
    assert.equal(result.stored, 1);
    assert.deepEqual((await loadActionInput()).posts.find(row => row.id === "108")!.reply_to, { postId: null, author: null });
  }));

  test(`${provider}: a source outside the requested author or window is an explicit collection failure`, async () => inMonitor(definition(provider), async () => {
    await checkpoint(); bypassServerFilters = true;
    pages = [[post("105", "Quota update", { user: { name: "Reader", screen_name: "Reader" } })]];
    await assert.rejects(collectPosts({ startedAt: started, roundId: `wrong-author-${provider}` }), /outside the requested author or window/);
    pages = [[post("114", "Quota update", { tweet_created_at: "2026-10-26T12:00:01Z" })]];
    await assert.rejects(collectPosts({ startedAt: started, roundId: `wrong-window-${provider}` }), /outside the requested author or window/);
    assert.deepEqual(await savedIds(), []);
    const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${cursorKey()}`;
    assert.equal(cursor.value.scannedThrough, since);
  }));

  test(`${provider}: pagination retains the same scoped query and a refused page cannot advance a checkpoint`, async () => inMonitor(definition(provider, true, true, true), async () => {
    pages = [[post("101")], [post("115", "A credit arrives")]];
    await checkpoint(); refusePage = 1;
    await assert.rejects(collectPosts({ startedAt: started, roundId: `page-failure-${provider}` }), /429/);
    const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${cursorKey()}`;
    assert.equal(cursor!.value.scannedThrough, since);
    assert.deepEqual(await savedIds(), ["101"]);
    refusePage = null;
    const result = await collectPosts({ startedAt: started, roundId: `page-success-${provider}` });
    assert.deepEqual(await savedIds(), ["101", "115"]); assert.equal(result.pages, 2); assert.equal(result.stored, 1);
    assert.equal(searchQueries()[0]!.searchParams.get("query"), searchQueries()[1]!.searchParams.get("query"));
    assert.equal(searchQueries()[2]!.searchParams.get("query"), searchQueries()[3]!.searchParams.get("query"));
    assert.equal(searchQueries()[3]!.searchParams.get("cursor"), "1");
  }));

  test(`${provider}: persistence recovery reuses the received paid response`, async () => inMonitor(definition(provider), async () => {
    pages = [[post("101")]]; await checkpoint();
    await sql`ALTER TABLE monitor_source_posts ADD CONSTRAINT collection_test_refusal CHECK(id<>'101') NOT VALID`;
    try { await assert.rejects(collectPosts({ startedAt: started, roundId: `recover-${provider}` }), /collection_test_refusal/); }
    finally { await sql`ALTER TABLE monitor_source_posts DROP CONSTRAINT collection_test_refusal`; }
    assert.equal(searchQueries().length, 1); assert.deepEqual(await savedIds(), []);
    const [received] = await sql`SELECT status FROM receipts WHERE service=${provider}`;
    assert.equal(received!.status, "received");
    const result = await collectPosts({ startedAt: started, roundId: `recover-${provider}` });
    assert.equal(result.stored, 1); assert.equal(queries.length, 1);
    const [completed] = await sql`SELECT status FROM receipts WHERE service=${provider}`;
    assert.equal(completed!.status, "completed");
  }));

  test(`${provider}: configuration changes keep the successful cutoff and preserve collected records`, async () => {
    const initial = definition(provider);
    await inMonitor(initial, async () => { await checkpoint(); await collectPosts({ startedAt: started, roundId: `initial-${provider}` }); });
    const changed = { ...initial, collection: { ...initial.collection, includeSelfReplies: true, resetOnly: true } };
    await inMonitor(changed, async () => {
      const before = await savedIds();
      await collectPosts({ startedAt: started, roundId: `changed-${provider}` });
      assert.ok((await savedIds()).includes("103"));
      assert.ok(before.every(id => (id !== "103" && id !== "104" && id !== "108")));
      const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${cursorKey()}`;
      assert.deepEqual(cursor!.value, { checkpointVersion: 2, scannedThrough: since });
      assert.equal(searchQueries()[0]!.searchParams.get("query")!.match(/since_time:\d+/)![0], searchQueries()[1]!.searchParams.get("query")!.match(/since_time:\d+/)![0]);
      assert.ok((await savedIds()).includes("102"), "previously collected unrelated post is not deleted or retroactively filtered");
    });
  });

  for (const outcome of ["empty", "keyword-excluded", "model-filtered"] as const) test(`${provider}: ${outcome} rounds complete their incremental window`, async () => inMonitor(definition(provider, true, true, true), async () => {
    const before = new Date(Date.now() - 2 * 3600_000).toISOString();
    pages = outcome === "empty" ? [[]] : [[post("101", outcome === "keyword-excluded" ? "A product launch" : "A credit unrelated to quota", { tweet_created_at: new Date(Date.now() - 3600_000).toISOString() })]];
    await checkpoint(before);
    const result = await monitorTick();
    assert.equal("verifiedAt" in result, true);
    const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${cursorKey()}`;
    assert.ok(Date.parse(cursor!.value.scannedThrough) > Date.parse(before));
    const input = await loadActionInput();
    assert.equal(input.events.length, 0);
    assert.equal(input.posts.length, outcome === "model-filtered" ? 1 : 0);
    assert.equal(modelCalls, outcome === "model-filtered" ? 1 : 0);
    if (outcome === "model-filtered") {
      assert.equal(input.posts[0]!.filtered_out, true);
      assert.equal(input.posts[0]!.processing_status, "processed");
    }
  }));
}

test("reply and filtering settings stay isolated across platforms with the same author", async () => {
  const codexConfig = definition("socialdata", false, true, true), claudeConfig = definition("socialdata", true, false, false, claude);
  await inMonitor(codexConfig, async () => { await checkpoint(); await collectPosts({ startedAt: started, roundId: "isolated-codex" }); });
  await inMonitor(claudeConfig, async () => {
    await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('claude',${cursorKey()},${sql.json({ checkpointVersion: 2, scannedThrough: since })})`;
    await collectPosts({ startedAt: started, roundId: "isolated-claude" });
    assert.ok((await savedIds()).includes("102")); assert.equal((await savedIds()).includes("103"), false);
    assert.ok((await savedIds()).includes("104"));
  });
  await inMonitor(codexConfig, async () => { assert.equal((await savedIds()).includes("102"), false); assert.ok((await savedIds()).includes("103")); assert.equal((await savedIds()).includes("104"), false); });
});
