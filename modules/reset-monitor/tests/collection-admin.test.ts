import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { buildApp } from "../../../apps/api/src/app.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { createMonitorServer } from "../server.ts";
import { storeCollectedPost, sourcePost, saveAcceptedPost, writePostActions, loadActionInput, markPostReview, markPostFailure } from "../backend/action-store.ts";
import { listMonitorEntries, listMonitorPosts } from "../backend/admin.ts";
import { monitorPostDetail, monitorEventDetail, previewMonitorReview, submitMonitorReview, previewMonitorEventReview, submitMonitorEventReview } from "../backend/manual-review.ts";
import { properName } from "../backend/public-v2.ts";

after(async () => { installModules([]); await closeDb(); });
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`;
});
const at = "2026-10-20T12:00:00Z";
async function receipt() {
  const [row] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,response) VALUES(${randomUUID()},'synthetic','reset_monitor.codex.recognize','synthetic','received','{}'::jsonb) RETURNING id`;
  return row!.id;
}
async function post(id: string, filteredOut = false, status = "processed") {
  const receiptId = await receipt();
  await storeCollectedPost({ id, author: codex.authors[0]!.handle, publishedAt: at, url: `https://example.test/${id}`, text: `Private body ${id}`, receiptId });
  await sql`UPDATE monitor_source_posts SET title=${sql.json(properName(id))},filtered_out=${filteredOut},processing_status=${status} WHERE monitor_id=${codex.monitorId} AND id=${id}`;
  return sourcePost(id);
}
async function review(id: string, commands: Record<string, unknown>) {
  const detail = (await monitorPostDetail(id))!;
  const body = { version: detail.version, versions: detail.versions, reason: "Verify collection record", ...commands };
  const preview = (await previewMonitorReview(id, body))!;
  await submitMonitorReview(id, { ...body, previewToken: preview.previewToken }, "reviewer");
  return preview;
}

test("stored source defaults preserve old posts while replies retain only supplied target metadata", async () => inMonitor(codex, async () => {
  const root = (await post("root"))!;
  assert.equal(root.reply_to, null); assert.equal(root.filtered_out, false);
  await storeCollectedPost({ id: "reply", author: codex.authors[0]!.handle, publishedAt: at, url: "https://example.test/reply", receiptId: await receipt(), replyTo: { postId: "root", author: null } });
  const reply = (await sourcePost("reply"))!;
  assert.deepEqual(reply.reply_to, { postId: "root", author: null });
  const detail = (await monitorPostDetail("reply"))!;
  assert.deepEqual(detail.post!.replyTo, reply.reply_to); assert.equal(detail.post!.filteredOut, false);
  await storeCollectedPost({ id: "unknown-reply", author: codex.authors[0]!.handle, publishedAt: at, url: "https://example.test/unknown", receiptId: await receipt(), replyTo: { postId: null, author: null } });
  assert.deepEqual((await sourcePost("unknown-reply"))!.reply_to, { postId: null, author: null });
  await inMonitor(claude, async () => assert.equal(await sourcePost("reply"), null));
}));

test("collection filters hide only unbound filtered records and keep pagination totals consistent", async () => inMonitor(codex, async () => {
  for (let index = 0; index < 12; index++) await post(`filtered-${index}`, true);
  await post("normal"); await post("attention", false, "needs_attention");
  const source = (await post("linked", true))!;
  await sql.begin(db => writePostActions(db, source, [{ eventId: "event", action: "confirm", title: properName("Confirmed"), summary: null, time: null }], { events: [{ id: "event", type: "bonus_credit" }] }));
  assert.equal((await sourcePost("linked"))!.filtered_out, false);
  assert.equal((await listMonitorEntries()).total, 3);
  const first = await listMonitorEntries({ collectionFilter: "filtered" }), second = await listMonitorEntries({ collectionFilter: "filtered", page: 2 });
  assert.equal(first.total, 12); assert.equal(first.totalPages, 2); assert.equal(first.rows.length, 10); assert.equal(second.rows.length, 2);
  assert.ok(first.rows.every(row => row.kind === "post" && row.post.filteredOut));
  assert.equal((await listMonitorEntries({ collectionFilter: "all" })).total, 15);
  assert.equal((await listMonitorEntries({ collectionFilter: "filtered", kind: "events" })).total, 0);
  assert.equal((await listMonitorPosts()).total, 3);
  assert.equal((await listMonitorPosts({ collectionFilter: "filtered" })).total, 12);
  assert.deepEqual((await listMonitorPosts({ association: "linked" })).rows.map(row => row.id), ["linked"]);
  assert.equal((await listMonitorPosts({ association: "unlinked" })).total, 2);
  const unlinked = await listMonitorPosts({ association: "unlinked", collectionFilter: "all", page: 2 });
  assert.equal(unlinked.total, 14); assert.equal(unlinked.totalPages, 2); assert.equal(unlinked.rows.length, 4);
  assert.ok(unlinked.rows.every(row => row.events.length === 0));
  assert.equal((await listMonitorPosts({ association: "linked", from: "2026-10-21" })).total, 0);
  assert.equal((await listMonitorPosts({ association: "linked", from: "2026-10-20", to: "2026-10-20" })).total, 1);
  await assert.rejects(listMonitorPosts({ association: "invalid" }));
  assert.equal((await listMonitorEntries({ collectionFilter: "filtered", q: "filtered-11" })).total, 1);
  assert.equal((await listMonitorEntries({ collectionFilter: "normal", filter: "needs_attention" })).total, 1);
  await assert.rejects(listMonitorEntries({ collectionFilter: "invalid" }));
  await assert.rejects(listMonitorPosts({ collectionFilter: "invalid" }));
}));

