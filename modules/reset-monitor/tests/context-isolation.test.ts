import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { inMonitor } from "../backend/context.ts";
import { listMonitorPosts, listMonitorEntries, updateMonitorPost } from "../backend/admin.ts";
import { monitorPostDetail, monitorEventDetail, previewMonitorReview, previewMonitorEventReview } from "../backend/manual-review.ts";
import { loadActionInput, sourcePost, storeCollectedPost, validateActionSources, writePostActions } from "../backend/action-store.ts";
import { properName, projectPublicV2 } from "../backend/public-v2.ts";
import { exportPublicV2, previewPublicV2 } from "../backend/public-v2-review.ts";
import { processPublicV2Pending } from "../backend/public-v2-generate.ts";

const parentId = "900", sourceId = "1000";
const parentAt = "2026-10-28T01:00:00Z", sourceAt = "2026-10-28T02:00:00Z";
const original = "Read-only parent context, never an independent business source";
const model = await stub(() => ({ choices: [{ message: { content: "{}" } }] }));
Object.assign(process.env, { MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "synthetic", LLM_MODEL: "synthetic-context-isolation" });
const previousModels = config.modelCallsEnabled;
installModules([createMonitorServer(codex)]);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`; await sql`DELETE FROM receipts`;
  config.modelCallsEnabled = true;
});
after(async () => { config.modelCallsEnabled = previousModels; installModules([]); await model.close(); await closeDb(); });

async function seed(withEvent = false) {
  await storeCollectedPost({ id: parentId, author: codex.authors[0].handle, publishedAt: parentAt,
    url: `https://x.com/${codex.authors[0].handle}/status/${parentId}`, text: original, receiptId: null, contextOnly: true });
  await storeCollectedPost({ id: sourceId, author: codex.authors[0].handle, publishedAt: sourceAt,
    url: `https://x.com/${codex.authors[0].handle}/status/${sourceId}`, text: "We will reset usage", receiptId: null,
    replyTo: { postId: parentId, author: null } });
  await sql`UPDATE monitor_source_posts SET title=${sql.json(properName("Business source"))},processing_status='processed' WHERE monitor_id='codex' AND id=${sourceId}`;
  await sql`UPDATE monitor_source_posts SET title='{"zh":"只有中文的上下文标题"}'::jsonb WHERE monitor_id='codex' AND id=${parentId}`;
  if (withEvent) await sql.begin(async db => writePostActions(db, (await sourcePost(sourceId, db))!,
    [{ eventId: "isolation-event", action: "announce", title: properName("Reset announcement"), summary: null, time: sourceAt }],
    { events: [{ id: "isolation-event", type: "direct_reset" }] }));
}

test("context-only rows are absent from every business post list and review options", async () => inMonitor(codex, async () => {
  await seed();
  for (const collectionFilter of ["normal", "filtered", "all"]) {
    const posts = await listMonitorPosts({ collectionFilter });
    assert.equal(posts.rows.some(post => post.id === parentId), false);
  }
  const posts = await listMonitorPosts({ collectionFilter: "all" });
  assert.equal(posts.total, 1); assert.deepEqual(posts.rows.map(post => post.id), [sourceId]);
  const entries = await listMonitorEntries({ kind: "posts", collectionFilter: "all" });
  assert.equal(entries.total, 1); assert.deepEqual(entries.rows.map(row => row.kind === "post" ? row.post.id : null), [sourceId]);
  const detail = (await monitorPostDetail(sourceId))!;
  assert.equal(detail.options.posts.some(post => post.id === parentId), false);
  assert.equal(detail.posts.some(post => post.id === parentId), false);
  assert.equal(await monitorPostDetail(parentId), null);
  assert.equal(await previewMonitorReview(parentId, { version: (await sourcePost(parentId))!.version, reason: "Verify context boundary", post: { title: { zh: "不能复核上下文" } } }), null);
}));

