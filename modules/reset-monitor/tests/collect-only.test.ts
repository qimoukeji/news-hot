import "./collect-only-fixture.ts";
import { Reply, stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { inMonitor } from "../backend/context.ts";
import { collectPosts, collectPendingContext, processPending, monitorTick } from "../backend/scan.ts";
import { recognizePost } from "../backend/recognize.ts";
import { listMonitorPosts } from "../backend/admin.ts";
import { reconcileCollectionCoverage } from "../backend/collection-coverage.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import codexServer from "../../codex-reset/server.ts";
import claudeServer from "../../claude-reset/server.ts";
import grokServer from "../../grok-reset/server.ts";

installModules([codexServer, claudeServer, grokServer]);
const definitions = [codex, claude, grok];
const servers = [codexServer, claudeServer, grokServer];
const started = new Date();
const since = new Date(started.getTime() - 60_000).toISOString();
const range = { since, until: new Date(started.getTime() - 1000).toISOString() };
let failureAuthor = "";
const queries: string[] = [];
const lookups: string[] = [];
// Synthetic official replies; all provider and model calls can only reach local stubs.
const provider = await stub((_hit, request) => {
  const url = new URL(request.url, "http://stub");
  if (url.pathname !== "/twitter/search") { lookups.push(url.pathname); throw new Error("Context must never be fetched"); }
  const query = url.searchParams.get("query")!;
  queries.push(query);
  const handle = /from:(\w+)/.exec(query)![1]!;
  if (handle === failureAuthor) return new Reply(500, { error: "Synthetic failed second author" });
  return { tweets: [{ id_str: String(100 + ["thsottiaux", "claudedevs", "bot", "grok"].indexOf(handle.toLowerCase())), full_text: "Synthetic reply about quota.", tweet_created_at: new Date(started.getTime() - 10_000).toISOString(),
    in_reply_to_status_id_str: "900", user: { screen_name: handle, name: handle } }], next_cursor: null };
});
const model = await stub(() => { throw new Error("Model must never be invoked"); });
Object.assign(process.env, { SOCIALDATA_BASE_URL: provider.url, SOCIALDATA_API_KEY: "synthetic-key", COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "true",
  CODEX_RESET_PROVIDER: "socialdata", CLAUDE_RESET_PROVIDER: "socialdata", GROK_RESET_PROVIDER: "socialdata", MONITOR_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: model.url, DEEPSEEK_API_KEY: "synthetic-key" });
config.allowPrivateNetworkFetch = true;
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts`;
  await sql`DELETE FROM budgets`;
  queries.length = 0; lookups.length = 0; failureAuthor = "";
  config.modelCallsEnabled = true; process.env.COLLECT_ENABLED = "true";
});
after(async () => { await provider.close(); await model.close(); await closeDb(); });

test("collect-only monitors register only forward collection schedules", () => {
  definitions.forEach((definition, index) => {
    assert.equal(definition.processingMode, "collect_only");
    assert.deepEqual(servers[index]!.schedules!.map(schedule => schedule.name), [definition.names.tick]);
  });
});

test("direct lookback, context and recognition calls cannot bypass collect-only with both valves enabled", async () => {
  for (const definition of definitions) await inMonitor(definition, async () => {
    await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,raw)
      VALUES (${definition.monitorId},'existing',${definition.authors[0]!.handle},${started},'Synthetic pending reply','https://x.com/i/status/existing','{"contextPending":true}'::jsonb)`;
    assert.deepEqual(await collectPosts({ lookbackHours: 24 }), { stored: 0, pages: 0 });
    assert.deepEqual(await monitorTick({ lookbackHours: 24 }), { skipped: true, reason: "historical_collection_disabled" });
    assert.deepEqual(await collectPendingContext(), { completed: 0 });
    assert.deepEqual(await processPending(), { processed: 0, failed: 0 });
    await assert.rejects(recognizePost({ id: "existing", text: "Synthetic pending reply", publishedAt: started.toISOString(), context: [], openEvents: [] }), /recognition is disabled/);
  });
  assert.equal(provider.hits(), 0); assert.equal(model.hits(), 0);
  assert.equal((await sql`SELECT id FROM receipts`).length, 0);
});

