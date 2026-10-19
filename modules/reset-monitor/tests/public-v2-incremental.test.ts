import { Reply, stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { modulePublication } from "@aihot/backend/publication/modules";
import { inMonitor } from "../backend/context.ts";
import { monitorTick, collectPosts, processPending } from "../backend/scan.ts";
import { processPublicV2Pending } from "../backend/public-v2-generate.ts";
import { enqueuePublicV2 } from "../backend/public-v2-work.ts";
import { recordRun } from "@aihot/backend/jobs/queue";
import { publicV2Title, properName } from "../backend/public-v2.ts";
import { resetsSnapshot, resetVersion } from "../backend/read.ts";
import { reviewedEventSchema, resetSnapshotSchema, type ResetSnapshot } from "../public-v2.ts";
import { reconcileCollectionCoverage } from "../backend/collection-coverage.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { isMonitorRequest } from "@aihot/backend/providers/receipts";
import { updateMonitorEvent, reviewReceipt, setWithdrawn } from "../backend/admin.ts";

const definitions = [codex, claude, grok];
// Keep the yearless bonus deadlines anchored before Oct 17, independent of the test run date.
const started = new Date("2026-10-16T12:00:00Z");
const postAt = new Date(started.getTime() - 10_000);
const since = new Date(started.getTime() - 60_000).toISOString();
let variant = "all", badOutput = "", conflict = false;
let enrichmentCalls = 0, recognitionCalls = 0;
const bodies = new Map<string, string>();
const enrichmentInputs: any[] = [];
const provider = await stub((_hit, request) => {
  const url = new URL(request.url, "http://local");
  assert.equal(url.pathname, "/twitter/search", "these synthetic root posts need no context lookup");
  const query = url.searchParams.get("query")!;
  assert.doesNotMatch(query, /since:202[0-5]/);
  const handle = /from:(\w+)/.exec(query)![1]!;
  const tags = variant === "all" ? ["RESET", "CARD", "BONUS", "IGNORE"] : variant === "announce" ? ["ANNOUNCE"] : ["RESET"];
  const tweets = tags.map((tag, index) => {
    const id = String(10000 + ["thsottiaux", "claudedevs", "bot", "grok"].indexOf(handle.toLowerCase()) * 100 + index);
    const text = tag === "RESET" ? "RESET: We reset usage for all users."
      : tag === "ANNOUNCE" ? "ANNOUNCE: We will reset usage for all users in the next 30 minutes."
      : tag === "CARD" ? "CARD: We granted all users one banked reset to redeem later."
      : tag === "BONUS" ? "BONUS: One-time bonus credit for cloud sessions is now available for all users. Claim by Oct 17 at 11:59pm PT. Credit expires Nov 4."
      : "IGNORE: Nice weather today.";
    bodies.set(id, text);
    return { id_str: id, full_text: text, tweet_created_at: postAt.toISOString(), user: { screen_name: handle, name: handle } };
  });
  return { tweets, next_cursor: null };
});
const model = await stub(async (_hit, request) => {
  const body = JSON.parse(request.body), user = body.messages[1].content as string;
  let content: unknown;
  if (user.startsWith("{")) {
    enrichmentCalls++;
    const input = JSON.parse(user), row = input.event, post = input.posts[0];
    enrichmentInputs.push(input);
    const def = definitions.find(def => def.authors.some(author => author.handle.toLowerCase() === post.author.toLowerCase()))!;
    const status = row.status;
    const audience = `${row.scope} ${row.scopeLabel ?? ""} ${row.audienceZh ?? ""}`;
    const productCodes = input.catalog.products.filter((entry: any) => row.productsZh === entry.name.en
      || row.productsZh === "Grok 普通额度" && entry.code === "grok").map((entry: any) => entry.code);
    const planCodes = input.catalog.plans.filter((entry: any) => row.scopeLabel === entry.name.en || row.scope === entry.name.en).map((entry: any) => entry.code);
    content = { title: publicV2Title(def.product, row.type, status), summary: properName("Synthetic public business summary."),
      scope: { type: /paid|付费|付費/i.test(audience) ? "paid_users" : "all_users", productCodes, planCodes,
        quotaWindowCodes: row.quotaScope === "weekly" ? ["weekly"] : [], note: null },
      bonusCredit: row.type === "bonus_credit" ? { amount: null, eligibility: properName("All users."), claimMethod: null, usageTerms: null } : null,
      updateSummaries: input.links.filter((link: any) => ["announce", "confirm", "progress", "amend", "withdraw"].includes(link.action)).map((link: any) => ({ postId: link.post_id, summary: properName("Synthetic business update.") })),
      evidence: input.posts.map((source: any) => ({ postId: source.id, excerpt: source.text })), timeEvidence: status === "announced" && post.text.startsWith("ANNOUNCE") ? { postId: post.id, excerpt: post.text } : null };
    const data = content as any;
    if (badOutput === "language") delete data.title.ja;
    if (badOutput === "quote" || badOutput === "first-quote" && row.type === "direct_reset") data.evidence[0].excerpt = "This quote was never written.";
    if (badOutput === "code") data.scope.planCodes = ["another-platform-plan"];
    if (badOutput === "unknown-scope") data.scope.type = "unknown";
    if (badOutput === "selected-note") data.scope.type = "selected_users";
    if (badOutput === "scope-audience") data.scope.type = "all_users";
    if (badOutput === "scope-plan") data.scope.planCodes = [];
    if (badOutput === "scope-product") data.scope.productCodes = [];
    if (badOutput === "scope-window") data.scope.quotaWindowCodes = [];
    if (badOutput === "attribution") data.summary.zh = "原帖称已完成重置。";
    if (badOutput === "update-attribution") data.updateSummaries[0].summary.zh = "原帖称已完成重置。";
    if (badOutput === "update-missing") data.updateSummaries = [];
    if (badOutput === "update-duplicate") data.updateSummaries.push(data.updateSummaries[0]);
    if (badOutput === "update-unlinked") data.updateSummaries[0].postId = "unlinked";
    if (["range", "time"].includes(badOutput)) data.timeEvidence = { postId: badOutput === "time" ? "unlinked" : post.id, excerpt: post.text };
    if (badOutput === "transport") return new Reply(429, { error: "Synthetic refusal" });
    if (conflict) {
      conflict = false;
      await sql`UPDATE monitor_events SET title='Synthetic concurrent correction',updated_at=now() WHERE monitor_id=${def.monitorId} AND id=${row.id}`;
    }
  } else {
    recognitionCalls++;
    const id = /帖子 ([^，]+)/.exec(user)![1]!, text = bodies.get(id)!;
    const kind = text.startsWith("CARD") ? "reset_credit" : text.startsWith("BONUS") ? "bonus_credit" : "direct_reset";
    assert.match(body.messages[0].content, /个人账户到账或恢复不能证明整个活动完成/);
    const target = /^(?:AMEND|PROGRESS|CONFIRM|PERSONAL):/.test(text) ? (await sql`SELECT id FROM monitor_events WHERE monitor_id='codex' ORDER BY id LIMIT 1`)[0]!.id : null;
    content = { relevant: !text.startsWith("IGNORE"), translationZh: text, contextZh: [], outage: null, needsReview: false,
      propositions: text.startsWith("IGNORE") ? [] : [{ kind, kindExplicit: true, action: text.startsWith("PROGRESS") ? "progress" : text.startsWith("CONFIRM") ? "confirm" : target ? "amend" : text.startsWith("ANNOUNCE") ? "announce" : "confirm", real: !text.startsWith("PERSONAL"), count: 1,
        role: text.startsWith("PERSONAL") ? "explanation" : "action", relatesTo: target, excerpt: text, excerptZh: text, statedTime: null, timeInferred: false, expectedLanding: null,
        scope: { audienceSource: "all users", plans: null, audienceZh: "所有用户", productsZh: null }, bonusCredit: null }] };
  }
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
Object.assign(process.env, { SOCIALDATA_BASE_URL: provider.url, SOCIALDATA_API_KEY: "synthetic", COLLECT_ENABLED: "true",
  CODEX_RESET_PROVIDER: "socialdata", CLAUDE_RESET_PROVIDER: "socialdata", GROK_RESET_PROVIDER: "socialdata",
  MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "synthetic", LLM_MODEL: "synthetic-incremental-v2" });
config.allowPrivateNetworkFetch = true;
installModules(definitions.map(createMonitorServer));
beforeEach(async () => {
  mock.timers.enable({ apis: ["Date"], now: started });
  await sql`DELETE FROM monitor_event_posts`; await sql`DELETE FROM monitor_events`; await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`; await sql`DELETE FROM receipts`; await sql`DELETE FROM budgets`;
  for (const def of definitions) await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${def.monitorId},'cursor:socialdata',${sql.json({ checkpointVersion: 2, scannedThrough: since })})`;
  variant = "all"; badOutput = ""; conflict = false; recognitionCalls = 0; enrichmentCalls = 0;
  enrichmentInputs.length = 0;
  config.modelCallsEnabled = true; process.env.COLLECT_ENABLED = "true";
});
afterEach(() => mock.timers.reset());
after(async () => { await provider.close(); await model.close(); installModules([]); await closeDb(); });
const read = (definition = codex) => modulePublication<ResetSnapshot>(definition.moduleName, "snapshotV2");

test("site monitors enable forward automatic processing and never schedule or resurrect historical lookback", async () => {
  for (const def of definitions) {
    assert.equal(def.processingMode, "automatic_incremental");
    assert.deepEqual(createMonitorServer(def).schedules!.map(schedule => schedule.name), [def.names.tick]);
    assert.deepEqual(await inMonitor(def, () => collectPosts({ lookbackHours: 24 })), { stored: 0, pages: 0 });
    assert.deepEqual(await inMonitor(def, () => monitorTick({ lookbackHours: 24 })), { skipped: true, reason: "historical_collection_disabled" });
    const old = { ...def, collectionFilter: { query: "old", version: "old", reason: "Synthetic", accepts: () => true } };
    const saved = reconcileCollectionCoverage(null, old, since, since);
    assert.deepEqual(reconcileCollectionCoverage(saved, def, started.toISOString(), null).retiredScopes, []);
    assert.equal(isMonitorRequest(`${def.names.purposePrefix}.public_v2`), true);
  }
});

test("new posts flow through recognition, all three event kinds, seven languages and strict platform snapshots", async () => {
  for (const def of definitions) {
    const result = await inMonitor(def, () => monitorTick());
    assert.ok("enriched" in result && result.enriched >= 3, JSON.stringify({ monitor: def.monitorId, result, posts: await sql`SELECT recognition FROM monitor_posts WHERE monitor_id=${def.monitorId}` }));
    const snapshot = resetSnapshotSchema.parse(await read(def));
    assert.equal(snapshot.platform, def.publicV2!.platform);
    assert.deepEqual([...new Set(snapshot.events.map(event => event.type))].sort(), ["bonus_credit", "direct_reset", "reset_credit"]);
    for (const event of snapshot.events) {
      assert.equal(Object.keys(event.title).length, 7);
      assert.equal(Object.keys(event.summary!).length, 7);
      assert.equal("details" in event, false); assert.equal(typeof event.time, "string");
      assert.equal(event.publishedAt, postAt.toISOString());
      const [stored] = await sql`SELECT presentation FROM monitor_events WHERE monitor_id=${def.monitorId} AND id=${event.id}`;
      reviewedEventSchema.parse(stored!.presentation.publicV2);
      if (event.type === "bonus_credit") {
        assert.deepEqual(event.bonusCredit!.claimDeadline, { kind: "deadline", at: "2026-10-18T06:59:00Z" });
        assert.deepEqual(event.bonusCredit!.expiresAt, { kind: "date", date: "2026-11-04", timeZone: "America/Los_Angeles" });
      }
    }
    assert.equal((await sql`SELECT key FROM monitor_state WHERE monitor_id=${def.monitorId} AND key LIKE 'public_v2:pending:%'`).length, 0);
    const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id=${def.monitorId} AND key='cursor:socialdata'`;
    assert.ok(Date.parse(cursor!.value.scannedThrough) > Date.parse(since));
  }
  const calls = model.hits(); await read(); await inMonitor(codex, () => monitorTick());
  assert.equal(model.hits(), calls, "fresh public metadata and duplicate posts do not call models");
  const [incomplete] = await sql`SELECT count(*)::int AS n FROM receipts WHERE purpose LIKE '%.public_v2' AND status<>'completed'`;
  assert.equal(incomplete!.n, 0);
});

test("cutover ignores all pre-existing pending and collection-only posts", async () => {
  variant = "reset";
  await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url,raw,processed_at) VALUES
    ('codex','old-pending',${codex.authors[0]!.handle},${postAt},'Old unprocessed reset','https://x.com/i/status/old-pending','{"contextPending":true}'::jsonb,NULL),
    ('codex','old-collected',${codex.authors[0]!.handle},${postAt},'Old collected reset','https://x.com/i/status/old-collected','{"processingCompletion":{"mode":"collect_only"}}'::jsonb,now())`;
  await inMonitor(codex, () => monitorTick());
  assert.equal(recognitionCalls, 1); assert.equal(enrichmentCalls, 1);
  const rows = await sql`SELECT id,recognition,processed_at FROM monitor_posts WHERE id LIKE 'old-%' ORDER BY id`;
  assert.equal(rows[0]!.recognition, null); assert.equal(rows[1]!.recognition, null); assert.equal(rows[1]!.processed_at, null);
  assert.equal((await read()).events.length, 1);
});

test("automatic enrichment stores the default audience and latest update when timing is unstated", async () => {
  variant = "reset"; badOutput = "unknown-scope";
  await inMonitor(codex, () => monitorTick());
  const event = (await read()).events[0]!;
  assert.equal(event.scope.type, "all_users");
  assert.equal(event.scope.note!.zh, "所有用户");
  assert.deepEqual(event.time, postAt.toISOString());
  const [stored] = await sql`SELECT presentation->'publicV2' AS review FROM monitor_events WHERE monitor_id='codex' AND id=${event.id}`;
  assert.equal(stored!.review.scope.type, "all_users");
  assert.equal(stored!.review.scope.note.zh, "所有用户");
  assert.deepEqual(stored!.review.time, event.time);
  assert.equal(stored!.review.timeBasis, "latest_update");
});

test("official relative plans use the scalar event and overview announcement time without confirming completion", async () => {
  variant = "announce";
  await inMonitor(codex, () => monitorTick());
  const snapshot = await read(), event = snapshot.events[0]!;
  const expected = { kind: "deadline", at: new Date(postAt.getTime() + 30 * 60_000).toISOString() };
  assert.equal(event.status, "announced");
  assert.equal(event.time, expected.at); assert.equal("announcement" in event, false);

  assert.equal(snapshot.announcedResetTime, event.time);
  assert.equal(snapshot.resetTime, null);
  assert.equal(snapshot.statistics.resetsLast30Days, 0);
});

test("automatic enrichment preserves a recorded occurrence date separately from a different announcement time", async () => {
  variant = "announce";
  await inMonitor(codex, () => monitorTick());
  const id = (await read()).events[0]!.id;
  await sql`UPDATE monitor_events SET occurred_on='2026-10-01' WHERE monitor_id='codex' AND id=${id}`;
  const expected = "2026-10-01";
  assert.deepEqual((await read()).events[0]!.time, expected);
  await inMonitor(codex, () => processPublicV2Pending());
  const event = (await read()).events[0]!;
  assert.deepEqual(event.time, expected);
  assert.equal("announcement" in event, false);
  assert.equal(event.status, "announced");
});

test("a new follow-up refreshes the existing event without changing identity or first publication", async () => {
  variant = "reset";
  await inMonitor(codex, () => monitorTick());
  const first = (await read()).events[0]!;
  const id = "10099", text = "AMEND: All users were included in that reset.";
  bodies.set(id, text);
  await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url,raw) VALUES
    ('codex',${id},${codex.authors[0]!.handle},${new Date(postAt.getTime() + 1000)},${text},${`https://x.com/i/status/${id}`},'{"processingMode":"automatic_incremental"}'::jsonb)`;
  await inMonitor(codex, () => monitorTick());
  const snapshot = await read();
  assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0]!.id, first.id);
  assert.equal(snapshot.events[0]!.publishedAt, first.publishedAt);
  assert.deepEqual(snapshot.events[0]!.updates.map(update => update.id), [id, first.updates[0]!.id]);
  assert.deepEqual(snapshot.events[0]!.updates[1]!.source, first.updates[0]!.source);
  const updated = new Date(postAt.getTime() + 1000).toISOString();
  assert.deepEqual(snapshot.events[0]!.time, updated);
  const [stored] = await sql`SELECT presentation->'publicV2' AS review FROM monitor_events WHERE monitor_id='codex' AND id=${first.id}`;
  assert.deepEqual(stored!.review.time, snapshot.events[0]!.time);
  assert.equal(stored!.review.timeBasis, "latest_update");
  assert.equal(snapshot.sources.filter(source => source.id === first.updates[0]!.source.sourceId).length, 1);
  assert.equal(recognitionCalls, 2); assert.equal(enrichmentCalls, 2);
});

test("announcement, individual feedback, progress, confirmation and repair keep one event and refresh its business timeline", async () => {
  variant = "announce";
  await inMonitor(codex, () => monitorTick());
  const first = (await read()).events[0]!;
  const followups = [
    ["10096", "PERSONAL: My usage has been restored.", "announced", null],
    ["10097", "PROGRESS: We are rolling out the reset for all users.", "in_progress", "progress"],
    ["10098", "CONFIRM: The reset has completed for all users.", "completed", "confirm"],
    ["10099", "AMEND: The missing delivery issue has been fixed for all users.", "completed", "amend"],
  ] as const;
  for (const [index, [id, text, status, action]] of followups.entries()) {
    bodies.set(id, text);
    const publishedAt = new Date(postAt.getTime() + (index + 1) * 1000);
    await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url,raw) VALUES
      ('codex',${id},${codex.authors[0]!.handle},${publishedAt},${text},${`https://x.com/i/status/${id}`},'{"processingMode":"automatic_incremental"}'::jsonb)`;
    await inMonitor(codex, () => processPending());
    const pending = await read(), event = pending.events[0]!;
    assert.equal(pending.events.length, 1); assert.equal(event.id, first.id); assert.equal(event.publishedAt, first.publishedAt);
    assert.equal(event.status, status);
    if (action) {
      assert.equal(event.summary, null, "accepted facts invalidate old editorial content before enrichment");
      assert.ok(event.updates.every(update => update.summary === null));
      assert.equal(event.updates[0]!.action, action);
      assert.equal(event.time, publishedAt.toISOString(), "progress and completion never reuse the planned deadline");
      assert.deepEqual((await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${`public_v2:pending:${first.id}`}`)[0]!.value, { status: "pending" });
      await inMonitor(codex, () => processPublicV2Pending());
      assert.ok((await read()).events[0]!.summary);
    } else {
      assert.equal(event.updates.length, 1, "individual feedback cannot become a global business update");
      assert.equal(pending.announcedResetTime, event.time); assert.equal(pending.resetTime, null);
    }
  }
  const final = await read();
  assert.deepEqual(final.events[0]!.updates.map(update => update.action), ["amend", "confirm", "progress", "announce"]);
  assert.equal(final.statistics.resetsLast30Days, 1);
  assert.equal(final.announcedResetTime, null); assert.equal(final.resetTime, final.events[0]!.time);
});

for (const operation of ["update", "receipt", "withdraw", "restore"] as const) test(`admin ${operation} atomically queues v2 refresh and invalidates old editorial content`, async () => {
  variant = operation === "receipt" ? "announce" : "reset";
  await inMonitor(codex, () => monitorTick());
  const first = (await read()).events[0]!;
  if (operation === "restore") await sql`UPDATE monitor_events SET withdrawn=true WHERE monitor_id='codex' AND id=${first.id}`;
  const [before] = await sql`SELECT * FROM monitor_events WHERE monitor_id='codex' AND id=${first.id}`;
  const input = { reason: "Synthetic accepted correction", version: new Date(before!.updated_at).toISOString() };
  await inMonitor(codex, () => operation === "update" ? updateMonitorEvent(first.id, { ...input, patch: { audienceZh: "所有用户", productsZh: "Codex" } }, "synthetic-admin")
    : operation === "receipt" ? reviewReceipt(first.id, { ...input, occurredOn: "2026-10-14" }, "synthetic-admin")
    : setWithdrawn(first.id, { ...input, withdrawn: operation === "withdraw" }, "synthetic-admin"));
  assert.deepEqual((await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${`public_v2:pending:${first.id}`}`)[0]!.value, { status: "pending" });
  if (operation === "withdraw") assert.equal((await read()).events.length, 0);
  else assert.equal((await read()).events[0]!.summary, null);
  await inMonitor(codex, () => processPublicV2Pending());
  assert.equal((await sql`SELECT key FROM monitor_state WHERE monitor_id='codex' AND key=${`public_v2:pending:${first.id}`}`).length, 0);
  if (operation === "update") {
    assert.equal(enrichmentInputs.at(-1)!.event.audienceZh, "所有用户");
    assert.equal(enrichmentInputs.at(-1)!.event.productsZh, "Codex");
    assert.equal("publicV2" in enrichmentInputs.at(-1)!.event, false);
  }
  if (operation === "receipt") assert.equal((await read()).events[0]!.status, "announced", "an account receipt cannot establish source-post completion");
  const [after] = await sql`SELECT created_at FROM monitor_events WHERE monitor_id='codex' AND id=${first.id}`;
  assert.equal(new Date(after!.created_at).toISOString(), first.publishedAt);
});

test("an admin correction cannot commit without its durable v2 task", async () => {
  variant = "reset";
  await inMonitor(codex, () => monitorTick());
  const first = (await read()).events[0]!;
  const [before] = await sql`SELECT * FROM monitor_events WHERE monitor_id='codex' AND id=${first.id}`;
  const [audits] = await sql`SELECT count(*)::int AS n FROM audit_log`;
  await sql`CREATE FUNCTION reject_v2_enqueue_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key LIKE 'public_v2:pending:%' THEN RAISE EXCEPTION 'Synthetic task persistence failure'; END IF; RETURN NEW; END $$`;
  await sql`CREATE TRIGGER reject_v2_enqueue_test BEFORE INSERT OR UPDATE ON monitor_state FOR EACH ROW EXECUTE FUNCTION reject_v2_enqueue_test()`;
  try {
    await assert.rejects(inMonitor(codex, () => updateMonitorEvent(first.id, {
      patch: { audienceZh: "Synthetic corrected audience" }, reason: "Synthetic transaction boundary", version: new Date(before!.updated_at).toISOString(),
    }, "synthetic-admin")), /Synthetic task persistence failure/);
  } finally {
    await sql`DROP TRIGGER reject_v2_enqueue_test ON monitor_state`; await sql`DROP FUNCTION reject_v2_enqueue_test()`;
  }
  assert.deepEqual((await sql`SELECT * FROM monitor_events WHERE monitor_id='codex' AND id=${first.id}`)[0], before);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, audits!.n);
  assert.deepEqual((await read()).events[0], first);
});

for (const restriction of ["audience", "plan", "product", "window"] as const) test(`enrichment cannot drop an accepted ${restriction} restriction`, async () => {
  variant = "reset";
  await inMonitor(codex, () => collectPosts()); await inMonitor(codex, () => processPending());
  const first = (await read()).events[0]!;
  const source = restriction === "audience" ? "We reset usage for paid users only."
    : restriction === "plan" ? "We reset usage for Pro subscribers only."
    : restriction === "product" ? "We reset Codex usage for all users."
    : "We reset the weekly quota for all users.";
  await sql`UPDATE monitor_posts SET text=${source} WHERE monitor_id='codex'`;
  if (restriction === "window") {
    await sql`UPDATE monitor_events SET presentation=presentation||'{"quotaScope":"weekly"}'::jsonb WHERE monitor_id='codex' AND id=${first.id}`;
  } else {
    const [before] = await sql`SELECT updated_at FROM monitor_events WHERE monitor_id='codex' AND id=${first.id}`;
    const patch = restriction === "audience" ? { audienceZh: "仅付费用户", scopeLabel: "paid users" }
      : restriction === "plan" ? { scope: "Pro", scopeLabel: "Pro" } : { productsZh: "Codex" };
    await inMonitor(codex, () => updateMonitorEvent(first.id, {
      patch, reason: "Synthetic accepted audience correction", version: new Date(before!.updated_at).toISOString(),
    }, "synthetic-admin"));
  }
  const [accepted] = await sql`SELECT scope,presentation FROM monitor_events WHERE monitor_id='codex' AND id=${first.id}`;
  badOutput = `scope-${restriction}`;
  assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 0, enrichmentPending: 1 });
  const [work] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${`public_v2:pending:${first.id}`}`;
  assert.equal(work!.value.status, "needs_review");
  assert.equal((await read()).events[0]!.summary, null, "a wider model scope must not become public");
  assert.deepEqual((await sql`SELECT scope,presentation FROM monitor_events WHERE monitor_id='codex' AND id=${first.id}`)[0], accepted);
  await inMonitor(codex, () => processPublicV2Pending());
  assert.equal(enrichmentCalls, 1, "the rejected scope is not purchased again without a new edit");
  badOutput = "";
  await inMonitor(codex, () => enqueuePublicV2(sql, [first.id]));
  assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 1 });
  const corrected = (await read()).events[0]!.scope;
  if (restriction === "audience") assert.equal(corrected.type, "paid_users");
  if (restriction === "plan") assert.deepEqual(corrected.planCodes, ["pro"]);
  if (restriction === "product") assert.deepEqual(corrected.productCodes, ["codex"]);
  if (restriction === "window") assert.deepEqual(corrected.quotaWindowCodes, ["weekly"]);
});

test("bonus enrichment keeps availability and precise deadlines after a conditional, date-only reminder", async () => {
  await inMonitor(claude, () => monitorTick());
  const original = (await read(claude)).events.find(event => event.type === "bonus_credit")!;
  const text = "If your credit has expired, your normal plan limits apply. You can still claim by Oct 17.";
  await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url,processed_at) VALUES
    ('claude','10199',${claude.authors[0]!.handle},${new Date(postAt.getTime() + 1000)},${text},'https://x.com/i/status/10199',now())`;
  await sql`INSERT INTO monitor_event_posts(monitor_id,event_id,post_id,stage,action,text,original_text) VALUES
    ('claude',${original.id},'10199','amend','amend',${text},${text})`;
  await inMonitor(claude, () => processPublicV2Pending());
  const event = (await read(claude)).events.find(event => event.id === original.id)!;
  assert.equal(event.status, "available");
  assert.deepEqual(event.bonusCredit!.claimDeadline, original.bonusCredit!.claimDeadline);
  assert.equal(event.publishedAt, original.publishedAt);
  const [row] = await sql`SELECT presentation FROM monitor_events WHERE monitor_id='claude' AND id=${original.id}`;
  assert.equal(row!.presentation.publicV2.status, "available");
  assert.deepEqual(row!.presentation.publicV2.bonusCredit.claimDeadline, original.bonusCredit!.claimDeadline);
});

test("worker-generated occurrence windows reach the API as ranges and are excluded from forecasts", async () => {
  variant = "reset";
  await inMonitor(codex, () => monitorTick());
  await sql`UPDATE monitor_posts SET text='We reset usage on Oct 14, 2026 at 10am–12pm PT for all users.' WHERE monitor_id='codex'`;
  badOutput = "range";
  await inMonitor(codex, () => processPublicV2Pending());
  const snapshot = resetSnapshotSchema.parse(await read());
  const expected = "2026-10-14T17:00:00Z/2026-10-14T19:00:00Z";
  assert.deepEqual(snapshot.events[0]!.time, expected);
  assert.equal(snapshot.resetTime, expected);
  assert.equal(snapshot.statistics.typicalInterval, null);
  assert.equal(snapshot.predictedResetTime, null);
});

test("first enrichment preserves the creation post's publication even when an earlier source is linked", async () => {
  variant = "reset";
  await inMonitor(codex, () => collectPosts()); await inMonitor(codex, () => processPending());
  const first = (await read()).events[0]!;
  await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url,processed_at) VALUES
    ('codex','9999',${codex.authors[0]!.handle},${new Date(postAt.getTime() - 86400_000)},'Synthetic earlier context.','https://x.com/i/status/9999',now())`;
  await sql`INSERT INTO monitor_event_posts(monitor_id,event_id,post_id,stage,action,text,original_text) VALUES
    ('codex',${first.id},'9999','context','amend','Synthetic earlier context.','Synthetic earlier context.')`;
  await inMonitor(codex, () => processPublicV2Pending());
  assert.equal((await read()).events[0]!.publishedAt, first.publishedAt);
});

for (const invalid of ["language", "quote", "code", "attribution", "time", "selected-note", "update-attribution", "update-missing", "update-duplicate", "update-unlinked"]) test(`invalid ${invalid} enrichment preserves accepted facts, advances the checkpoint and records a successful run`, async () => {
  variant = invalid === "time" ? "announce" : "reset"; badOutput = invalid;
  const result = await recordRun("monitor.tick", () => inMonitor(codex, () => monitorTick()));
  assert.ok("enrichmentPending" in result && result.enrichmentPending === 1);
  const [run] = await sql`SELECT status,detail FROM job_runs WHERE job='monitor.tick' ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.status, "ok"); assert.equal(run!.detail.enrichmentPending, 1);
  const [post] = await sql`SELECT processed_at FROM monitor_posts WHERE monitor_id='codex'`;
  assert.ok(post!.processed_at);
  const snapshot = await read(); assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0]!.summary, null);
  const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`;
  assert.ok(Date.parse(cursor!.value.scannedThrough) > Date.parse(since));
  const [work] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key LIKE 'public_v2:pending:%'`;
  assert.equal(work!.value.status, "needs_review");
  assert.equal(typeof work!.value.reason, "string");
  if (invalid === "time") {
    assert.equal(snapshot.events[0]!.status, "announced");
    assert.deepEqual(snapshot.events[0]!.time, postAt.toISOString());
  }
  const calls = enrichmentCalls;
  await inMonitor(codex, () => monitorTick());
  assert.equal(enrichmentCalls, calls, "the same invalid editorial version is not purchased again");
  badOutput = "";
  await inMonitor(codex, () => enqueuePublicV2(sql, [snapshot.events[0]!.id]));
  await inMonitor(codex, () => monitorTick());
  assert.equal(recognitionCalls, 1, "committed recognition is never repeated for enrichment failure");
  assert.equal((await read()).events[0]!.summary!.en, "Synthetic public business summary.");
});

