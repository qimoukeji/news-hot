import "./automatic-fixture.ts";
import { Reply, stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { inMonitor } from "../backend/context.ts";
import { collectPosts, monitorTick, screenPendingPosts } from "../backend/scan.ts";
import { loadCollectionCoverage } from "../backend/collection-coverage.ts";
import { bjIso, resetsSnapshot } from "../backend/read.ts";
import { buildCollectionFilter } from "../collection-filter.ts";
import { backendDefinition } from "../../grok-reset/backend-definition.ts";
import { installModules } from "@aihot/backend/modules";
import module from "../../grok-reset/server.ts";

installModules([module]);
const base = new Date("2026-10-09T09:00:00.000Z");
const at = (hour: number) => new Date(base.getTime() + hour * 3600_000);
const definition = { ...backendDefinition, authors: [{ handle: "bot", name: "Bot" }], collectionFilter: undefined };
const calls: Array<{ query: string; cursor: string | null }> = [];
let failedAuthor = "";
let responseTweets: unknown[] = [];
const provider = await stub((_hit, req) => {
  const url = new URL(req.url, "http://stub");
  const query = url.searchParams.get("query")!;
  calls.push({ query, cursor: url.searchParams.get("cursor") });
  if (url.pathname === "/twitter/tweet/advanced_search") return { tweets: [], has_next_page: false, next_cursor: null };
  if (query.startsWith(`from:${failedAuthor} `)) return new Reply(402, { message: "Synthetic exhausted account" });
  return { tweets: responseTweets, next_cursor: url.searchParams.get("cursor") ? null : "next" };
});
process.env.SOCIALDATA_BASE_URL = provider.url;
process.env.GROK_RESET_PROVIDER = "socialdata";
process.env.SOCIALDATA_API_KEY = "synthetic-coverage-key";
process.env.TWITTERAPI_IO_BASE_URL = provider.url;
process.env.TWITTERAPI_IO_API_KEY = "synthetic-coverage-key";
config.allowPrivateNetworkFetch = true;
const scoped = <T>(run: () => T) => inMonitor(definition, run);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts`;
  await sql`DELETE FROM budgets`;
  await sql`INSERT INTO monitor_state (monitor_id,key,value) VALUES ('grok','cursor:socialdata',${sql.json({ checkpointVersion: 2, scannedThrough: base.toISOString() })})`;
  calls.length = 0; failedAuthor = ""; responseTweets = []; process.env.COLLECT_ENABLED = "true";
  process.env.GROK_RESET_PROVIDER = "socialdata";
});
after(async () => { await provider.close(); await closeDb(); });

test("legacy baseline preserves increment and full daily lookback, including all pages", async () => {
  assert.equal((await scoped(() => collectPosts({ startedAt: at(1) }))).pages, 2);
  assert.equal(calls[0]!.cursor, null); assert.equal(calls[1]!.cursor, "next");
  assert.match(calls[0]!.query, new RegExp(`since_time:${base.getTime() / 1000}`));
  const state = await scoped(loadCollectionCoverage);
  assert.equal(state!.authors[0]!.collectedSince, null);
  assert.equal(state!.scopeEffectiveAt, null);
  calls.length = 0;
  await scoped(() => collectPosts({ startedAt: at(2), lookbackHours: 24 }));
  assert.match(calls[0]!.query, new RegExp(`since_time:${(at(2).getTime() - 24 * 3600_000) / 1000}`));
});

test("initializing another provider preserves the original provider's unfinished coverage", async () => {
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('twitterapi_io', 1000, 10000, 100000)`;
  const filtered = { ...definition, collectionFilter: buildCollectionFilter({ mode: "announcements_and_relevant_replies", words: ["quota"], productWords: ["grok"] }) };
  await inMonitor(filtered, () => collectPosts({ startedAt: at(1) }));
  await scoped(() => collectPosts({ startedAt: at(2) }));
  const originalCoverage = await scoped(loadCollectionCoverage);
  assert.equal(originalCoverage!.scopeEffectiveAt, at(2).toISOString());
  assert.equal(originalCoverage!.retiredScopes.length, 1);
  const modelCallsEnabled = config.modelCallsEnabled;
  config.modelCallsEnabled = true;
  try {
    process.env.GROK_RESET_PROVIDER = "twitterapi_io";
    assert.equal(await scoped(loadCollectionCoverage), null);
    await scoped(() => monitorTick({ initialRange: { since: at(4).toISOString(), until: at(5).toISOString() } }));
    const otherCoverage = await scoped(loadCollectionCoverage);
    assert.equal(otherCoverage!.scopeEffectiveAt, at(4).toISOString());
    assert.equal(otherCoverage!.authors[0]!.collectedSince, at(4).toISOString());
    assert.equal(otherCoverage!.retiredScopes.length, 0);
    assert.equal((await scoped(resetsSnapshot)).monitor!.scopeEffectiveAt, bjIso(at(4)));

    process.env.GROK_RESET_PROVIDER = "socialdata";
    assert.deepEqual(await scoped(loadCollectionCoverage), originalCoverage);
    assert.equal((await scoped(resetsSnapshot)).monitor!.scopeEffectiveAt, bjIso(at(2)));
    calls.length = 0;
    await scoped(() => monitorTick());
    const oldScope = calls.filter(c => c.query.includes("filter:replies"));
    assert.equal(oldScope.length, 4);
    assert.ok(oldScope.every(c => c.query.includes(`since_time:${base.getTime() / 1000}`)
      && c.query.includes(`until_time:${at(2).getTime() / 1000}`)));
    const currentScope = calls.filter(c => !c.query.includes("filter:replies"));
    assert.equal(currentScope.length, 2);
    assert.ok(currentScope.every(c => c.query.includes(`since_time:${at(2).getTime() / 1000}`)));
    assert.ok(Date.parse((await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key='cursor:socialdata'`)[0]!.value.scannedThrough) > at(5).getTime());
    process.env.GROK_RESET_PROVIDER = "twitterapi_io";
    assert.deepEqual(await scoped(loadCollectionCoverage), otherCoverage);
    assert.equal((await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key='cursor:twitterapi_io'`)[0]!.value.scannedThrough, at(5).toISOString());
  } finally {
    process.env.GROK_RESET_PROVIDER = "socialdata";
    config.modelCallsEnabled = modelCallsEnabled;
  }
});

