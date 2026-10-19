import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { webhookPayloadSchema, type WebhookPayload } from "../webhooks.ts";
import { createSubscription, subscriptionInputSchema, webhookSignature, webhookPushEnabled } from "../backend/webhooks.ts";

const payload: WebhookPayload = {
  schemaVersion: 1, id: "12345678-1234-4234-8234-123456789abc", occurredAt: "2026-10-19T04:00:00Z",
  platform: "claude-code", eventId: "shared-event", revision: 1, action: "created",
  event: {
    id: "shared-event", type: "direct_reset", status: "completed", publishedAt: "2026-10-19T04:00:00Z",
    title: { en: "Quota reset", zh: "额度重置", "zh-Hant": "額度重置", ja: "リセット", ko: "초기화", ru: "Сброс", es: "Reinicio" },
    summary: null, time: "2026-10-19T04:00:00Z",
    updates: [{ id: "source-post", action: "confirm", publishedAt: "2026-10-19T04:00:00Z", summary: null,
      source: { sourceId: "x-account:claudeai", url: "https://x.com/claudeai/status/source-post" } }],
    scope: { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null },
  },
};

test("webhook contract preserves all v2 languages and limits withdrawal to a null event", () => {
  assert.deepEqual(webhookPayloadSchema.parse(payload), payload);
  assert.equal(webhookPayloadSchema.safeParse({ ...payload, action: "withdrawn" }).success, false);
  assert.equal(webhookPayloadSchema.safeParse({ ...payload, event: null }).success, false);
  assert.equal(webhookPayloadSchema.safeParse({ ...payload, eventId: "another-event" }).success, false);
  assert.equal(webhookPayloadSchema.safeParse({ ...payload, action: "withdrawn", event: null }).success, true);
  for (const action of ["updated", "restored"]) assert.equal(webhookPayloadSchema.safeParse({ ...payload, action }).success, true);
});

test("webhook contract rejects internal fields, unknown platforms and nonpositive revisions", () => {
  for (const change of [
    { platform: "claude" }, { revision: 0 }, { revision: 1.5 }, { schemaVersion: 2 },
    { occurredAt: "not-a-date" }, { secret: "must-not-leak" },
    { event: { ...payload.event, recognition: { raw: "internal model output" } } },
  ]) assert.equal(webhookPayloadSchema.safeParse({ ...payload, ...change }).success, false);
  for (const platform of ["codex", "claude-code", "grok"]) {
    assert.equal(webhookPayloadSchema.safeParse({ ...payload, platform }).success, true);
  }
});

test("webhook signature authenticates timestamp and exact UTF-8 body bytes", () => {
  const body = JSON.stringify(payload), secret = "synthetic-signing-secret", timestamp = "1792382400";
  const expected = "v1=" + createHmac("sha256", secret).update(timestamp + "." + body).digest("hex");
  assert.equal(webhookSignature(secret, timestamp, body), expected);
  assert.notEqual(webhookSignature(secret, timestamp, body + "\n"), expected);
  assert.notEqual(webhookSignature(secret, "1792382401", body), expected);
  assert.notEqual(webhookSignature("other-secret", timestamp, body), expected);
});

test("subscription validation refuses private addresses, credentials and insecure callbacks before database access", async () => {
  const input = { name: "Synthetic subscriber", url: "https://8.8.8.8/hook", platforms: ["codex"], reason: "Synthetic test" };
  assert.equal(subscriptionInputSchema.parse(input).enabled, false);
  for (const url of ["http://8.8.8.8/hook", "https://127.0.0.1/hook", "https://10.0.0.1/hook", "https://[::1]/hook",
    "https://user:password@8.8.8.8/hook", "https://8.8.8.8/hook#fragment"]) {
    await assert.rejects(createSubscription({ ...input, url }, "test-reviewer"), /回调地址/);
  }
  for (const platforms of [[], ["claude"], ["codex", "codex"]]) {
    assert.equal(subscriptionInputSchema.safeParse({ ...input, platforms }).success, false);
  }
});

test("webhook push safety valve opens only for the literal true setting", () => {
  const previous = process.env.WEBHOOK_PUSH_ENABLED;
  try {
    delete process.env.WEBHOOK_PUSH_ENABLED; assert.equal(webhookPushEnabled(), false);
    for (const value of ["false", "1", "TRUE", " true "]) {
      process.env.WEBHOOK_PUSH_ENABLED = value; assert.equal(webhookPushEnabled(), false);
    }
    process.env.WEBHOOK_PUSH_ENABLED = "true"; assert.equal(webhookPushEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.WEBHOOK_PUSH_ENABLED;
    else process.env.WEBHOOK_PUSH_ENABLED = previous;
  }
});

test("explicit webhook private-network refusal overrides permissive local collection configuration", async () => {
  const previous = config.allowPrivateNetworkFetch;
  try {
    config.allowPrivateNetworkFetch = true;
    await assert.rejects(guardedFetch("https://127.0.0.1/webhook", {
      route: "direct", allowPrivateNetwork: false, timeoutMs: 1000, maxRedirects: 0,
    }), /Blocked private address/);
  } finally { config.allowPrivateNetworkFetch = previous; }
});