test("a rejected event supplement does not prevent other accepted events from being enriched", async () => {
  badOutput = "first-quote";
  const result = await inMonitor(codex, () => monitorTick());
  assert.ok("enriched" in result && result.enriched === 2 && "enrichmentPending" in result && result.enrichmentPending === 1);
  const snapshot = resetSnapshotSchema.parse(await read());
  assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.events.find(event => event.type === "direct_reset")!.summary, null);
  assert.equal(snapshot.events.filter(event => event.summary !== null).length, 2);
  const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`;
  assert.ok(Date.parse(cursor!.value.scannedThrough) > Date.parse(since));
});

test("all platforms advance independently when only their supplemental validation needs review", async () => {
  variant = "reset"; badOutput = "quote";
  for (const def of definitions) {
    const result = await inMonitor(def, () => monitorTick());
    const snapshot = resetSnapshotSchema.parse(await read(def));
    assert.ok("enrichmentPending" in result && result.enrichmentPending === snapshot.events.length, JSON.stringify({ monitor: def.monitorId, result }));
    assert.ok(snapshot.events.length > 0);
    const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id=${def.monitorId} AND key='cursor:socialdata'`;
    assert.ok(Date.parse(cursor!.value.scannedThrough) > Date.parse(since));
    const [work] = await sql`SELECT value FROM monitor_state WHERE monitor_id=${def.monitorId} AND key LIKE 'public_v2:pending:%'`;
    assert.equal(work!.value.status, "needs_review");
  }
});