test("explicit retention clears only filtering and ordinary editorial changes preserve the filter", async () => inMonitor(codex, async () => {
  await post("filtered", true, "needs_attention");
  const before = (await sourcePost("filtered"))!;
  await review("filtered", { post: { title: { zh: "Updated title" } } });
  assert.equal((await sourcePost("filtered"))!.filtered_out, true);
  const preview = await review("filtered", { keepPost: true });
  assert.equal(preview.postChange!.before.filteredOut, true); assert.equal(preview.postChange!.after.filteredOut, false);
  const kept = (await sourcePost("filtered"))!;
  assert.equal(kept.filtered_out, false); assert.equal(kept.processing_status, before.processing_status); assert.equal(kept.review_reason, before.review_reason);
  assert.equal(kept.text, before.text); assert.deepEqual(kept.reply_to, before.reply_to);
  const audit = JSON.stringify(await sql`SELECT before,after FROM audit_log`);
  assert.equal(audit.includes("Private body"), false);
  const detail = (await monitorPostDetail("filtered"))!;
  await assert.rejects(previewMonitorReview("filtered", { version: detail.version, reason: "Invalid command", keepPost: false }));
}));

test("manual source association clears filters without changing recognition status", async () => inMonitor(codex, async () => {
  const first = (await post("initial"))!;
  await sql.begin(db => writePostActions(db, first, [{ eventId: "event", action: "confirm", title: properName("Confirmed"), summary: null, time: null }], { events: [{ id: "event", type: "direct_reset" }] }));
  const action = (await loadActionInput()).actions[0]!;
  await post("filtered", true, "failed");
  await review("filtered", { sources: { add: [{ actionId: action.id, postId: "filtered" }] } });
  const kept = (await sourcePost("filtered"))!;
  assert.equal(kept.filtered_out, false); assert.equal(kept.processing_status, "failed");
  const detail = (await monitorEventDetail("event"))!;
  await assert.rejects(previewMonitorEventReview("event", { version: detail.version, reason: "Wrong origin", keepPost: true }), /只有帖子/);
  await post("event-source", true, "needs_attention");
  const eventDetail = (await monitorEventDetail("event"))!;
  const command = { version: eventDetail.version, versions: eventDetail.versions, reason: "Verify event source retention", sources: { add: [{ actionId: action.id, postId: "event-source" }] } };
  const preview = (await previewMonitorEventReview("event", command))!;
  await submitMonitorEventReview("event", { ...command, previewToken: preview.previewToken }, "reviewer");
  const eventSource = (await sourcePost("event-source"))!;
  assert.equal(eventSource.filtered_out, false); assert.equal(eventSource.processing_status, "needs_attention");
}));

test("retention previews detect concurrent changes and stale recognition cannot hide a retained post", async () => inMonitor(codex, async () => {
  const original = (await post("filtered", true, "pending"))!;
  const detail = (await monitorPostDetail(original.id))!;
  const command = { version: detail.version, versions: detail.versions, reason: "Keep explicit record", keepPost: true };
  const preview = (await previewMonitorReview(original.id, command))!;
  await sql`UPDATE monitor_source_posts SET summary='{"zh":"Concurrent edit"}'::jsonb WHERE monitor_id='codex' AND id=${original.id}`;
  await assert.rejects(submitMonitorReview(original.id, { ...command, previewToken: preview.previewToken }, "reviewer"), /已变化/);
  await review(original.id, { keepPost: true });
  await assert.rejects(saveAcceptedPost(original.id, { title: properName("Stale result"), summary: null, actions: [], receiptId: await receipt(), expectedVersion: original.version, filteredOut: true }), /帖子已变化/);
  assert.equal((await sourcePost(original.id))!.filtered_out, false);
}));

