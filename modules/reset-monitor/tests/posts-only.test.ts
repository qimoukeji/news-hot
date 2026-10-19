import { Reply, stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { inMonitor } from "../backend/context.ts";
import { collectPosts, monitorTick } from "../backend/scan.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { installModules } from "@aihot/backend/modules";
import { createMonitorServer } from "../server.ts";

const now = new Date("2026-10-19T02:00:00Z"), since = "2026-10-19T01:00:00Z";
const definitions = [codex, claude, grok];
let failTail = false, badModel = false, modelCalls = 0;
let postPublishedAt = "2026-10-19T01:30:00Z";
const requests: string[] = [];
const provider = await stub((_hit, request) => {
  const url = new URL(request.url, "http://stub");
  assert.equal(url.pathname, "/twitter/search", "no parent/context lookup is allowed");
  const query = url.searchParams.get("query")!;
  requests.push(query);
  assert.match(query, / -filter:replies /);
  assert.doesNotMatch(query, /quota|reset|credit|filter:retweets/);
  if (url.searchParams.has("cursor")) return failTail ? new Reply(503, { error: "Synthetic page failure" }) : { tweets: [], next_cursor: null };
  const handle = /from:(\w+)/.exec(query)![1]!;
  const base = 1000 + ["thsottiaux", "claudedevs", "bot", "grok"].indexOf(handle) * 100;
  const tweet = (n: number) => ({ id_str: String(base + n), full_text: "A standalone product update", tweet_created_at: postPublishedAt, user: { name: handle, screen_name: handle } });
  return { tweets: [tweet(1), { ...tweet(2), quoted_status: { ...tweet(9), in_reply_to_status_id_str: "90" } },
    { ...tweet(3), in_reply_to_status_id_str: "91" }, { ...tweet(4), in_reply_to_screen_name: handle },
    { ...tweet(5), is_reply: true }, { ...tweet(6), retweeted_status: tweet(9) },
    { ...tweet(7), user: { name: "Other", screen_name: "other" } }], next_cursor: "tail" };
});
const model = await stub((_hit, request) => {
  modelCalls++;
  assert.doesNotMatch(JSON.parse(request.body).messages[1].content, /帖子 1[0-3]0[3-7]/);
  return { choices: [{ message: { content: JSON.stringify(badModel ? {} : { relevant: false, translationZh: "普通更新", contextZh: [], propositions: [], outage: null, needsReview: false }) }, finish_reason: "stop" }] };
});
Object.assign(process.env, { SOCIALDATA_BASE_URL: provider.url, SOCIALDATA_API_KEY: "synthetic", CODEX_RESET_PROVIDER: "socialdata", CLAUDE_RESET_PROVIDER: "socialdata", GROK_RESET_PROVIDER: "socialdata", MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "synthetic", LLM_MODEL: "synthetic-posts-only" });
config.allowPrivateNetworkFetch = true;
installModules(definitions.map(createMonitorServer));
beforeEach(async () => {
  mock.timers.enable({ apis: ["Date"], now });
  await sql`DELETE FROM monitor_event_posts`; await sql`DELETE FROM monitor_events`; await sql`DELETE FROM monitor_posts`; await sql`DELETE FROM monitor_state`; await sql`DELETE FROM receipts`;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=10000,per_day=100000`;
  for (const def of definitions) await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${def.monitorId},'cursor:socialdata',${sql.json({ checkpointVersion: 2, scannedThrough: since })})`;
  failTail = false; badModel = false; modelCalls = 0; requests.length = 0;
  postPublishedAt = "2026-10-19T01:30:00Z";
});
afterEach(() => mock.timers.reset());
after(async () => { await provider.close(); await model.close(); await closeDb(); });

for (const def of definitions) test(`${def.monitorId}: query, storage and recognition accept only main posts and embedded quotes`, async () => {
  await inMonitor(def, () => monitorTick());
  const posts = await sql`SELECT id,raw FROM monitor_posts WHERE monitor_id=${def.monitorId}`;
  assert.equal(posts.length, def.authors.length * 2);
  assert.equal(modelCalls, posts.length);
  assert.ok(posts.every(p => !p.raw.contextPending && !p.raw.processingMode));
  assert.equal((await sql`SELECT count(*)::int n FROM receipts WHERE purpose LIKE '%.context'`)[0]!.n, 0);
  assert.ok(requests.every(query => query.includes(`since_time:${Date.parse(since) / 1000}`)));
  assert.equal((await sql`SELECT value->>'scannedThrough' AS through FROM monitor_state WHERE monitor_id=${def.monitorId} AND key='cursor:socialdata'`)[0]!.through, now.toISOString());
});

test("a page failure leaves saved main posts unprocessed and preserves the success cutoff", async () => {
  failTail = true;
  await assert.rejects(inMonitor(grok, () => monitorTick()), /503/);
  assert.equal(modelCalls, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM monitor_posts WHERE monitor_id='grok'`)[0]!.n, 2);
  assert.equal((await sql`SELECT value->>'scannedThrough' AS through FROM monitor_state WHERE monitor_id='grok' AND key='cursor:socialdata'`)[0]!.through, since);
});

test("a new installation records its forward starting point without buying old history", async () => {
  await sql`DELETE FROM monitor_state WHERE monitor_id='codex'`;
  await inMonitor(codex, () => monitorTick());
  assert.equal(requests.length, 0);
  assert.equal(modelCalls, 0);
  assert.equal((await sql`SELECT value->>'scannedThrough' AS through FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`)[0]!.through, now.toISOString());
});

test("a failed first provider round keeps its saved starting point on retry", async () => {
  await sql`DELETE FROM monitor_state WHERE monitor_id='codex'`;
  // A post collected through the previous provider can still need recognition.
  await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url,raw,origin)
    VALUES('codex','9000','thsottiaux',${new Date(since)},'Saved main post','https://x.com/thsottiaux/status/9000','{"context":[]}'::jsonb,'live')`;
  badModel = true;
  await assert.rejects(inMonitor(codex, () => monitorTick()));
  assert.equal(requests.length, 0, "the first observation must not buy history");
  assert.equal((await sql`SELECT value->>'scopeEffectiveAt' AS start FROM monitor_state WHERE monitor_id='codex' AND key='collection:coverage:v1:socialdata'`)[0]!.start, now.toISOString());
  assert.equal((await sql`SELECT count(*)::int n FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`)[0]!.n, 0);

  mock.timers.tick(3600_000);
  postPublishedAt = "2026-10-19T02:15:00Z";
  badModel = false;
  await inMonitor(codex, () => monitorTick());
  assert.ok(requests.length > 0);
  assert.ok(requests.every(query => query.includes(`since_time:${now.getTime() / 1000}`)), "retry must search from the saved first observation");
  const posts = await sql`SELECT id,processed_at FROM monitor_posts WHERE monitor_id='codex' ORDER BY id`;
  assert.deepEqual(posts.map(post => post.id), ["1001", "1002", "9000"]);
  assert.ok(posts.every(post => post.processed_at));
  assert.equal((await sql`SELECT value->>'scannedThrough' AS through FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`)[0]!.through, "2026-10-19T03:00:00.000Z");
});

test("a changed collection policy keeps the old uncompleted interval", async () => {
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex','collection:coverage:v1:socialdata',${sql.json({ authors: [{ handle: "thsottiaux", name: "Tibo", collectedSince: since }], scopeEffectiveAt: since })})`;
  await inMonitor(codex, () => collectPosts());
  assert.ok(requests.every(query => query.includes(`since_time:${Date.parse(since) / 1000}`)));
});
