import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { monitorAnswer } from "../backend/agent.ts";
import { projectPublicV2, properName } from "../backend/public-v2.ts";
import { eventListSchema } from "../public-v2.ts";
import { defaultScopeLabel } from "../backend/scope-labels.ts";
import { webhookPayloadSchema } from "../webhooks.ts";
import { fixture, at } from "./action-fixture.ts";

for (const definition of [codex, claude, grok]) test(`${definition.monitorId} keeps incomplete scope in API, webhook and agent output`, () => {
  const input = fixture();
  const plan = definition.publicV2!.catalog.plans[0]?.code;
  const note = defaultScopeLabel("unknown");
  input.events[0]!.scope = { type: "unknown", productCodes: [], planCodes: plan ? [plan] : [], quotaWindowCodes: [], note };
  input.events[0]!.summary = properName("Only eligible accounts in the announced products; exact catalog mapping is unavailable.");
  const snapshot = projectPublicV2(input, definition, Date.parse(at)), event = snapshot.events[0]!;
  assert.equal(event.status, "completed");
  assert.deepEqual(event.scope, input.events[0]!.scope);
  assert.deepEqual(eventListSchema.parse({ list: [event], pagination: { limit: null, total: 1, hasMore: false, nextCursor: null } }).list[0]!.scope, event.scope);
  const webhook = webhookPayloadSchema.parse({ schemaVersion: 2, id: "12345678-1234-4234-8234-123456789abc", occurredAt: at,
    platform: definition.publicV2!.platform, eventId: event.id, revision: 1, action: "created", event });
  assert.deepEqual(webhook.event!.scope, event.scope);
  assert.equal(webhook.event!.summary!.en, input.events[0]!.summary!.en);
  const markdown = inMonitor(definition, () => monitorAnswer(snapshot));
  assert.match(markdown, /影响范围：所有用户/);
  assert.match(markdown, /不能据此断言覆盖所有用户或所有产品/);
});