test("transport refusal still reports a failed round with the old checkpoint and can resume", async () => {
  variant = "reset"; badOutput = "transport";
  await assert.rejects(inMonitor(codex, () => monitorTick()));
  const [cursor] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`;
  assert.equal(cursor!.value.scannedThrough, since);
  const [work] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key LIKE 'public_v2:pending:%'`;
  assert.equal(work!.value.status, "failed");
  badOutput = "";
  await inMonitor(codex, () => monitorTick());
  assert.equal(recognitionCalls, 1);
  assert.equal((await read()).events[0]!.summary!.en, "Synthetic public business summary.");
});

test("a received model answer is reused when its business transaction fails", async () => {
  variant = "reset";
  await sql`CREATE FUNCTION reject_public_v2_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.presentation ? 'publicV2' THEN RAISE EXCEPTION 'Synthetic persistence failure'; END IF; RETURN NEW; END $$`;
  await sql`CREATE TRIGGER reject_public_v2_test BEFORE UPDATE ON monitor_events FOR EACH ROW EXECUTE FUNCTION reject_public_v2_test()`;
  try { await assert.rejects(inMonitor(codex, () => monitorTick()), /Synthetic persistence failure/); }
  finally { await sql`DROP TRIGGER reject_public_v2_test ON monitor_events`; await sql`DROP FUNCTION reject_public_v2_test()`; }
  assert.equal(enrichmentCalls, 1);
  assert.equal((await sql`SELECT status FROM receipts WHERE purpose LIKE '%.public_v2'`)[0]!.status, "received");
  await inMonitor(codex, () => monitorTick());
  assert.equal(enrichmentCalls, 1); assert.equal(recognitionCalls, 1);
  assert.equal((await sql`SELECT status FROM receipts WHERE purpose LIKE '%.public_v2'`)[0]!.status, "completed");
});

