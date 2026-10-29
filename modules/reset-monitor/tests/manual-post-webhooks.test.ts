import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { beforeEach, after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { createMonitorEvent, createMonitorPost, updateMonitorPost } from "../backend/admin.ts";
import { loadActionInput } from "../backend/action-store.ts";
import { monitorEventDetail, previewMonitorEventReview, submitMonitorEventReview } from "../backend/manual-review.ts";
import { properName, publicV2Snapshot } from "../backend/public-v2.ts";
import { captureWebhookEvent } from "../backend/webhook-events.ts";
import { createSubscription } from "../backend/webhooks.ts";
import { webhookPayloadSchema } from "../webhooks.ts";
const definitions = [codex, claude, grok];
beforeEach(async () => {
  await sql`DELETE FROM monitor_webhook_deliveries`; await sql`DELETE FROM monitor_webhook_notifications`; await sql`DELETE FROM monitor_webhook_subscriptions`;
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`; await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`;
});
after(async () => { await stopBoss(); await closeDb(); });

for (const definition of definitions) test(`${definition.monitorId}: post creation and editing are private until explicitly associated with an event action`, async () => inMonitor(definition, async () => {
  await createSubscription({ name: "Manual source test", url: "https://8.8.8.8/hook", platforms: [definition.publicV2!.platform], enabled: true, reason: "Local integration test" }, "test-admin", definitions);
  const post = await createMonitorPost({ author: definition.authors[0]!.handle, publishedAt: "2026-10-26T08:00:00Z",
    url: `https://x.com/${definition.authors[0]!.handle}/status/987654321`, title: properName("Saved manual source"), summary: null, text: "Private original source body" }, "test-admin");
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
  assert.equal((await publicV2Snapshot()).events.length, 0);
  assert.equal((await loadActionInput()).actions.length, 0);
  const event = await createMonitorEvent({ type: "direct_reset", title: properName("Event for manual source") }, "test-admin");
  const detail = (await monitorEventDetail(event.id))!;
  const body = { version: detail.version, versions: detail.versions,
    actions: { create: [{ localKey: "initial", eventId: event.id, action: "announce", title: properName("Explicit future announcement"), summary: null, time: "2099-01-01" }] },
    sources: { add: [{ actionKey: "initial", postId: post.id }] } };
  const preview = (await previewMonitorEventReview(event.id, body))!;
  await submitMonitorEventReview(event.id, { ...body, previewToken: preview.previewToken }, "test-admin");
  let notifications = await sql`SELECT payload FROM monitor_webhook_notifications ORDER BY revision`;
  assert.equal(notifications.length, 1); const payload = webhookPayloadSchema.parse(notifications[0]!.payload);
  assert.equal(payload.action, "created"); assert.equal(payload.event!.updates[0]!.sources[0]!.postId, post.id);
  const before = await loadActionInput();
  await updateMonitorPost(post.id, { version: post.version, patch: { title: { zh: "仅编辑帖子中文标题" }, summary: { zh: "仅编辑帖子中文摘要" } } }, "test-admin");
  await sql.begin(db => captureWebhookEvent(db, event.id));
  notifications = await sql`SELECT payload FROM monitor_webhook_notifications ORDER BY revision`;
  assert.equal(notifications.length, 1);
  const after = await loadActionInput();
  assert.deepEqual(after.actions, before.actions); assert.deepEqual(after.events, before.events);
  assert.equal(after.posts[0]!.processing_status, "processed"); assert.equal(after.posts[0]!.text, "Private original source body");
  assert.equal(JSON.stringify(await publicV2Snapshot()).includes("Private original source body"), false);
  assert.equal(JSON.stringify(await sql`SELECT before,after FROM audit_log`).includes("Private original source body"), false);
}));
