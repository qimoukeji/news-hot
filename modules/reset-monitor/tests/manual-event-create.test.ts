import { listEvents } from "./admin-fixture.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { buildApp } from "../../../apps/api/src/app.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { createMonitorServer } from "../server.ts";
import { createMonitorEvent, listMonitorEntries, } from "../backend/admin.ts";
import { loadActionInput } from "../backend/action-store.ts";
import { monitorEventDetail, previewMonitorEventReview, submitMonitorEventReview } from "../backend/manual-review.ts";
import { properName, publicV2Snapshot } from "../backend/public-v2.ts";

const definitions = [codex, claude, grok];
const previousAdmin = config.devAdmin;
const scope = { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null } as const;
beforeEach(async () => {
  config.devAdmin = null;
  installModules(definitions.map(createMonitorServer));
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM audit_log`;
});
after(async () => { config.devAdmin = previousAdmin; installModules([]); await closeDb(); });

for (const definition of definitions) test(`${definition.monitorId}: manual event creation is private until its first action`, async () => inMonitor(definition, async () => {
  const before = Date.now();
  const event = await createMonitorEvent({ type: "direct_reset", title: properName("Manual quota event"), summary: null, scope }, "manual-admin");
  assert.match(event.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  assert.ok(Date.parse(event.createdAt) >= before && Date.parse(event.createdAt) <= Date.now());
  assert.equal(typeof event.version, "string");
  assert.equal(event.withdrawn, false);
  let input = await loadActionInput();
  assert.equal(input.events.length, 1); assert.equal(input.actions.length, 0); assert.equal(input.posts.length, 0);
  const entries = await listMonitorEntries({ kind: "events" });
  assert.equal(entries.rows.length, 1);
  const row = entries.rows[0]!; assert.equal(row.kind, "event");
  if (row.kind === "event") {
    assert.equal(row.event.id, event.id); assert.equal(row.event.status, null); assert.equal(row.event.time, null);
    assert.equal(row.event.actionCount, 0); assert.equal(row.event.sourcePostCount, 0); assert.deepEqual(row.event.timeline, []);
  }
  assert.equal((await listEvents({ visibility: "unpublished" })).events[0]!.id, event.id);
  let snapshot = await publicV2Snapshot();
  assert.deepEqual(snapshot.events, []); assert.equal(snapshot.resetTime, null); assert.equal(snapshot.statistics.resetsLast30Days, 0);
  assert.equal((await sql`SELECT 1 FROM monitor_webhook_notifications`).length, 0);
  const [audit] = await sql`SELECT actor,action,subject,reason,before,after FROM audit_log`;
  assert.equal(audit!.actor, "manual-admin"); assert.equal(audit!.action, definition.names.auditActionPrefix + ".create");
  assert.equal(audit!.reason, "创建事件"); assert.equal(audit!.before, null); assert.equal(audit!.after.id, event.id);

  const detail = (await monitorEventDetail(event.id))!;
  const time = new Date(Date.now() - 3600_000).toISOString();
  const body = { version: detail.version, versions: detail.versions, actions: { create: [{ localKey: "initial", eventId: event.id, action: "confirm", title: properName("人工核实已生效"), summary: null, time }] } };
  const preview = (await previewMonitorEventReview(event.id, body))!;
  await submitMonitorEventReview(event.id, { ...body, previewToken: preview.previewToken }, "manual-admin");
  input = await loadActionInput(); assert.equal(input.events.length, 1); assert.equal(input.actions.length, 1); assert.equal(input.posts.length, 0);
  snapshot = await publicV2Snapshot();
  assert.equal(snapshot.events[0]!.id, event.id); assert.equal(snapshot.events[0]!.status, "completed");
  assert.equal(snapshot.statistics.resetsLast30Days, 1); assert.equal(snapshot.events[0]!.updates.length, 1);
}));

test("manual creation requires a Chinese title and rejects business facts, foreign fields and unsupported scope", async () => inMonitor(codex, async () => {
  const valid = { type: "direct_reset", title: { zh: "人工创建" } };
  for (const body of [
    {}, { title: { zh: "缺类型" } }, { type: "direct_reset" }, { ...valid, title: { en: "No Chinese title" } }, { ...valid, title: { zh: "   " } },
    { ...valid, type: "unknown" }, { ...valid, status: "completed" }, { ...valid, time: "2026-10-27" },
    { ...valid, id: "client-id" }, { ...valid, monitorId: "grok" }, { ...valid, actions: [] }, { ...valid, posts: [] }, { ...valid, sources: [] },
    { ...valid, scope: { ...scope, productCodes: ["unknown-product"] } },
  ]) await assert.rejects(createMonitorEvent(body, "manual-admin"));
  await assert.rejects(inMonitor({ ...codex, eventKinds: ["direct_reset"] }, () => createMonitorEvent({ ...valid, type: "bonus_credit" }, "manual-admin")), /不支持事件类型/);
  assert.equal((await loadActionInput()).events.length, 0); assert.equal((await sql`SELECT 1 FROM audit_log`).length, 0);
  const saved = await createMonitorEvent({ ...valid, title: { zh: "  人工创建  " }, summary: null, scope: null }, "manual-admin");
  assert.equal(saved.title!.zh, "人工创建"); assert.equal(saved.summary, null); assert.equal(saved.scope, null);
}));

test("manual event POST requires an administrator and CSRF and creates no actions or notifications", async () => {
  const app = await buildApp();
  const payload = { type: "direct_reset", title: { zh: "后台创建事件" } };
  try {
    for (const definition of definitions) {
      const url = definition.adminApiPath + "/events";
      assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401);
    }
    config.devAdmin = { displayName: "Manual event creator" };
    for (const definition of definitions) {
      const url = definition.adminApiPath + "/events";
      assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 403);
      const response = await app.inject({ method: "POST", url, payload, headers: { "x-csrf-token": "dev" } });
      assert.equal(response.statusCode, 201, response.body);
      const event = response.json(); assert.ok(event.id); assert.ok(event.version); assert.ok(event.createdAt);
      await inMonitor(definition, async () => {
        const input = await loadActionInput(); assert.equal(input.events.length, 1); assert.equal(input.actions.length, 0); assert.equal(input.posts.length, 0);
        assert.deepEqual((await publicV2Snapshot()).events, []);
      });
      const invalid = await app.inject({ method: "POST", url, payload: { ...payload, status: "completed" }, headers: { "x-csrf-token": "dev" } });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    assert.equal((await sql`SELECT 1 FROM monitor_webhook_notifications`).length, 0);
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE actor='dev:Manual event creator'`).length, 3);
  } finally { await app.close(); }
});
