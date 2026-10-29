import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { beforeEach, after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { Conflict } from "@aihot/backend/audit";
import { installModules } from "@aihot/backend/modules";
import { buildApp } from "../../../apps/api/src/app.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { inMonitor } from "../backend/context.ts";
import { createMonitorPost, updateMonitorPost, listMonitorPosts } from "../backend/admin.ts";
import { sourcePost, storeCollectedPost, loadActionInput, writePostActions } from "../backend/action-store.ts";
import { properName } from "../backend/public-v2.ts";

const definitions = [codex, claude, grok], at = "2026-10-20T08:00:00Z";
const previousAdmin = config.devAdmin;
beforeEach(async () => {
  config.devAdmin = null; installModules(definitions.map(createMonitorServer));
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`;
});
after(async () => { config.devAdmin = previousAdmin; installModules([]); await closeDb(); });
const body = (definition = codex) => ({ author: definition.authors[0]!.handle, publishedAt: at,
  url: `https://x.com/${definition.authors[0]!.handle}/status/1234567890`, title: { zh: "人工帖子" }, summary: { zh: "人工摘要" }, text: "Private original post text" });

for (const definition of definitions) test(`${definition.monitorId}: manual posts are processed source records without recognition or publication side effects`, async () => inMonitor(definition, async () => {
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${definition.monitorId},'watermark:test','{"scan":"unchanged"}'::jsonb)`;
  const states = await sql`SELECT monitor_id,key,value FROM monitor_state ORDER BY monitor_id,key`;
  const receipts = await sql`SELECT id FROM receipts ORDER BY id`;
  const notifications = await sql`SELECT id FROM monitor_webhook_notifications ORDER BY id`;
  const post = await createMonitorPost(body(definition), "manual-admin");
  assert.equal(post.id, "1234567890"); assert.equal(post.processingStatus, "processed"); assert.equal(post.filteredOut, false);
  assert.equal(post.publishedAt, "2026-10-20T08:00:00.000Z"); assert.equal(post.actionCount, 0); assert.deepEqual(post.events, []);
  assert.ok(post.version); assert.equal("text" in post, false);
  const stored = (await sourcePost(post.id))!;
  assert.equal(stored.text, body(definition).text); assert.equal(stored.author, definition.authors[0]!.handle);
  assert.equal(stored.source_receipt_id, null); assert.equal(stored.model_receipt_id, null); assert.equal(stored.quoted_post, null); assert.equal(stored.reply_to, null); assert.equal(stored.review_reason, null);
  const input = await loadActionInput(); assert.equal(input.events.length, 0); assert.equal(input.actions.length, 0); assert.equal(input.posts.length, 1);
  assert.equal((await listMonitorPosts()).rows[0]!.id, post.id);
  assert.deepEqual(await sql`SELECT monitor_id,key,value FROM monitor_state ORDER BY monitor_id,key`, states);
  assert.deepEqual(await sql`SELECT id FROM receipts ORDER BY id`, receipts);
  assert.deepEqual(await sql`SELECT id FROM monitor_webhook_notifications ORDER BY id`, notifications);
  const audit = await sql`SELECT actor,action,before,after FROM audit_log`;
  assert.equal(audit[0]!.actor, "manual-admin"); assert.equal(audit[0]!.action, `${definition.names.auditActionPrefix}.create-post`);
  assert.equal(JSON.stringify(audit).includes(body(definition).text), false);
}));

test("duplicate X variants, collected records, and normalized links conflict without overwriting", async () => {
  await inMonitor(codex, async () => {
    const first = await createMonitorPost(body(), "manual-admin");
    for (const url of ["https://twitter.com/another/status/1234567890?utm_source=share", "https://mobile.x.com/thsottiaux/statuses/1234567890/photo/1"]) {
      await assert.rejects(createMonitorPost({ ...body(), url, title: { zh: "不能覆盖" } }, "manual-admin"), Conflict);
    }
    assert.equal((await sourcePost(first.id))!.title!.zh, "人工帖子");
    const url = "https://example.test/a?utm_source=share#fragment";
    const generic = await createMonitorPost({ ...body(), url }, "manual-admin");
    assert.match(generic.id, /^manual-[a-f0-9]{64}$/);
    await assert.rejects(createMonitorPost({ ...body(), url: "http://www.example.test/a" }, "manual-admin"), /已存在/);
    await storeCollectedPost({ id: "9988776655", author: codex.authors[0]!.handle, publishedAt: at, url: `https://x.com/${codex.authors[0]!.handle}/status/9988776655`, receiptId: null });
    await assert.rejects(createMonitorPost({ ...body(), url: "https://twitter.com/i/status/9988776655" }, "manual-admin"), /已存在/);
  });
  await inMonitor(claude, async () => {
    const post = await createMonitorPost(body(claude), "manual-admin"); assert.equal(post.id, "1234567890");
  });
});

test("post editing preserves source identity, original evidence, recognition state and action relationships", async () => inMonitor(codex, async () => {
  const post = await createMonitorPost(body(), "manual-admin");
  await sql.begin(async db => writePostActions(db, (await sourcePost(post.id, db))!, [{ eventId: "event", action: "confirm", title: properName("Official confirmation"), summary: null, time: at }], { events: [{ id: "event", type: "direct_reset" }] }));
  await sql`UPDATE monitor_source_posts SET processing_status='failed',review_reason='Keep the failure reason',filtered_out=true,quoted_post=${sql.json({ id: "quote", author: "other", relation: "quote", text: "Private quoted source", publishedAt: at, url: "https://example.test/quote" })} WHERE monitor_id='codex' AND id=${post.id}`;
  const input = await loadActionInput(), before = (await sourcePost(post.id))!;
  const after = await updateMonitorPost(post.id, { version: before.version, patch: { title: { zh: "更正标题" }, summary: null } }, "manual-editor");
  assert.equal(after!.title!.zh, "更正标题"); assert.equal(after!.summary, null); assert.equal(after!.processingStatus, "failed"); assert.equal(after!.reviewReason, "Keep the failure reason"); assert.equal(after!.filteredOut, true);
  const stored = (await sourcePost(post.id))!;
  for (const field of ["author", "published_at", "url", "text", "processing_status", "review_reason", "filtered_out", "source_receipt_id", "model_receipt_id", "quoted_post", "reply_to"] as const) assert.deepEqual(stored[field], before[field]);
  assert.deepEqual((await loadActionInput()).actions, input.actions); assert.deepEqual((await loadActionInput()).events, input.events);
  await assert.rejects(updateMonitorPost(post.id, { version: before.version, patch: { summary: { zh: "过期编辑" } } }, "manual-editor"), /已变化/);
  assert.equal(await updateMonitorPost("missing", { version: "missing", patch: { summary: null } }, "manual-editor"), null);
  const audits = JSON.stringify(await sql`SELECT before,after FROM audit_log`);
  assert.equal(audits.includes("Private original post text"), false); assert.equal(audits.includes("Private quoted source"), false);
}));

test("manual post validation rejects unconfigured authors, missing times, unsafe URLs and business mutations", async () => inMonitor(codex, async () => {
  for (const change of [{ author: "not-configured" }, { publishedAt: "2026-10-20T08:00:00" }, { publishedAt: "" }, { url: "javascript:alert(1)" }, { url: "https://user:password@example.test/post" }, { title: { en: "Missing Chinese" } }, { title: { zh: "   " } }, { processingStatus: "pending" }, { events: [] }, { monitorId: "grok" }, { sourceReceiptId: 1 }]) {
    await assert.rejects(createMonitorPost({ ...body(), ...change }, "manual-admin"));
  }
  const post = await createMonitorPost(body(), "manual-admin");
  for (const patch of [{ author: "other" }, { text: "changed" }, { publishedAt: at }, { url: "https://example.test/changed" }, { processingStatus: "processed" }, { sources: [] }, {}]) await assert.rejects(updateMonitorPost(post.id, { version: post.version, patch }, "manual-admin"));
  assert.equal((await loadActionInput()).posts.length, 1);
}));

test("post creation and content updates require administrator CSRF and return isolated versions", async () => {
  const app = await buildApp();
  try {
    for (const definition of definitions) {
      assert.equal((await app.inject({ method: "POST", url: `${definition.adminApiPath}/posts`, payload: body(definition) })).statusCode, 401);
    }
    config.devAdmin = { displayName: "Manual post editor" };
    for (const definition of definitions) {
      const url = `${definition.adminApiPath}/posts`;
      assert.equal((await app.inject({ method: "POST", url, payload: body(definition) })).statusCode, 403);
      const created = await app.inject({ method: "POST", url, payload: body(definition), headers: { "x-csrf-token": "dev" } });
      assert.equal(created.statusCode, 201, created.body); const post = created.json();
      const payload = { version: post.version, patch: { title: { zh: "编辑后标题" } } };
      assert.equal((await app.inject({ method: "PATCH", url: `${url}/${post.id}`, payload })).statusCode, 403);
      const edited = await app.inject({ method: "PATCH", url: `${url}/${post.id}`, payload, headers: { "x-csrf-token": "dev" } });
      assert.equal(edited.statusCode, 200, edited.body); assert.equal(edited.json().title.zh, "编辑后标题");
      assert.equal((await app.inject({ method: "PATCH", url: `${url}/${post.id}`, payload, headers: { "x-csrf-token": "dev" } })).statusCode, 409);
    }
    assert.equal((await sql`SELECT id FROM monitor_event_actions`).length, 0); assert.equal((await sql`SELECT id FROM monitor_event_records`).length, 0);
  } finally { await app.close(); }
});
