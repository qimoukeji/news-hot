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
import { webhookPayloadSchema } from "../webhooks.ts";
import { editorialVersion, editorialRecordVersion } from "../backend/event-editorial.ts";
import { fixture, at } from "./action-fixture.ts";

for (const definition of [codex, claude, grok]) test(`${definition.monitorId} keeps unverified eligibility in API, webhook and agent output`, () => {
  const input = fixture();
  input.events[0]!.scope = { type: "unknown", note: null };
  input.events[0]!.summary = properName("The announcement did not specify which users were eligible.");
  input.editorials = { [input.events[0]!.id]: { status: "ready", version: editorialVersion(input.events[0]!, input), recordVersion: editorialRecordVersion(input.events[0]!) } };
  const snapshot = projectPublicV2(input, definition, Date.parse(at)), event = snapshot.events[0]!;
  assert.equal(event.status, "completed");
  assert.equal(event.scope.type, "unknown");
  assert.doesNotMatch(event.scope.note?.en ?? "", /all users/i);
  assert.deepEqual(eventListSchema.parse({ list: [event], pagination: { limit: null, total: 1, hasMore: false, nextCursor: null } }).list[0]!.scope, event.scope);
  const webhook = webhookPayloadSchema.parse({ schemaVersion: 2, id: "12345678-1234-4234-8234-123456789abc", occurredAt: at,
    platform: definition.publicV2!.platform, eventId: event.id, revision: 1, action: "created", event });
  assert.deepEqual(webhook.event!.scope, event.scope);
  assert.equal(webhook.event!.summary!.en, input.events[0]!.summary!.en);
  const markdown = inMonitor(definition, () => monitorAnswer(snapshot));
  assert.doesNotMatch(markdown, /影响范围：所有用户/);
});
