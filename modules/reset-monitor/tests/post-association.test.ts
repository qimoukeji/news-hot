import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor, monitor, monitorId } from "../backend/context.ts";
import { createMonitorEvent, listMonitorPosts } from "../backend/admin.ts";
import { loadActionInput, sourcePost, writePostActions } from "../backend/action-store.ts";
import { monitorPostDetail, monitorEventDetail, previewMonitorReview, submitMonitorReview, previewMonitorEventReview, submitMonitorEventReview } from "../backend/manual-review.ts";
import { properName, publicV2Snapshot } from "../backend/public-v2.ts";
import { createSubscription } from "../backend/webhooks.ts";
import { webhookPayloadSchema } from "../webhooks.ts";
import { reduceEvent } from "../actions.ts";
import { config } from "@aihot/backend/config";

const definitions = [codex, claude, grok];
const fact = (action: "announce" | "confirm" | "progress" | "amend" = "confirm") => ({ action, title: properName("Official quota result"), summary: properName("Verified source fact"), time: "2026-10-01T12:00:00Z" });
beforeEach(async () => {
  await sql`DELETE FROM monitor_webhook_deliveries`; await sql`DELETE FROM monitor_webhook_notifications`; await sql`DELETE FROM monitor_webhook_subscriptions`;
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`; await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`;
});
after(async () => { await stopBoss(); await closeDb(); });
async function addPost(id: string, status = "needs_attention") {
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,text,processing_status,review_reason)
    VALUES(${monitorId()},${id},${monitor().authors[0]!.handle},'2026-10-01T12:00:00Z',${`https://example.test/${id}`},${sql.json(properName("Source " + id))},${"Private body " + id},${status},'Keep recognition explanation')`;
  return (await sourcePost(id))!;
}
async function existingEvent() {
  const post = await addPost("first", "processed");
  await sql.begin(db => writePostActions(db, post, [{ eventId: "event", ...fact() }], { events: [{ id: "event", type: "direct_reset", title: properName("Existing event") }] }));
  return (await loadActionInput()).actions[0]!;
}
async function postBody(id: string, commands: Record<string, unknown>) {
  const detail = (await monitorPostDetail(id))!;
  return { version: detail.version, versions: detail.versions, ...commands };
}
async function associate(id: string, commands: Record<string, unknown>) {
  const body = await postBody(id, commands), preview = (await previewMonitorReview(id, body))!;
  await submitMonitorReview(id, { ...body, previewToken: preview.previewToken }, "association-admin");
  return preview;
}

for (const definition of definitions) test(`${definition.monitorId}: creating an event, first action and selected source is atomic and notifies only after commit`, async () => inMonitor(definition, async () => {
  await addPost("review");
  await createSubscription({ name: "Post association", url: "https://8.8.8.8/hook", platforms: [definition.publicV2!.platform], enabled: true, reason: "Local test" }, "test-admin", definitions);
  const body = await postBody("review", {
    events: { create: [{ localKey: "event", type: "direct_reset", title: properName("Created from source"), summary: null }] },
    actions: { create: [{ localKey: "action", eventKey: "event", ...fact() }] }, sources: { add: [{ actionKey: "action", postId: "review" }] },
  });
  const preview = (await previewMonitorReview("review", body))!;
  assert.equal(preview.postChange!.before.processingStatus, "needs_attention");
  assert.equal(preview.postChange!.after.processingStatus, "processed");
  assert.equal(preview.postChange!.after.reviewReason, null);
  assert.equal((await sourcePost("review"))!.processing_status, "needs_attention", "preview must not complete the post");
  assert.equal((await loadActionInput()).events.length, 0); assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
  await assert.rejects(submitMonitorReview("review", body, "association-admin"), /预览/);
  assert.equal((await loadActionInput()).events.length, 0);
  await submitMonitorReview("review", { ...body, previewToken: preview.previewToken }, "association-admin");
  const input = await loadActionInput(); assert.equal(input.events.length, 1); assert.equal(input.actions.length, 1);
  assert.deepEqual(input.actions[0]!.sources, [{ postId: "review" }]); assert.equal(input.posts[0]!.processing_status, "processed"); assert.equal(input.posts[0]!.review_reason, null);
  assert.equal((await publicV2Snapshot()).events.length, 1);
  const notifications = await sql`SELECT payload FROM monitor_webhook_notifications`;
  assert.equal(notifications.length, 1); assert.equal(webhookPayloadSchema.parse(notifications[0]!.payload).action, "created");
  await assert.rejects(submitMonitorReview("review", { ...body, previewToken: preview.previewToken }, "association-admin"), /变化/);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 1);
  const [audit] = await sql`SELECT actor,reason,before,after FROM audit_log WHERE action=${definition.names.auditActionPrefix + ".review"}`;
  assert.equal(audit!.actor, "association-admin"); assert.equal(audit!.reason, "后台帖子关联"); assert.equal(JSON.stringify(audit).includes("Private body"), false);
  assert.equal(audit!.before.post.processing_status, "needs_attention");
  assert.equal(audit!.before.post.review_reason, "Keep recognition explanation");
  assert.equal(audit!.after.post.processing_status, "processed");
  assert.equal(audit!.after.post.review_reason, null);
}));

for (const status of ["pending", "needs_attention", "failed"]) test(`new-event association completes only its origin post from ${status}`, async () => inMonitor(codex, async () => {
  await addPost("review", status); await addPost("other", "needs_attention");
  await associate("review", { events: { create: [{ localKey: "new", type: "direct_reset", title: properName("Reviewed event") }] },
    actions: { create: [{ localKey: "initial", eventKey: "new", ...fact("announce") }] }, sources: { add: [{ actionKey: "initial", postId: "review" }] } });
  assert.equal((await sourcePost("review"))!.processing_status, "processed");
  assert.equal((await sourcePost("review"))!.review_reason, null);
  assert.equal((await sourcePost("other"))!.processing_status, "needs_attention");
  assert.equal((await sourcePost("other"))!.review_reason, "Keep recognition explanation");
}));

test("creating an event whose source is another post does not finish the origin's review", async () => inMonitor(codex, async () => {
  await addPost("review"); await addPost("other");
  await associate("review", { events: { create: [{ localKey: "new", type: "direct_reset", title: properName("Other source event") }] },
    actions: { create: [{ localKey: "initial", eventKey: "new", ...fact("announce") }] }, sources: { add: [{ actionKey: "initial", postId: "other" }] } });
  assert.equal((await sourcePost("review"))!.processing_status, "needs_attention");
  assert.equal((await sourcePost("other"))!.processing_status, "needs_attention");
}));

for (const definition of definitions) test(`${definition.monitorId}: supplementing an action preserves shared facts and recognition progress`, async () => inMonitor(definition, async () => {
  const original = await existingEvent(); await addPost("review", "failed");
  const before = await loadActionInput();
  const preview = await associate("review", { sources: { add: [{ actionId: original.id, postId: "review" }] } });
  assert.equal(preview.sourceChanges.length, 1); assert.deepEqual(preview.sourceChanges[0]!.after, ["first", "review"]);
  const input = await loadActionInput(), action = input.actions[0]!;
  assert.equal(input.actions.length, 1); assert.equal(action.id, original.id); assert.equal(action.sequence, original.sequence);
  assert.deepEqual(action.title, original.title); assert.equal(action.time, original.time); assert.deepEqual(input.events, before.events);
  const post = input.posts.find(post => post.id === "review")!; assert.equal(post.processing_status, "failed"); assert.equal(post.review_reason, "Keep recognition explanation");
  assert.deepEqual((await listMonitorPosts({ association: "linked" })).rows.map(post => post.id).sort(), ["first", "review"]);
}));

for (const definition of definitions) test(`${definition.monitorId}: a Chinese-only manual event with a standard scope is public without model calls`, async () => inMonitor(definition, async () => {
  await addPost("review");
  const callsEnabled = config.modelCallsEnabled;
  config.modelCallsEnabled = false;
  try {
    const beforeReceipts = await sql`SELECT id FROM receipts`;
    const preview = await associate("review", {
      events: { create: [{ localKey: "new", type: "direct_reset", title: { zh: "人工核实的重置" }, summary: { zh: "额度已重置" },
        scope: { type: "unknown", productCodes: [], planCodes: [], quotaWindowCodes: [], note: { zh: "所有用户" } } }] },
      actions: { create: [{ localKey: "first", eventKey: "new", ...fact(), title: { zh: "重置已生效" }, summary: { zh: "额度已生效" } }] },
      sources: { add: [{ actionKey: "first", postId: "review" }] },
    });
    assert.equal(preview.postChange!.after.processingStatus, "processed");
    const input = await loadActionInput(), event = (await publicV2Snapshot()).events.find(event => event.id === input.events[0]!.id)!;
    assert.ok(event, "the manual event must not disappear while title/summary translation is disabled");
    assert.equal(event.scope.type, "unknown");
    assert.equal(event.scope.note!.zh, "所有用户");
    assert.equal(event.scope.note!.en, "All users");
    assert.deepEqual(input.events[0]!.scope!.note, { zh: "所有用户" }, "reading must not persist generated labels");
    assert.equal((await sourcePost("review"))!.processing_status, "processed");
    assert.deepEqual(await sql`SELECT id FROM receipts`, beforeReceipts);
  } finally { config.modelCallsEnabled = callsEnabled; }
}));

for (const definition of definitions) test(`${definition.monitorId}: official source upgrades an unsourced confirmation with its identity and order retained`, async () => inMonitor(definition, async () => {
  const event = await createMonitorEvent({ type: "direct_reset", title: properName("Manual draft") }, "test-admin");
  const detail = (await monitorEventDetail(event.id))!;
  const body = { version: detail.version, versions: detail.versions, actions: { create: [{ localKey: "inferred", eventId: event.id, ...fact(), title: properName("已到预告时间") }] } };
  const preview = (await previewMonitorEventReview(event.id, body))!;
  await submitMonitorEventReview(event.id, { ...body, previewToken: preview.previewToken }, "test-admin");
  const original = (await loadActionInput()).actions[0]!; assert.deepEqual(original.sources, []);
  await addPost("review");
  assert.equal((await monitorPostDetail("review"))!.options.events.find(row => row.id === event.id)!.unsourcedConfirmationId, original.id);
  await associate("review", { actions: { update: [{ id: original.id, ...fact(), time: "2026-10-02T12:00:00Z" }] }, sources: { add: [{ actionId: original.id, postId: "review" }] } });
  const input = await loadActionInput(), updated = input.actions[0]!;
  assert.equal(input.actions.length, 1); assert.equal(updated.id, original.id); assert.equal(updated.sequence, original.sequence);
  assert.equal(updated.title.zh, "Official quota result"); assert.equal(updated.time, "2026-10-02T12:00:00Z"); assert.deepEqual(updated.sources, [{ postId: "review" }]);
  assert.equal(input.posts[0]!.processing_status, "needs_attention"); assert.equal(reduceEvent(input.events[0]!, input)!.status, "completed");
  assert.equal((await monitorPostDetail("review"))!.options.events.find(row => row.id === event.id)!.unsourcedConfirmationId, null);
}));

test("two sourced confirmations in one batch remain independent when the event only had an announcement", async () => inMonitor(codex, async () => {
  const initial = await addPost("initial", "processed");
  await sql.begin(db => writePostActions(db, initial, [{ eventId: "event", ...fact("announce"), title: properName("Existing announcement") }], { events: [{ id: "event", type: "direct_reset", title: properName("Announced event") }] }));
  await addPost("review"); await addPost("other-evidence", "processed");
  const body = await postBody("review", {
    actions: { create: [
      { localKey: "first-confirmation", eventId: "event", ...fact(), title: properName("First independent completion"), time: "2026-10-01T10:00:00Z" },
      { localKey: "second-confirmation", eventId: "event", ...fact(), title: properName("Second independent completion"), time: "2026-10-01T11:00:00Z" },
    ] },
    sources: { add: [{ actionKey: "first-confirmation", postId: "review" }, { actionKey: "second-confirmation", postId: "other-evidence" }] },
  });
  const preview = (await previewMonitorReview("review", body))!;
  assert.equal(preview.actionChanges.length, 2); assert.ok(preview.actionChanges.every(change => change.before === null));
  assert.equal((await loadActionInput()).actions.length, 1);
  await submitMonitorReview("review", { ...body, previewToken: preview.previewToken }, "association-admin");
  const input = await loadActionInput();
  assert.equal(input.actions.length, 3);
  const first = input.actions.find(action => action.title.zh === "First independent completion")!, second = input.actions.find(action => action.title.zh === "Second independent completion")!;
  assert.ok(first); assert.ok(second); assert.notEqual(first.id, second.id); assert.ok(first.sequence < second.sequence);
  assert.deepEqual(first.sources, [{ postId: "review" }]); assert.deepEqual(second.sources, [{ postId: "other-evidence" }]);
  assert.equal(Date.parse(first.time!), Date.parse("2026-10-01T10:00:00Z")); assert.equal(Date.parse(second.time!), Date.parse("2026-10-01T11:00:00Z"));
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "completed");
}));

test("a new sourced announcement in a batch supersedes the old unsourced confirmation before a later official confirmation", async () => inMonitor(codex, async () => {
  const event = await createMonitorEvent({ type: "direct_reset", title: properName("Inferred event") }, "test-admin");
  const detail = (await monitorEventDetail(event.id))!;
  const initial = { version: detail.version, versions: detail.versions, actions: { create: [{ localKey: "inferred", eventId: event.id, ...fact(), title: properName("已到预告时间"), time: "2026-10-01T09:00:00Z" }] } };
  const initialPreview = (await previewMonitorEventReview(event.id, initial))!;
  await submitMonitorEventReview(event.id, { ...initial, previewToken: initialPreview.previewToken }, "test-admin");
  const original = (await loadActionInput()).actions[0]!;
  await addPost("review"); await addPost("other-evidence", "processed");
  const body = await postBody("review", {
    actions: { create: [
      { localKey: "new-plan", eventId: event.id, ...fact("announce"), title: properName("New official plan"), time: "2026-10-01T10:00:00Z" },
      { localKey: "official-result", eventId: event.id, ...fact(), title: properName("Official result of the new plan"), time: "2026-10-01T11:00:00Z" },
    ] },
    sources: { add: [{ actionKey: "new-plan", postId: "review" }, { actionKey: "official-result", postId: "other-evidence" }] },
  });
  const preview = (await previewMonitorReview("review", body))!;
  assert.equal(preview.actionChanges.length, 2); assert.ok(preview.actionChanges.every(change => change.before === null));
  assert.equal(preview.actionChanges.some(change => change.actionId === original.id), false);
  await submitMonitorReview("review", { ...body, previewToken: preview.previewToken }, "association-admin");
  const input = await loadActionInput(), preserved = input.actions.find(action => action.id === original.id)!;
  assert.equal(input.actions.length, 3);
  assert.deepEqual(preserved.title, original.title); assert.deepEqual(preserved.summary, original.summary); assert.equal(preserved.time, original.time);
  assert.equal(preserved.sequence, original.sequence); assert.deepEqual(preserved.sources, []);
  const announcement = input.actions.find(action => action.title.zh === "New official plan")!, confirmation = input.actions.find(action => action.title.zh === "Official result of the new plan")!;
  assert.ok(announcement); assert.ok(confirmation); assert.notEqual(confirmation.id, original.id); assert.ok(original.sequence < announcement.sequence && announcement.sequence < confirmation.sequence);
  assert.deepEqual(announcement.sources, [{ postId: "review" }]); assert.deepEqual(confirmation.sources, [{ postId: "other-evidence" }]);
  const reduced = reduceEvent(input.events[0]!, input)!;
  assert.equal(reduced.status, "completed"); assert.equal(reduced.confirmationId, confirmation.id); assert.equal(Date.parse(reduced.confirmedTime!), Date.parse("2026-10-01T11:00:00Z"));
}));

test("post metadata, recognition completion, retention and empty commands still require a review reason", async () => inMonitor(codex, async () => {
  const action = await existingEvent(); await addPost("review");
  const body = await postBody("review", { sources: { add: [{ actionId: action.id, postId: "review" }] } });
  for (const legacy of [{ post: { title: { zh: "Edited" } } }, { completeProcessing: true }, { completeProcessing: false }, { keepPost: true }]) {
    await assert.rejects(previewMonitorReview("review", { ...body, ...legacy }), /帖子复核必须填写理由/);
  }
  await assert.rejects(previewMonitorReview("review", { version: body.version, versions: body.versions }), /帖子复核必须填写理由/);
  assert.equal((await sourcePost("review"))!.processing_status, "needs_attention");
}));

test("selected target and source changes invalidate an association preview without partial writes", async () => inMonitor(codex, async () => {
  const action = await existingEvent(); await addPost("review");
  let body = await postBody("review", { sources: { add: [{ actionId: action.id, postId: "review" }] } });
  const preview = (await previewMonitorReview("review", body))!;
  await sql`UPDATE monitor_event_actions SET title='{"zh":"Changed target"}'::jsonb,updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${action.id}`;
  await assert.rejects(submitMonitorReview("review", { ...body, previewToken: preview.previewToken }, "association-admin"), /变化/);
  assert.deepEqual((await loadActionInput()).actions[0]!.sources, [{ postId: "first" }]);
  body = await postBody("review", { sources: { add: [{ actionId: action.id, postId: "review" }] } });
  const next = (await previewMonitorReview("review", body))!;
  await sql`UPDATE monitor_source_posts SET summary='{"zh":"Changed source"}'::jsonb,updated_at=clock_timestamp() WHERE monitor_id='codex' AND id='review'`;
  await assert.rejects(submitMonitorReview("review", { ...body, previewToken: next.previewToken }, "association-admin"), /变化/);
  assert.deepEqual((await loadActionInput()).actions[0]!.sources, [{ postId: "first" }]);
}));

test("a mixed association batch creates independent events, adds sources and removes a last-source action atomically", async () => inMonitor(codex, async () => {
  const original = await existingEvent(), reviewPost = await addPost("review", "failed");
  await sql.begin(db => writePostActions(db, reviewPost, [{ eventId: "old-only", ...fact(), title: properName("Previous standalone fact") }], { events: [{ id: "old-only", type: "bonus_credit", title: properName("Previous source event") }] }));
  const removable = (await loadActionInput()).actions.find(action => action.event_id === "old-only")!;
  await createSubscription({ name: "Batch post association", url: "https://8.8.8.8/hook", platforms: [codex.publicV2!.platform], enabled: true, reason: "Local test" }, "test-admin", definitions);
  const commands = {
    events: { create: [
      { localKey: "fresh-announcement", type: "direct_reset", title: properName("New announced event") },
      { localKey: "fresh-confirmation", type: "reset_credit", title: properName("New confirmed event") },
    ] },
    actions: { create: [
      { localKey: "existing-progress", eventId: "event", ...fact("progress"), title: properName("Existing event progress") },
      { localKey: "first-announcement", eventKey: "fresh-announcement", ...fact("announce"), title: properName("First announcement") },
      { localKey: "first-confirmation", eventKey: "fresh-confirmation", ...fact(), title: properName("First confirmation") },
    ] },
    sources: { add: [
      { actionId: original.id, postId: "review" },
      { actionKey: "existing-progress", postId: "review" },
      { actionKey: "first-announcement", postId: "review" },
      { actionKey: "first-confirmation", postId: "review" },
    ], remove: [{ actionId: removable.id, postId: "review" }] },
  };
  const before = await loadActionInput(), priorNotifications = await sql`SELECT id FROM monitor_webhook_notifications`, priorAudits = await sql`SELECT id FROM audit_log`;
  let body = await postBody("review", commands);
  const preview = (await previewMonitorReview("review", body))!;
  assert.deepEqual(await loadActionInput(), before, "preview cannot persist any part of a mixed batch");
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, priorNotifications.length);
  assert.equal((await sql`SELECT id FROM audit_log`).length, priorAudits.length);
  assert.deepEqual(preview.lastSourceRemovals.map(change => change.actionId), [removable.id]);
  assert.equal(preview.changes.length, 4);

  await sql`UPDATE monitor_event_actions SET title=${sql.json(properName("Concurrent shared fact correction"))},updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${original.id}`;
  const concurrent = await loadActionInput();
  await assert.rejects(submitMonitorReview("review", { ...body, previewToken: preview.previewToken }, "batch-association-admin"), /变化/);
  assert.deepEqual(await loadActionInput(), concurrent, "a stale selected record rejects every staged operation");
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, priorNotifications.length);
  assert.equal((await sql`SELECT id FROM audit_log`).length, priorAudits.length);

  const invalid = { ...commands, actions: { create: commands.actions.create.map(action => action.localKey === "first-announcement" ? { ...action, action: "progress" } : action) } };
  const invalidBody = await postBody("review", invalid);
  await assert.rejects(previewMonitorReview("review", invalidBody), /预告或确认/);
  await assert.rejects(submitMonitorReview("review", { ...invalidBody, previewToken: preview.previewToken }, "batch-association-admin"), /预告或确认/);
  assert.deepEqual(await loadActionInput(), concurrent, "an invalid first action cannot leave either new event or any source changes");

  body = await postBody("review", commands);
  const latest = (await previewMonitorReview("review", body))!;
  await submitMonitorReview("review", { ...body, previewToken: latest.previewToken }, "batch-association-admin");
  const saved = await loadActionInput();
  assert.equal(saved.events.length, 4); assert.equal(saved.actions.length, 4);
  assert.equal(saved.actions.some(action => action.id === removable.id), false);
  assert.deepEqual(saved.actions.find(action => action.id === original.id)!.sources, [{ postId: "first" }, { postId: "review" }]);
  const announcement = saved.events.find(event => event.title?.zh === "New announced event")!, confirmation = saved.events.find(event => event.title?.zh === "New confirmed event")!;
  assert.notEqual(announcement.id, confirmation.id);
  assert.equal(saved.actions.find(action => action.title.zh === "First announcement")!.event_id, announcement.id);
  assert.equal(saved.actions.find(action => action.title.zh === "First confirmation")!.event_id, confirmation.id);
  assert.equal(saved.actions.find(action => action.title.zh === "Existing event progress")!.event_id, "event");
  assert.ok(saved.actions.every(action => action.sources.some(source => source.postId === "review")));
  assert.equal(reduceEvent(announcement, saved)!.status, "announced"); assert.equal(reduceEvent(confirmation, saved)!.status, "completed");
  assert.equal(reduceEvent(saved.events.find(event => event.id === "old-only")!, saved), null);
  const completed = (await sourcePost("review"))!;
  const metadata = ({ processing_status: _status, review_reason: _reason, updated_at: _updated, version: _version, ...source }: typeof completed) => source;
  assert.deepEqual(metadata(completed), metadata(reviewPost), "completing manual review preserves source identity, text and receipts");
  assert.equal(completed.processing_status, "processed"); assert.equal(completed.review_reason, null);
  const audits = await sql`SELECT reason,before,after FROM audit_log WHERE actor='batch-association-admin'`;
  assert.equal(audits.length, 1); assert.equal(audits[0]!.reason, "后台帖子关联"); assert.equal(JSON.stringify(audits).includes("Private body"), false);
  const notifications = (await sql`SELECT payload FROM monitor_webhook_notifications`).map(row => webhookPayloadSchema.parse(row.payload));
  for (const event of [announcement, confirmation]) assert.equal(notifications.filter(notification => notification.eventId === event.id && notification.action === "created").length, 1);
}));

test("withdrawn events reject source additions and new actions while cancelled events remain cancelled", async () => inMonitor(codex, async () => {
  const action = await existingEvent(); await addPost("review");
  await sql`UPDATE monitor_event_records SET withdrawn=true WHERE monitor_id='codex' AND id='event'`;
  for (const commands of [{ sources: { add: [{ actionId: action.id, postId: "review" }] } }, { actions: { create: [{ localKey: "new", eventId: "event", ...fact("progress") }] }, sources: { add: [{ actionKey: "new", postId: "review" }] } }]) {
    await assert.rejects(previewMonitorReview("review", await postBody("review", commands)), /已撤回/);
  }
  await sql`UPDATE monitor_event_records SET withdrawn=false WHERE monitor_id='codex' AND id='event'`;
  await associate("review", { actions: { create: [{ localKey: "cancel", eventId: "event", ...fact("amend"), invalidatesEvent: true }] }, sources: { add: [{ actionKey: "cancel", postId: "review" }] } });
  await associate("review", { actions: { create: [{ localKey: "later", eventId: "event", ...fact("announce") }] }, sources: { add: [{ actionKey: "later", postId: "review" }] } });
  const input = await loadActionInput(); assert.equal(reduceEvent(input.events[0]!, input)!.status, "cancelled");
}));

test("new or empty events require an initial announcement or confirmation and invalid submissions leave no draft", async () => inMonitor(codex, async () => {
  await addPost("review");
  const draft = await createMonitorEvent({ type: "direct_reset", title: properName("Empty draft") }, "test-admin");
  for (const action of ["progress", "amend"] as const) {
    for (const newEvent of [false, true]) {
      const commands = { ...(newEvent ? { events: { create: [{ localKey: "new", type: "direct_reset", title: properName("New event") }] } } : {}),
        actions: { create: [{ localKey: "initial", ...(newEvent ? { eventKey: "new" } : { eventId: draft.id }), ...fact(action) }] }, sources: { add: [{ actionKey: "initial", postId: "review" }] } };
      await assert.rejects(previewMonitorReview("review", await postBody("review", commands)), /预告或确认/);
    }
  }
  const input = await loadActionInput(); assert.equal(input.events.length, 1); assert.equal(input.actions.length, 0);
}));

test("a source cannot be linked to an event or action from another monitor", async () => {
  const foreign = await inMonitor(claude, existingEvent);
  await inMonitor(codex, async () => {
    await addPost("review");
    for (const commands of [{ sources: { add: [{ actionId: foreign.id, postId: "review" }] } }, { actions: { create: [{ localKey: "foreign", eventId: "event", ...fact() }] }, sources: { add: [{ actionKey: "foreign", postId: "review" }] } }]) {
      await assert.rejects(previewMonitorReview("review", await postBody("review", commands)), /当前监控/);
    }
    const input = await loadActionInput(); assert.equal(input.events.length, 0); assert.equal(input.actions.length, 0);
  });
  await inMonitor(claude, async () => assert.deepEqual((await loadActionInput()).actions[0]!.sources, [{ postId: "first" }]));
});
