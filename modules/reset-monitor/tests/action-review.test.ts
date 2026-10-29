import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { loadActionInput, sourcePost, writePostActions } from "../backend/action-store.ts";
import { monitorPostDetail, monitorEventDetail, previewMonitorReview, submitMonitorReview, previewMonitorEventReview, submitMonitorEventReview } from "../backend/manual-review.ts";
import { properName, publicV2Snapshot } from "../backend/public-v2.ts";
import { reduceEvent, currentUnsourcedConfirmation, type ActionKind } from "../actions.ts";
after(closeDb);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`; await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`;
});
const fields = (action: ActionKind, title: string = action) => ({ action, title: properName(title), summary: null, time: null });
async function addPost(id: string, time = "2026-10-01T12:00:00Z") {
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,text,quoted_post,processing_status)
    VALUES('codex',${id},${codex.authors[0]!.handle},${time},${`https://example.test/${id}`},${sql.json(properName(`Title ${id}`))},${`Private body ${id}`},${sql.json({ id: "quoted", author: "other", text: "Private quote", publishedAt: null, url: "https://example.test/quote", relation: "quote" })},'processed')`;
}
async function seed(type: "direct_reset" | "bonus_credit" = "direct_reset") {
  await addPost("first");
  await sql.begin(async db => writePostActions(db, (await sourcePost("first", db))!, [{ eventId: "event", action: "confirm", title: properName("Initial confirmation"), summary: null, time: null }], { events: [{ id: "event", type }] }));
  await addPost("review", "2026-10-02T12:00:00Z");
}
async function review(commands: Record<string, unknown>, origin: "post" | "event" = "post") {
  const detail = origin === "post" ? (await monitorPostDetail("review"))! : (await monitorEventDetail("event"))!;
  const body = { version: detail.version, versions: detail.versions, reason: "Verify explicit commands", ...commands };
  const preview = (await (origin === "post" ? previewMonitorReview("review", body) : previewMonitorEventReview("event", body)))!;
  await (origin === "post" ? submitMonitorReview("review", { ...body, previewToken: preview.previewToken }, "reviewer") : submitMonitorEventReview("event", { ...body, previewToken: preview.previewToken }, "reviewer"));
  return preview;
}
test("post editorial updates do not manufacture event bindings and audits omit original text", async () => inMonitor(codex, async () => {
  await seed(); const detail = (await monitorPostDetail("review"))!;
  assert.equal(detail.post!.text, "Private body review"); assert.equal(detail.post!.quotedPost!.text, "Private quote");
  const preview = await review({ post: { title: { zh: "修正标题" }, summary: { zh: "补充摘要" } } });
  assert.deepEqual(preview.postChange!.after.title, { zh: "修正标题" });
  const input = await loadActionInput(); assert.equal(input.actions.some(action => action.sources.some(source => source.postId === "review")), false);
  const audits = JSON.stringify(await sql`SELECT before,after FROM audit_log`);
  assert.equal(audits.includes("Private body"), false); assert.equal(audits.includes("Private quote"), false);
}));

test("event action management omits manual reasons while retaining preview and audit; post review still requires one", async () => inMonitor(codex, async () => {
  await seed();
  const detail = (await monitorEventDetail("event"))!, action = (await loadActionInput()).actions[0]!;
  const body = { version: detail.version, versions: detail.versions, actions: { update: [{ id: action.id, ...fields("confirm", "Corrected confirmation") }] } };
  const preview = (await previewMonitorEventReview("event", body))!;
  await assert.rejects(submitMonitorEventReview("event", body, "reviewer"), /预览/);
  await submitMonitorEventReview("event", { ...body, previewToken: preview.previewToken }, "reviewer");
  const [audit] = await sql`SELECT actor,reason,before,after FROM audit_log WHERE action=${codex.names.auditActionPrefix + ".review"}`;
  assert.equal(audit!.actor, "reviewer"); assert.equal(audit!.reason, "后台动作管理");
  assert.ok(JSON.stringify(audit!.after).includes("Corrected confirmation"));
  const post = (await monitorPostDetail("review"))!;
  await assert.rejects(previewMonitorReview("review", { version: post.version }), /帖子复核必须填写理由/);
}));
test("source commands add and remove sources without updating shared facts or sequence", async () => inMonitor(codex, async () => {
  await seed(); const action = (await loadActionInput()).actions[0]!;
  let preview = await review({ sources: { add: [{ actionId: action.id, postId: "review" }] } });
  assert.deepEqual(preview.sourceChanges[0]!.after, ["first", "review"]);
  let stored = (await loadActionInput()).actions[0]!;
  assert.deepEqual(stored.title, action.title); assert.equal(stored.sequence, action.sequence); assert.equal((await loadActionInput()).actions.length, 1);
  preview = await review({ sources: { remove: [{ actionId: action.id, postId: "review" }] } });
  assert.deepEqual(preview.sourceChanges[0]!.after, ["first"]);
  stored = (await loadActionInput()).actions[0]!; assert.equal(stored.sequence, action.sequence);
}));
test("adding a source cannot alter a shared cancellation fact", async () => inMonitor(codex, async () => {
  await seed();
  await review({ actions: { create: [{ localKey: "cancelled", eventId: "event", ...fields("amend"), invalidatesEvent: true }] }, sources: { add: [{ actionKey: "cancelled", postId: "review" }] } });
  const cancellation = (await loadActionInput()).actions.find(action => action.invalidates_event)!;
  await addPost("third", "2026-10-03T12:00:00Z");
  const post = (await sourcePost("third"))!;
  await assert.rejects(sql.begin(db => writePostActions(db, post, [{ id: cancellation.id, eventId: "event", ...fields("amend"), invalidatesEvent: false }])), /补充来源不能修改/);
  await sql.begin(db => writePostActions(db, post, [{ id: cancellation.id, eventId: "event", action: "amend", title: cancellation.title, summary: cancellation.summary, time: cancellation.time, invalidatesEvent: true }]));
  const input = await loadActionInput(), stored = input.actions.find(action => action.id === cancellation.id)!;
  assert.equal(stored.invalidates_event, true);
  assert.equal(stored.sequence, cancellation.sequence);
  assert.deepEqual(stored.sources.map(source => source.postId), ["review", "third"]);
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "cancelled");
  const detail = (await monitorEventDetail("event"))!;
  assert.equal(detail.actions.find(action => action.id === cancellation.id)!.invalidatesEvent, true);
}));

test("one post creates a single local event with multiple independent actions", async () => inMonitor(codex, async () => {
  await addPost("review");
  const preview = await review({ events: { create: [{ localKey: "new", type: "direct_reset", title: { zh: "额度事件" } }] },
    actions: { create: [{ localKey: "promise", eventKey: "new", ...fields("announce") }, { localKey: "done", eventKey: "new", ...fields("confirm") }] },
    sources: { add: [{ actionKey: "promise", postId: "review" }, { actionKey: "done", postId: "review" }] } });
  const input = await loadActionInput(); assert.equal(input.events.length, 1); assert.equal(input.actions.length, 2);
  assert.deepEqual(input.actions.map(action => action.sequence).sort(), [1, 2]); assert.equal(reduceEvent(input.events[0]!, input)!.status, "completed");
  assert.equal(preview.changes[0]!.after!.status, "completed");
}));
test("same text creates distinct actions and explicit correction affects all their sources", async () => inMonitor(codex, async () => {
  await seed();
  await review({ actions: { create: [{ localKey: "a", eventId: "event", ...fields("progress", "Same detail") }, { localKey: "b", eventId: "event", ...fields("progress", "Same detail") }] }, sources: { add: [{ actionKey: "a", postId: "review" }, { actionKey: "b", postId: "review" }] } });
  let input = await loadActionInput(); assert.equal(input.actions.length, 3);
  const action = input.actions.find(action => action.action === "progress")!;
  await review({ sources: { add: [{ actionId: action.id, postId: "first" }] } });
  const preview = await review({ actions: { update: [{ id: action.id, ...fields("amend", "Corrected shared fact") }] } }, "event");
  input = await loadActionInput(); const corrected = input.actions.find(item => item.id === action.id)!;
  assert.equal(corrected.action, "amend"); assert.deepEqual(corrected.sources.map(source => source.postId), ["first", "review"]); assert.equal(preview.actionChanges.length, 1);
}));
test("removing the final source deletes the action and requests scope verification", async () => inMonitor(codex, async () => {
  await seed(); const action = (await loadActionInput()).actions[0]!;
  const preview = await review({ sources: { remove: [{ actionId: action.id, postId: "first" }] } }, "event");
  assert.equal(preview.lastSourceRemovals[0]!.actionId, action.id); assert.match(preview.lastSourceRemovals[0]!.message, /影响范围/);
  assert.equal((await loadActionInput()).actions.length, 0); assert.deepEqual((await publicV2Snapshot()).events, []);
}));
test("event scope edits are independent of actions and appear in preview and audit", async () => inMonitor(codex, async () => {
  await seed(); const scope = { type: "selected_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: { zh: "仅符合资格用户" } };
  const before = (await loadActionInput()).actions;
  const preview = await review({ events: { update: [{ id: "event", scope }] } }, "event");
  assert.deepEqual(preview.changes[0]!.after!.scope, scope); assert.deepEqual((await loadActionInput()).actions, before);
  assert.deepEqual((await monitorEventDetail("event"))!.event!.scope, scope);
  assert.ok(JSON.stringify(await sql`SELECT after FROM audit_log`).includes("仅符合资格用户"));
}));
test("cancellation remains terminal across later announcements and source changes", async () => inMonitor(codex, async () => {
  await seed("bonus_credit");
  await review({ actions: { create: [{ localKey: "cancelled", eventId: "event", ...fields("amend"), invalidatesEvent: true }, { localKey: "promise", eventId: "event", ...fields("announce") }] }, sources: { add: [{ actionKey: "cancelled", postId: "review" }, { actionKey: "promise", postId: "review" }] } });
  let input = await loadActionInput(); assert.equal(reduceEvent(input.events[0]!, input)!.status, "cancelled");
  const confirm = input.actions.find(action => action.action === "confirm")!, cancel = input.actions.find(action => action.invalidates_event)!, promise = input.actions.find(action => action.action === "announce")!;
  await review({ orders: [{ eventId: "event", actionIds: [confirm.id, promise.id, cancel.id] }] }, "event");
  input = await loadActionInput(); assert.equal(reduceEvent(input.events[0]!, input)!.status, "cancelled");
  await review({ sources: { add: [{ actionId: promise.id, postId: "first" }] } });
  input = await loadActionInput(); assert.equal(reduceEvent(input.events[0]!, input)!.status, "cancelled"); assert.equal(input.actions.find(action => action.id === promise.id)!.sequence, 2);
  await review({ actions: { update: [{ id: cancel.id, ...fields("amend"), invalidatesEvent: false }] } }, "event");
  input = await loadActionInput(); assert.equal(reduceEvent(input.events[0]!, input)!.status, "completed");
  const detail = (await monitorEventDetail("event"))!;
  await assert.rejects(previewMonitorEventReview("event", { version: detail.version, versions: detail.versions, reason: "invalid", actions: { update: [{ id: confirm.id, ...fields("confirm"), invalidatesEvent: true }] } }), /修订/);
}));

test("unrelated edits do not invalidate a form while selected target versions do", async () => inMonitor(codex, async () => {
  await seed(); const detail = (await monitorPostDetail("review"))!;
  const action = (await loadActionInput()).actions[0]!;
  const body = { version: detail.version, versions: detail.versions, reason: "补来源", sources: { add: [{ actionId: action.id, postId: "review" }] } };
  await addPost("processed");
  const preview = (await previewMonitorReview("review", body))!;
  await sql`UPDATE monitor_source_posts SET title='{"zh":"unrelated change"}'::jsonb WHERE monitor_id='codex' AND id='processed'`;
  await submitMonitorReview("review", { ...body, previewToken: preview.previewToken }, "reviewer");
  const fresh = (await monitorPostDetail("review"))!;
  const command = { version: fresh.version, versions: fresh.versions, reason: "核对", sources: { remove: [{ actionId: action.id, postId: "review" }] } };
  const next = (await previewMonitorReview("review", command))!;
  await sql`UPDATE monitor_event_actions SET title='{"zh":"changed target"}'::jsonb,updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${action.id}`;
  await assert.rejects(submitMonitorReview("review", { ...command, previewToken: next.previewToken }, "reviewer"), /变化/);
}));
test("invalid sources, foreign targets, legacy replacement and incomplete orders are rejected", async () => inMonitor(codex, async () => {
  await seed(); const detail = (await monitorPostDetail("review"))!, action = (await loadActionInput()).actions[0]!;
  const body = { version: detail.version, versions: detail.versions, reason: "核对" };
  for (const extra of [{ actions: [] }, { eventIds: ["event"] }, { sources: { add: [{ actionId: action.id, postId: "missing" }] } }, { orders: [{ eventId: "event", actionIds: [] }] }, { actions: { create: [{ localKey: "new", eventId: "event", ...fields("progress"), eventScope: {} }] } }]) await assert.rejects(previewMonitorReview("review", { ...body, ...extra }));
}));

test("unrelated event and option updates do not invalidate an event management preview", async () => inMonitor(codex, async () => {
  await seed(); await addPost("other-source");
  await sql.begin(async db => writePostActions(db, (await sourcePost("other-source", db))!, [{ eventId: "other-event", action: "announce", title: properName("Other promise"), summary: null, time: null }], { events: [{ id: "other-event", type: "direct_reset" }] }));
  const detail = (await monitorEventDetail("event"))!;
  const command = { version: detail.version, versions: detail.versions, reason: "补充来源", sources: { add: [{ actionId: detail.actions[0]!.id, postId: "review" }] } };
  const preview = (await previewMonitorEventReview("event", command))!;
  await sql`UPDATE monitor_event_records SET title='{"zh":"Unrelated change"}'::jsonb,updated_at=clock_timestamp() WHERE monitor_id='codex' AND id='other-event'`;
  await sql`UPDATE monitor_event_actions SET title='{"zh":"Unrelated action change"}'::jsonb,updated_at=clock_timestamp() WHERE monitor_id='codex' AND event_id='other-event'`;
  await submitMonitorEventReview("event", { ...command, previewToken: preview.previewToken }, "reviewer");
  assert.equal((await loadActionInput()).actions.find(action => action.event_id === "event")!.sources.length, 2);
}));

test("newly selected records require their own expected version", async () => inMonitor(codex, async () => {
  await seed(); const detail = (await monitorPostDetail("review"))!, action = (await loadActionInput()).actions[0]!;
  await assert.rejects(previewMonitorReview("review", { version: detail.version, reason: "补来源", sources: { add: [{ actionId: action.id, postId: "review" }] } }), /选项/);
}));

test("post completion is explicit and independent of action sources", async () => inMonitor(codex, async () => {
  await seed();
  await sql`UPDATE monitor_source_posts SET processing_status='needs_attention',review_reason='需要人工识别' WHERE monitor_id='codex' AND id='review'`;
  await review({ post: { title: { zh: "仅编辑文案" } } });
  let post = (await sourcePost("review"))!;
  assert.equal(post.processing_status, "needs_attention"); assert.equal(post.review_reason, "需要人工识别");
  const preview = await review({ completeProcessing: true });
  assert.equal(preview.postChange!.after.processingStatus, "processed"); assert.equal(preview.postChange!.after.reviewReason, null);
  post = (await sourcePost("review"))!; assert.equal(post.processing_status, "processed"); assert.equal(post.review_reason, null);
  assert.equal((await loadActionInput()).actions.some(action => action.sources.some(source => source.postId === "review")), false);
}));

test("event source and order changes preserve every post processing state and reason", async () => inMonitor(codex, async () => {
  await seed();
  await sql`UPDATE monitor_source_posts SET processing_status='failed',review_reason='保留技术失败原因' WHERE monitor_id='codex' AND id='review'`;
  const action = (await loadActionInput()).actions[0]!;
  await review({ sources: { add: [{ actionId: action.id, postId: "review" }] }, orders: [{ eventId: "event", actionIds: [action.id] }] }, "event");
  const post = (await sourcePost("review"))!; assert.equal(post.processing_status, "failed"); assert.equal(post.review_reason, "保留技术失败原因");
  const detail = (await monitorEventDetail("event"))!;
  await assert.rejects(previewMonitorEventReview("event", { version: detail.version, versions: detail.versions, reason: "不允许事件处理帖子", completeProcessing: true }), /只有帖子/);
}));

test("post filters accept four recognition states and reject retired aliases", async () => inMonitor(codex, async () => {
  await seed();
  const { listMonitorPosts } = await import("../backend/admin.ts");
  for (const filter of ["pending", "processed", "needs_attention", "failed", "all"]) await listMonitorPosts({ filter });
  for (const filter of ["relevant", "unrelated", "accepted", "review", "needs_review"]) await assert.rejects(listMonitorPosts({ filter }));
}));

test("source-free confirmations use action review, retain identity and become official when a post arrives", async () => inMonitor(codex, async () => {
  await seed();
  await sql`UPDATE monitor_event_actions SET action='announce',time='2026-10-01T13:00:00Z' WHERE monitor_id='codex'`;
  const posts = (await loadActionInput()).posts;
  await review({ actions: { create: [{ localKey: "manual", eventId: "event", ...fields("confirm", "人工核实已生效"), time: "2026-10-01T14:00:00Z" }] } }, "event");
  let input = await loadActionInput();
  const manual = currentUnsourcedConfirmation(input.events[0]!, input)!;
  assert.ok(manual); assert.equal(input.actions.length, 2);
  assert.deepEqual(manual.sources, []); assert.deepEqual(input.posts, posts);
  assert.equal((await publicV2Snapshot()).events[0]!.updates.find(action => action.id === manual.id)!.sources.length, 0);
  await review({ actions: { create: [{ localKey: "correction", eventId: "event", ...fields("confirm", "人工核实已生效（已更正）"), time: "2026-10-01T15:00:00Z" }] } }, "event");
  input = await loadActionInput();
  assert.equal(input.actions.length, 2); assert.equal(currentUnsourcedConfirmation(input.events[0]!, input)!.id, manual.id);
  await sql.begin(db => writePostActions(db, input.posts.find(post => post.id === "review")!, [{ eventId: "event", ...fields("confirm", "官方确认"), time: "2026-10-02T10:00:00Z" }]));
  input = await loadActionInput();
  const upgraded = input.actions.find(action => action.id === manual.id)!;
  assert.equal(input.actions.length, 2); assert.equal(upgraded.sequence, manual.sequence);
  assert.deepEqual(upgraded.sources, [{ postId: "review" }]); assert.equal(upgraded.time, "2026-10-02T10:00:00Z");
  assert.equal(upgraded.title.zh, "官方确认"); assert.equal(currentUnsourcedConfirmation(input.events[0]!, input), null);
}));

test("source-free actions require confirmation and time; retired verification commands are rejected", async () => inMonitor(codex, async () => {
  await seed();
  for (const action of [fields("confirm"), { ...fields("progress"), time: "2026-10-01" }]) {
    const detail = (await monitorEventDetail("event"))!;
    await assert.rejects(previewMonitorEventReview("event", { version: detail.version, versions: detail.versions, reason: "test", actions: { create: [{ localKey: "invalid", eventId: "event", ...action }] } }), /明确生效时间/);
  }
  const detail = (await monitorEventDetail("event"))!;
  await assert.rejects(previewMonitorEventReview("event", { version: detail.version, reason: "test", verification: { outcome: "not_effective", time: null } }));
  for (const time of ["2099-01-01", "2099-01-01T00:00:00Z", "2026-10-01T00:00:00Z/2099-01-01T00:00:00Z"]) {
    await assert.rejects(previewMonitorEventReview("event", { version: detail.version, versions: detail.versions, reason: "test", actions: { create: [{ localKey: "future", eventId: "event", ...fields("confirm"), time }] } }), /不能在未来/);
  }
}));

test("an event without initial actions accepts a timed source-free initial confirmation", async () => inMonitor(codex, async () => {
  await seed(); await sql`DELETE FROM monitor_event_actions`;
  await review({ actions: { create: [{ localKey: "initial", eventId: "event", ...fields("confirm", "人工核实已生效"), time: "2026-10-01" }] } }, "event");
  const input = await loadActionInput();
  assert.equal(input.actions.length, 1); assert.deepEqual(input.actions[0]!.sources, []);
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "completed");
  assert.equal((await publicV2Snapshot()).events[0]!.time, "2026-10-01");
}));

test("editing a plan time previews an explicit correction and supersedes an earlier source-free confirmation", async () => inMonitor(codex, async () => {
  await seed();
  await sql`UPDATE monitor_event_actions SET action='announce',time='2026-10-01T13:00:00Z' WHERE monitor_id='codex'`;
  await review({ actions: { create: [{ localKey: "manual", eventId: "event", ...fields("confirm", "人工核实已生效"), time: "2026-10-01T14:00:00Z" }] } }, "event");
  let input = await loadActionInput(); const confirmation = currentUnsourcedConfirmation(input.events[0]!, input)!, plan = input.actions.find(action => action.action === "announce")!;
  const editorial = await review({ actions: { update: [{ id: plan.id, ...fields("announce", "仅修正文案"), time: plan.time }] } }, "event");
  assert.equal(editorial.actionChanges.length, 1);
  input = await loadActionInput(); assert.equal(input.actions.length, 2); assert.equal(currentUnsourcedConfirmation(input.events[0]!, input)!.id, confirmation.id);
  const preview = await review({ actions: { update: [{ id: plan.id, ...fields("announce", "计划时间修订"), time: "2026-10-29" }] } }, "event");
  assert.equal(preview.actionChanges.length, 2);
  input = await loadActionInput();
  assert.equal(input.actions.length, 3); assert.ok(input.actions.some(action => action.id === confirmation.id));
  assert.equal(currentUnsourcedConfirmation(input.events[0]!, input), null);
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "announced");
  assert.equal(reduceEvent(input.events[0]!, input)!.time, "2026-10-29");
}));

test("upgrading a source-free confirmation preserves official completion across subsequent progress", async () => inMonitor(codex, async () => {
  await seed();
  await sql`UPDATE monitor_event_actions SET action='announce',time='2026-10-01T13:00:00Z' WHERE monitor_id='codex'`;
  await review({ actions: { create: [{ localKey: "manual", eventId: "event", ...fields("confirm", "人工核实已生效"), time: "2026-10-01T14:00:00Z" }] } }, "event");
  let input = await loadActionInput(); const current = currentUnsourcedConfirmation(input.events[0]!, input)!;
  await review({ actions: { create: [{ localKey: "progress", eventId: "event", ...fields("progress") }] }, sources: { add: [{ actionKey: "progress", postId: "review" }] } }, "event");
  input = await loadActionInput(); assert.equal(reduceEvent(input.events[0]!, input)!.status, "in_progress");
  await addPost("official", "2026-10-03T12:00:00Z");
  await sql.begin(async db => writePostActions(db, (await sourcePost("official", db))!, [{ id: current.id, eventId: "event", ...fields("confirm", "官方确认"), time: "2026-10-01T15:00:00Z" }]));
  input = await loadActionInput();
  assert.equal(input.actions.find(action => action.id === current.id)!.sequence, current.sequence);
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "completed");
  assert.equal(reduceEvent(input.events[0]!, input)!.confirmedTime, "2026-10-01T15:00:00Z");
}));