test("each successful live scan completes only new posts and advances its own cursor without model calls", async () => {
  config.modelCallsEnabled = false;
  for (const definition of definitions) await inMonitor(definition, async () => {
    await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES (${definition.monitorId},'cursor:socialdata',${sql.json({ checkpointVersion: 2, scannedThrough: since })})`;
    const result = await monitorTick();
    assert.ok("processingMode" in result);
    assert.equal(result.processingMode, "collect_only");
    const posts = await sql`SELECT processed_at,recognition,raw FROM monitor_posts WHERE monitor_id=${definition.monitorId}`;
    assert.equal(posts.length, definition.authors.length);
    for (const post of posts) {
      assert.ok(post.processed_at); assert.equal(post.recognition, null); assert.equal(post.raw.contextPending, false);
      assert.equal(post.raw.processingCompletion.mode, "collect_only");
    }
    const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id=${definition.monitorId} AND key='cursor:socialdata'`;
    assert.ok(Date.parse(cursor!.value.scannedThrough) > Date.parse(since));
    const admin = await listMonitorPosts({ filter: "all" });
    assert.equal(admin.rows.every(post => post.collection_only === true && post.relevant === null), true);
    assert.equal((await listMonitorPosts({ filter: "unrelated" })).total, 0);
    assert.equal((await listMonitorPosts({ filter: "pending" })).total, 0);
    await monitorTick();
    assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_posts WHERE monitor_id=${definition.monitorId}`)[0]!.n, definition.authors.length);
  });
  assert.equal(lookups.length, 0); assert.equal(model.hits(), 0);
  assert.equal((await sql`SELECT id FROM receipts WHERE purpose LIKE '%.context' OR purpose LIKE '%.recognize'`).length, 0);
});

test("a failed later author preserves stored completed posts and the old live checkpoint", async () => {
  failureAuthor = "grok";
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES ('grok','cursor:socialdata',${sql.json({ checkpointVersion: 2, scannedThrough: since })})`;
  await assert.rejects(inMonitor(grok, () => monitorTick()), /500|Synthetic failed/);
  const [post] = await sql`SELECT processed_at,recognition FROM monitor_posts WHERE monitor_id='grok'`;
  assert.ok(post!.processed_at); assert.equal(post!.recognition, null);
  const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key='cursor:socialdata'`;
  assert.equal(cursor!.value.scannedThrough, since);
  assert.equal(model.hits(), 0); assert.equal(lookups.length, 0);
});

test("collect-only initialization finishes paging without model credentials even when CLI flag is omitted", async () => {
  const command = fileURLToPath(new URL("../../codex-reset/scripts/initialize.ts", import.meta.url));
  const result = await promisify(execFile)(process.execPath, ["--import", new URL("./collect-only-fixture.ts", import.meta.url).href, command, "--since", range.since, "--until", range.until], {
    env: { ...process.env, ALLOW_PRIVATE_NETWORK_FETCH: "true", MODEL_CALLS_ENABLED: "false", DEEPSEEK_API_KEY: "", LLM_API_KEY: "" }, timeout: 20_000,
  });
  assert.equal(JSON.parse(result.stdout).processingMode, "collect_only");
  assert.equal((await sql`SELECT key FROM monitor_state WHERE monitor_id='codex' AND key='initial:socialdata'`).length, 0);
  assert.equal((await sql`SELECT key FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`).length, 1);
  assert.equal(model.hits(), 0); assert.equal(lookups.length, 0);
});

test("collect-only configuration changes do not resurrect historical scopes", () => {
  const original = { ...grok, collectionFilter: { query: "old", version: "old", reason: "Synthetic legacy scope", accepts: () => true } };
  const saved = reconcileCollectionCoverage(null, original, since, since);
  const next = reconcileCollectionCoverage(saved, grok, started.toISOString(), null);
  assert.deepEqual(next.retiredScopes, []);
  assert.equal(next.scopeEffectiveAt, started.toISOString());
});