for (const invalid of ["language", "quote"]) test(`an invalid ${invalid} answer is reused if saving its review status fails`, async () => {
  variant = "reset"; badOutput = invalid;
  await sql`CREATE FUNCTION reject_v2_review_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key LIKE 'public_v2:pending:%' AND NEW.value->>'status'='needs_review' THEN RAISE EXCEPTION 'Synthetic review persistence failure'; END IF; RETURN NEW; END $$`;
  await sql`CREATE TRIGGER reject_v2_review_test BEFORE INSERT OR UPDATE ON monitor_state FOR EACH ROW EXECUTE FUNCTION reject_v2_review_test()`;
  try { await assert.rejects(inMonitor(codex, () => monitorTick()), /Synthetic review persistence failure/); }
  finally { await sql`DROP TRIGGER reject_v2_review_test ON monitor_state`; await sql`DROP FUNCTION reject_v2_review_test()`; }
  assert.equal(enrichmentCalls, 1); assert.equal(recognitionCalls, 1);
  const [receipt] = await sql`SELECT id,status,response,attempts FROM receipts WHERE purpose LIKE '%.public_v2'`;
  assert.equal(receipt!.status, "received", "rejecting the answer must roll back with its failed review write");
  assert.equal(receipt!.attempts, 1); assert.ok(receipt!.response);
  const [pending] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key LIKE 'public_v2:pending:%'`;
  assert.equal(pending!.value.status, "pending");
  assert.equal((await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`)[0]!.value.scannedThrough, since);
  badOutput = "";
  const resumed = await inMonitor(codex, () => monitorTick());
  assert.ok("enrichmentPending" in resumed && resumed.enrichmentPending === 1, "recovery validates the saved invalid answer");
  assert.equal(enrichmentCalls, 1); assert.equal(recognitionCalls, 1);
  const [saved] = await sql`SELECT status,response,attempts FROM receipts WHERE id=${receipt!.id}`;
  assert.equal(saved!.status, "failed"); assert.equal(saved!.attempts, 1); assert.deepEqual(saved!.response, receipt!.response);
  const [review] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key LIKE 'public_v2:pending:%'`;
  assert.equal(review!.value.status, "needs_review"); assert.equal(review!.value.receiptId, receipt!.id);
  assert.equal((await read()).events[0]!.summary, null);
  await inMonitor(codex, () => monitorTick());
  assert.equal(enrichmentCalls, 1); assert.equal(recognitionCalls, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${receipt!.id}`)[0]!.n, 1);
});