test("recognized unrelated posts can be hidden but existing or new action sources cannot", async () => inMonitor(codex, async () => {
  const hidden = (await post("unrelated", false, "pending"))!;
  await saveAcceptedPost(hidden.id, { title: properName("Unrelated"), summary: null, actions: [], receiptId: await receipt(), expectedVersion: hidden.version, filteredOut: true });
  assert.equal((await sourcePost(hidden.id))!.filtered_out, true);
  const accepted = (await post("accepted", false, "pending"))!;
  await saveAcceptedPost(accepted.id, { title: properName("Accepted"), summary: null, actions: [{ eventId: "event", action: "confirm", title: properName("Confirmed"), summary: null, time: null }], events: [{ id: "event", type: "reset_credit" }], receiptId: await receipt(), expectedVersion: accepted.version, filteredOut: true });
  assert.equal((await sourcePost(accepted.id))!.filtered_out, false);
  await sql`UPDATE monitor_source_posts SET processing_status='pending' WHERE monitor_id='codex' AND id=${accepted.id}`;
  const again = (await sourcePost(accepted.id))!;
  await saveAcceptedPost(again.id, { title: properName("No new fact"), summary: null, actions: [], receiptId: await receipt(), expectedVersion: again.version, filteredOut: true });
  assert.equal((await sourcePost(again.id))!.filtered_out, false);
}));

test("accepted attention and failure clear filtering while stale work cannot change it", async () => inMonitor(codex, async () => {
  for (const kind of ["attention", "failure"] as const) {
    const pending = (await post(kind, true, "pending"))!;
    const mark = kind === "attention" ? () => markPostReview(kind, "Evidence missing", pending.version) : () => markPostFailure(kind, pending.version);
    assert.equal(await mark(), true); assert.equal((await sourcePost(kind))!.filtered_out, false);
    await sql`UPDATE monitor_source_posts SET filtered_out=true WHERE monitor_id='codex' AND id=${kind}`;
    assert.equal(await mark(), false); assert.equal((await sourcePost(kind))!.filtered_out, true);
  }
}));

test("review text is saved with its status while absent content preserves existing editorial fields", async () => inMonitor(codex, async () => {
  await post("no-content", false, "pending");
  const summary = properName("Saved summary");
  await sql`UPDATE monitor_source_posts SET summary=${sql.json(summary)} WHERE monitor_id='codex' AND id='no-content'`;
  const before = (await sourcePost("no-content"))!;
  assert.equal(await markPostReview(before.id, "Missing source context", before.version), true);
  const preserved = (await sourcePost(before.id))!;
  assert.deepEqual(preserved.title, before.title); assert.deepEqual(preserved.summary, summary);
  assert.equal(preserved.processing_status, "needs_attention");

  await post("with-content", true, "pending");
  await sql`UPDATE monitor_source_posts SET summary=${sql.json(summary)} WHERE monitor_id='codex' AND id='with-content'`;
  const pending = (await sourcePost("with-content"))!, title = properName("Recognized review title");
  const receiptId = await receipt();
  await sql.begin(async db => {
    assert.equal(await markPostReview(pending.id, "Verify action", pending.version, receiptId, db, { title, summary: null }), true);
  });
  const saved = (await sourcePost(pending.id))!;
  assert.deepEqual(saved.title, title); assert.equal(saved.summary, null);
  assert.equal(saved.processing_status, "needs_attention"); assert.equal(saved.model_receipt_id, receiptId); assert.equal(saved.filtered_out, false);
  const listed = (await listMonitorPosts({ filter: "needs_attention" })).rows.find(row => row.id === pending.id)!;
  assert.deepEqual(listed.title, title); assert.equal(listed.summary, null);

  const outdated = { title: properName("Outdated model title"), summary: properName("Outdated summary") };
  assert.equal(await markPostReview(pending.id, "Stale work", pending.version, receiptId, sql, outdated), false);
  assert.deepEqual((await sourcePost(pending.id))!.title, title);
  assert.equal((await sourcePost(pending.id))!.summary, null);
}));

test("admin HTTP accepts collection filters and returns reply metadata without exposing originals", async () => {
  installModules([createMonitorServer(codex)]);
  await inMonitor(codex, async () => { await post("normal"); await post("filtered", true); });
  const previous = config.devAdmin; config.devAdmin = { displayName: "Collection reviewer" };
  const app = await buildApp();
  try {
    const normal = await app.inject(codex.adminApiPath + "/entries");
    assert.equal(normal.statusCode, 200); assert.equal(normal.json().total, 1);
    const filtered = await app.inject(codex.adminApiPath + "/entries?collectionFilter=filtered");
    assert.equal(filtered.statusCode, 200); assert.equal(filtered.json().total, 1);
    assert.equal(filtered.json().rows[0].post.filteredOut, true); assert.equal(filtered.json().rows[0].post.replyTo, null);
    assert.equal(filtered.body.includes("Private body"), false);
    assert.equal((await app.inject(codex.adminApiPath + "/posts?collectionFilter=all")).json().total, 2);
    const unlinked = await app.inject(codex.adminApiPath + "/posts?association=unlinked");
    assert.equal(unlinked.statusCode, 200); assert.equal(unlinked.json().total, 1);
    const linked = await app.inject(codex.adminApiPath + "/posts?association=linked");
    assert.equal(linked.statusCode, 200); assert.equal(linked.json().total, 0);
    assert.equal((await app.inject(codex.adminApiPath + "/posts?association=invalid")).statusCode, 400);
    assert.equal((await app.inject(codex.adminApiPath + "/entries?collectionFilter=invalid")).statusCode, 400);
  } finally { config.devAdmin = previous; await app.close(); }
});