test("a business post exposes its parent only as read-only context and cannot edit that record", async () => inMonitor(codex, async () => {
  await seed();
  const detail = (await monitorPostDetail(sourceId))!, before = (await sourcePost(parentId))!;
  assert.equal(detail.context!.length, 1); assert.equal(detail.context![0].id, parentId); assert.equal(detail.context![0].text, original);
  const edited = await updateMonitorPost(parentId, { version: before.version, patch: { title: { zh: "不应保存" } } }, "reviewer");
  assert.equal(edited, null); assert.deepEqual(await sourcePost(parentId), before);
  const audits = await sql`SELECT id FROM audit_log WHERE action LIKE '%update-post'`;
  assert.equal(audits.length, 0);
}));

test("forged context-only source additions are rejected even with its current expected version", async () => inMonitor(codex, async () => {
  await seed(true);
  const detail = (await monitorEventDetail("isolation-event"))!, parent = (await sourcePost(parentId))!;
  assert.equal(detail.options.posts.some(post => post.id === parentId), false);
  const versions = { ...detail.versions, posts: { ...detail.versions.posts, [parentId]: parent.version } };
  await assert.rejects(previewMonitorEventReview("isolation-event", {
    version: detail.version, versions, reason: "Attempt to add context as evidence",
    sources: { add: [{ actionId: detail.actions[0].id, postId: parentId }] },
  }), /辅助上下文/);
  const input = await loadActionInput();
  assert.deepEqual(input.actions[0].sources, [{ postId: sourceId }]);
}));

test("source validation refuses a context-only row even when its author is an official configured account", async () => inMonitor(codex, async () => {
  await seed();
  await validateActionSources(sql, [{ id: "valid", action: "announce", time: null, sources: [{ postId: sourceId }] }]);
  for (const sources of [[{ postId: parentId }], [{ postId: sourceId }, { postId: parentId }]]) {
    await assert.rejects(validateActionSources(sql, [{ id: "invalid", action: "announce", time: null, sources }]), /来源/);
  }
}));

test("public projection cannot expose context-only evidence from polluted action input", async () => inMonitor(codex, async () => {
  await seed(true);
  const input = await loadActionInput(), action = input.actions[0];
  const poisoned = structuredClone(input);
  poisoned.actions[0].sources = [{ postId: parentId }];
  assert.equal(projectPublicV2(poisoned, codex).events.length, 0);
  action.sources.push({ postId: parentId });
  const snapshot = projectPublicV2(input, codex);
  assert.equal(snapshot.events.length, 1);
  assert.deepEqual(snapshot.events[0].updates[0].sources.map(source => source.postId), [sourceId]);
  assert.equal(JSON.stringify(snapshot).includes(original), false);
}));

test("editorial export omits context-only posts and forged import cannot modify one", async () => inMonitor(codex, async () => {
  await seed();
  const bundle = await exportPublicV2([codex]);
  assert.deepEqual(bundle.monitors[0].reviews.filter(review => review.kind === "post").map(review => review.id), [sourceId]);
  const parent = (await sourcePost(parentId))!;
  await assert.rejects(previewPublicV2({ schemaVersion: 2, monitors: [{ monitorId: "codex", reviews: [{
    kind: "post", id: parentId, expectedVersion: parent.version, editorial: { title: { zh: "不能导入" }, summary: null },
  }] }] }, [codex]), /changed/);
  assert.equal((await sourcePost(parentId))!.title!.zh, "只有中文的上下文标题");
}));

test("independent translation never calls a model for partial-language context-only titles", async () => inMonitor(codex, async () => {
  await seed();
  const beforeHits = model.hits(), before = await sql`SELECT id FROM receipts`;
  const result = await processPublicV2Pending();
  assert.equal(result.enriched, 0); assert.equal(model.hits(), beforeHits);
  assert.deepEqual(await sql`SELECT id FROM receipts`, before);
  const parent = (await sourcePost(parentId))!;
  assert.deepEqual(parent.title, { zh: "只有中文的上下文标题" });
  assert.equal(parent.model_receipt_id, null); assert.equal(parent.text, original);
}));