test("an interrupted recognition commit also resumes from its saved paid response", async () => {
  variant = "reset";
  await sql`CREATE FUNCTION reject_recognition_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.recognition IS NOT NULL THEN RAISE EXCEPTION 'Synthetic recognition commit failure'; END IF; RETURN NEW; END $$`;
  await sql`CREATE TRIGGER reject_recognition_test BEFORE UPDATE ON monitor_posts FOR EACH ROW EXECUTE FUNCTION reject_recognition_test()`;
  try { await assert.rejects(inMonitor(codex, () => monitorTick()), /Synthetic recognition commit failure/); }
  finally { await sql`DROP TRIGGER reject_recognition_test ON monitor_posts`; await sql`DROP FUNCTION reject_recognition_test()`; }
  assert.equal(recognitionCalls, 1); assert.equal(enrichmentCalls, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_events`)[0]!.n, 0);
  await inMonitor(codex, () => monitorTick());
  assert.equal(recognitionCalls, 1); assert.equal(enrichmentCalls, 1);
  assert.equal((await read()).events.length, 1);
});

test("unknown billing on an enrichment receipt blocks automatic re-purchase", async () => {
  variant = "reset"; badOutput = "transport";
  await assert.rejects(inMonitor(codex, () => monitorTick()));
  const [receipt] = await sql`SELECT id FROM receipts WHERE purpose LIKE '%.public_v2'`;
  await sql`UPDATE receipts SET status='unknown' WHERE id=${receipt!.id}`;
  await sql`UPDATE receipt_attempts SET status='unknown' WHERE receipt_id=${receipt!.id}`;
  const calls = model.hits(); badOutput = "";
  await assert.rejects(inMonitor(codex, () => monitorTick()));
  assert.equal(model.hits(), calls); assert.equal((await read()).events[0]!.summary, null);
});

test("concurrent fact edits reject stale enrichment and changed evidence can be regenerated", async () => {
  variant = "reset"; conflict = true;
  const result = await inMonitor(codex, () => monitorTick());
  assert.ok("enrichmentPending" in result && result.enrichmentPending === 1);
  assert.equal((await read()).events[0]!.summary, null);
  await inMonitor(codex, () => monitorTick());
  const first = (await read()).events[0]!;
  await sql`UPDATE monitor_events SET title='Synthetic admin correction',updated_at=now() WHERE monitor_id='codex' AND id=${first.id}`;
  assert.equal((await read()).events[0]!.summary, null, "stale business content stops being public immediately");
  await inMonitor(codex, () => monitorTick());
  const last = (await read()).events[0]!;
  assert.equal(last.summary!.en, "Synthetic public business summary.");
  assert.equal(last.publishedAt, first.publishedAt);
  assert.equal(enrichmentCalls, 3);
});

test("enrichment does not alter v1, receipt-review completion, and seven-language outputs stay private until validated", async () => {
  variant = "reset";
  await inMonitor(codex, () => collectPosts());
  await inMonitor(codex, () => processPending());
  const now = Date.now();
  const before = await inMonitor(codex, async () => ({ snapshot: await resetsSnapshot(now), version: await resetVersion(now) }));
  await inMonitor(codex, () => processPublicV2Pending());
  assert.deepEqual(await inMonitor(codex, async () => ({ snapshot: await resetsSnapshot(now), version: await resetVersion(now) })), before);
  const event = (await read()).events[0]!;
  await sql`UPDATE monitor_events SET confirmation_basis='receipt_review' WHERE monitor_id='codex' AND id=${event.id}`;
  await inMonitor(codex, () => processPublicV2Pending());
  assert.equal((await read()).events[0]!.status, "announced");
});

test("model or collection valves stop the complete automatic round without paid requests or checkpoint changes", async () => {
  const calls = model.hits(), collections = provider.hits();
  for (const valve of ["model", "collection"]) {
    config.modelCallsEnabled = valve !== "model"; process.env.COLLECT_ENABLED = valve === "collection" ? "false" : "true";
    assert.deepEqual(await inMonitor(codex, () => monitorTick()), { skipped: true, reason: "automatic_processing_disabled" });
    assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 0 });
  }
  assert.equal(model.hits(), calls); assert.equal(provider.hits(), collections);
  assert.equal((await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`)[0]!.value.scannedThrough, since);
});
