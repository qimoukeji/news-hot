import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { beforeEach, after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { createMonitorEvent, listMonitorEntries } from "../backend/admin.ts";
import { monitorEventDetail, previewMonitorEventReview, submitMonitorEventReview } from "../backend/manual-review.ts";
import { publicV2Snapshot, properName } from "../backend/public-v2.ts";
import { processPublicV2Pending } from "../backend/public-v2-generate.ts";
import { sweepConfirmationResults } from "../backend/webhook-events.ts";
import { createSubscription } from "../backend/webhooks.ts";
import { webhookPayloadSchema } from "../webhooks.ts";
import { createMonitorServer } from "../server.ts";

const definitions = [codex, claude, grok];
beforeEach(async () => {
  await sql`DELETE FROM monitor_webhook_deliveries`; await sql`DELETE FROM monitor_webhook_notifications`; await sql`DELETE FROM monitor_webhook_subscriptions`;
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`; await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`;
});
after(async () => { installModules([]); await stopBoss(); await closeDb(); });
async function subscribe(platform: "codex" | "claude-code" | "grok") {
  return createSubscription({ name: "Manual event test", url: "https://8.8.8.8/hook", platforms: [platform], enabled: true, reason: "Local integration test" }, "test-admin", definitions);
}
async function confirm(id: string) {
  const detail = (await monitorEventDetail(id))!;
  const body = { version: detail.version, versions: detail.versions, actions: { create: [{ localKey: "confirmation", eventId: id, action: "confirm", title: properName("人工核实已生效"), summary: null, time: "2026-10-26T08:00:00Z" }] } };
  const preview = (await previewMonitorEventReview(id, body))!;
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
  await submitMonitorEventReview(id, { ...body, previewToken: preview.previewToken }, "test-admin");
}

for (const definition of definitions) for (const baselineFirst of [true, false]) test(`${definition.monitorId}: first manual action sends created once with baseline ${baselineFirst ? "before" : "after"} draft creation`, async () => inMonitor(definition, async () => {
  if (baselineFirst) await subscribe(definition.publicV2!.platform);
  const draft = await createMonitorEvent({ type: "direct_reset", title: properName("Manually created event"), summary: null, scope: null }, "test-admin");
  assert.equal((await listMonitorEntries({ kind: "events" })).rows[0]!.kind, "event");
  assert.equal((await publicV2Snapshot()).events.length, 0);
  assert.equal((await publicV2Snapshot()).statistics.resetsLast30Days, 0);
  assert.equal((await sql`SELECT id FROM monitor_event_actions`).length, 0);
  if (!baselineFirst) await subscribe(definition.publicV2!.platform);
  await sweepConfirmationResults(definitions); await sweepConfirmationResults(definitions);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
  await confirm(draft.id);
  await sweepConfirmationResults(definitions); await sweepConfirmationResults(definitions);
  const notifications = await sql`SELECT payload FROM monitor_webhook_notifications ORDER BY revision`;
  assert.equal(notifications.length, 1);
  const payload = webhookPayloadSchema.parse(notifications[0]!.payload);
  assert.equal(payload.action, "created"); assert.equal(payload.eventId, draft.id); assert.equal(payload.revision, 1);
  assert.deepEqual(payload.event!.updates[0]!.sources, []);
  assert.equal((await publicV2Snapshot()).events[0]!.id, draft.id);
  assert.equal((await publicV2Snapshot()).statistics.resetsLast30Days, 1);
}));

test("translating a draft cannot notify early or suppress its first later action", async () => inMonitor(codex, async () => {
  const model = await stub((_hit, request) => {
    const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content);
    const content = Object.fromEntries(["title", "summary", "note"].map(key => [key, input[key] ? properName(Object.values(input[key])[0] as string) : null]));
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  });
  const env = { MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "synthetic-local-key", LLM_MODEL: "synthetic-manual-event" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const oldPrivate = config.allowPrivateNetworkFetch, oldCalls = config.modelCallsEnabled;
  try {
    Object.assign(process.env, env); config.allowPrivateNetworkFetch = true; config.modelCallsEnabled = true;
    installModules(definitions.map(createMonitorServer));
    const draft = await createMonitorEvent({ type: "direct_reset", title: { zh: "人工创建事件" }, summary: { zh: "仅事件信息" } }, "test-admin");
    await subscribe("codex");
    assert.deepEqual(await processPublicV2Pending(), { enriched: 1 });
    assert.equal((await publicV2Snapshot()).events.length, 0);
    assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
    await confirm(draft.id);
    const rows = await sql`SELECT payload FROM monitor_webhook_notifications`;
    assert.equal(rows.length, 1); assert.equal(webhookPayloadSchema.parse(rows[0]!.payload).action, "created");
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    config.allowPrivateNetworkFetch = oldPrivate; config.modelCallsEnabled = oldCalls; await model.close();
  }
}));