test("an account's first observed start commits before a failed request and does not move on retry", async () => {
  await scoped(() => collectPosts({ startedAt: at(1) }));
  const added = { ...definition, authors: [...definition.authors, { handle: "grok", name: "Grok" }] };
  failedAuthor = "bot";
  await assert.rejects(inMonitor(added, () => collectPosts({ startedAt: at(2) })), /402/);
  const saved = await inMonitor(added, loadCollectionCoverage);
  assert.deepEqual(saved!.authors.map(a => a.collectedSince), [null, at(2).toISOString()]);
  assert.equal((await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key='cursor:socialdata'`)[0]!.value.scannedThrough, base.toISOString());
  failedAuthor = ""; calls.length = 0;
  await inMonitor(added, () => collectPosts({ startedAt: at(3), lookbackHours: 24 }));
  assert.match(calls.find(c => c.query.startsWith("from:grok "))!.query, new RegExp(`since_time:${at(2).getTime() / 1000}`));
  assert.match(calls.find(c => c.query.startsWith("from:bot "))!.query, new RegExp(`since_time:${(at(3).getTime() - 24 * 3600_000) / 1000}`));
  assert.deepEqual((await inMonitor(added, loadCollectionCoverage))!.authors.map(a => a.collectedSince), [null, at(2).toISOString()]);
});

test("expanded collection only starts at observation, and readded accounts get a new start", async () => {
  const filtered = { ...definition, collectionFilter: buildCollectionFilter({ mode: "announcements_and_relevant_replies", words: ["quota"], productWords: ["grok"] }) };
  await inMonitor(filtered, () => collectPosts({ startedAt: at(1) }));
  calls.length = 0;
  // The old checkpoint's window still uses the old scope. New all-posts scope has no past window.
  assert.equal((await scoped(() => collectPosts({ startedAt: at(2) }))).pages, 4);
  assert.ok(calls.every(call => call.query.includes("filter:replies")));
  calls.length = 0;
  await scoped(() => collectPosts({ startedAt: at(3), lookbackHours: 24 }));
  const expanded = calls.find(call => !call.query.includes("filter:replies"))!;
  assert.match(expanded.query, new RegExp(`since_time:${at(2).getTime() / 1000}`));
  const added = { ...definition, authors: [...definition.authors, { handle: "grok", name: "Grok" }] };
  await inMonitor(added, () => collectPosts({ startedAt: at(4) }));
  await scoped(() => collectPosts({ startedAt: at(5) }));
  await inMonitor(added, () => collectPosts({ startedAt: at(6) }));
  assert.equal((await inMonitor(added, loadCollectionCoverage))!.authors[1]!.collectedSince, at(6).toISOString());
});

test("a failed gap is completed under its saved filter while provider overdelivery cannot broaden historical scope", async () => {
  const filtered = { ...definition, collectionFilter: buildCollectionFilter({ mode: "announcements_and_relevant_replies", words: ["quota"], productWords: ["grok"] }) };
  failedAuthor = "bot";
  await assert.rejects(inMonitor(filtered, () => collectPosts({ startedAt: at(1) })), /402/);
  failedAuthor = "";
  const tweet = (id: string, hour: number, text: string) => ({ id_str: id, tweet_created_at: at(hour).toISOString(), full_text: text,
    in_reply_to_status_id_str: "parent", user: { screen_name: "bot", name: "Bot" } });
  responseTweets = [tweet("1", 0.5, "grok quota"), tweet("2", 0.5, "ordinary reply"), tweet("3", 2.5, "ordinary reply"), tweet("4", -1, "grok quota")];
  // Observation at hour 2 buys only the old historical scope, not the newly enabled ordinary replies.
  assert.equal((await scoped(() => collectPosts({ startedAt: at(2) }))).stored, 1);
  assert.deepEqual((await sql`SELECT id FROM monitor_posts ORDER BY id`).map(p => p.id), ["1"]);
  await scoped(() => collectPosts({ startedAt: at(3), lookbackHours: 24 }));
  const rows = await sql`SELECT id,raw FROM monitor_posts ORDER BY id`;
  assert.deepEqual(rows.map(p => p.id), ["1", "3", "4"]); // Old-scope hour -1 is in the requested 24h lookback.
  assert.equal(rows[0]!.raw.collectionFilter.signature, filtered.collectionFilter!.signature);
  assert.equal(rows[1]!.raw.collectionFilter.signature, null);
  assert.equal(rows[0]!.raw.contextPending, true); // Collection does not buy reply context.
  assert.ok(calls.every(call => call.query.startsWith("from:bot ")));
});

test("retired scopes survive an old failed checkpoint and expire only after success and the daily lookback", async () => {
  await scoped(() => collectPosts({ startedAt: at(1) }));
  const filtered = { ...definition, collectionFilter: buildCollectionFilter({ mode: "announcements_and_relevant_replies", words: ["quota"], productWords: ["grok"] }) };
  await inMonitor(filtered, () => collectPosts({ startedAt: at(2) }));
  await inMonitor(filtered, () => collectPosts({ startedAt: at(30) }));
  assert.equal((await inMonitor(filtered, loadCollectionCoverage))!.retiredScopes.length, 1);
  await sql`UPDATE monitor_state SET value=${sql.json({ checkpointVersion: 2, scannedThrough: at(3).toISOString() })} WHERE monitor_id='grok' AND key='cursor:socialdata'`;
  await inMonitor(filtered, () => collectPosts({ startedAt: at(4), lookbackHours: 24 }));
  assert.equal((await inMonitor(filtered, loadCollectionCoverage))!.retiredScopes.length, 1);
  await inMonitor(filtered, () => collectPosts({ startedAt: at(30) }));
  assert.equal((await inMonitor(filtered, loadCollectionCoverage))!.retiredScopes.length, 0);
});

test("screening preserves original acceptance and model results while recording excluded legacy posts", async () => {
  const filter = { ...definition, collectionFilter: { query: "quota", version: "synthetic-v1", reason: "Quota only", accepts: () => false } };
  const tweet = { id_str: "1", user: { screen_name: "bot", name: "Bot" }, tweet_created_at: base.toISOString(), full_text: "Ordinary post" };
  for (const [id, raw, recognition] of [
    ["1", { tweet, contextPending: true }, null],
    ["2", { tweet, contextPending: true, collectionFilter: { version: null, accepted: true } }, null],
    ["3", { tweet, contextPending: true }, { relevant: true, originalResult: "retained" }],
  ] as const) {
    await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,raw,recognition) VALUES ('grok',${id},'bot',${base},'Ordinary post',${`https://x.com/bot/status/${id}`},${sql.json(raw)},${recognition ? sql.json(recognition) : null})`;
  }
  assert.equal(await inMonitor(filter, screenPendingPosts), 1);
  const posts = await sql`SELECT id,raw,recognition,processed_at FROM monitor_posts ORDER BY id`;
  assert.equal(posts[0]!.raw.collectionFilter.accepted, false);
  assert.equal(posts[0]!.raw.contextPending, false);
  assert.equal(posts[1]!.processed_at, null);
  assert.deepEqual(posts[1]!.raw.collectionFilter, { version: null, accepted: true });
  assert.deepEqual(posts[2]!.recognition, { relevant: true, originalResult: "retained" });
  assert.equal(posts[2]!.processed_at, null);
});
