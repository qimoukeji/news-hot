import { bt } from "./business-time-fixture.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { sourcePost, writePostActions, loadActionInput } from "../backend/action-store.ts";
import { monitorEventDetail, previewMonitorEventReview, submitMonitorEventReview } from "../backend/manual-review.ts";
import { properName, publicV2Snapshot } from "../backend/public-v2.ts";
import { sweepConfirmationResults } from "../backend/webhook-events.ts";
import { reduceEvent } from "../actions.ts";
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`; await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`;
});
after(closeDb);
for (const definition of [codex, claude, grok]) test(`${definition.monitorId}: the minute task persists an idempotent source-less confirmation and official proof upgrades it`, async () => inMonitor(definition, async () => {
  const at = "2026-10-10T12:00:00Z";
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status) VALUES(${definition.monitorId},'source',${definition.authors[0]!.handle},${at},'https://example.test/source','Synthetic source','processed')`;
  await sql.begin(async db => writePostActions(db, (await sourcePost("source", db))!, [{ eventId: "event", action: "announce", title: properName("Synthetic plan"), summary: null, time: bt(at) }], { events: [{ id: "event", type: "direct_reset" }] }));
  assert.equal((await publicV2Snapshot()).events[0]!.status, "announced");
  await sweepConfirmationResults([definition]);
  let input = await loadActionInput(); const confirmation = input.actions.find(action => action.sources.length === 0)!;
  assert.equal(confirmation.action, "confirm"); assert.deepEqual(confirmation.time, bt(at));
  assert.equal(confirmation.summary!.zh, "预告时间已到，实际重置状态以账户显示为准");
  assert.equal(confirmation.title.zh, "已到预告时间");
  assert.equal((await publicV2Snapshot()).events[0]!.updates.find(update => update.id === confirmation.id)!.sources.length, 0);
  await sweepConfirmationResults([definition]); assert.equal((await loadActionInput()).actions.length, 2);
  const completed = "2026-10-10T13:00:00Z";
  await sql.begin(async db => writePostActions(db, (await sourcePost("source", db))!, [{ eventId: "event", action: "confirm", title: properName("Officially confirmed"), summary: null, time: bt(completed) }]));
  input = await loadActionInput(); assert.equal(input.actions.length, 2);
  const upgraded = input.actions.find(action => action.id === confirmation.id)!;
  assert.deepEqual(upgraded.sources, [{ postId: "source" }]); assert.deepEqual(upgraded.time, bt(new Date(at).toISOString())); assert.equal(upgraded.sequence, confirmation.sequence);
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "completed");
  assert.equal(JSON.stringify(await publicV2Snapshot()).includes('"confirmation":'), false);
}));

for (const definition of [codex, claude, grok]) test(`${definition.monitorId}: manual confirmation uses ordinary review, without verification commands or sources`, async () => inMonitor(definition, async () => {
  const at = "2026-10-10T12:00:00Z";
  await sql`INSERT INTO monitor_event_records(monitor_id,id,type,created_at) VALUES(${definition.monitorId},'event','direct_reset',${at})`;
  const detail = (await monitorEventDetail("event"))!;
  const body = { version: detail.version, versions: detail.versions, reason: "Private manual explanation", actions: { create: [{ localKey: "manual", eventId: "event", action: "confirm", title: properName("人工核实已生效"), summary: null, time: bt(at) }] } };
  const preview = (await previewMonitorEventReview("event", body))!;
  await submitMonitorEventReview("event", { ...body, previewToken: preview.previewToken }, "test-admin");
  const input = await loadActionInput(); assert.equal(input.actions.length, 1); assert.deepEqual(input.actions[0]!.sources, []); assert.equal(input.posts.length, 0);
  const snapshot = await publicV2Snapshot(); assert.equal(snapshot.events[0]!.status, "completed"); assert.doesNotMatch(snapshot.events[0]!.updates[0]!.title.zh, /人工|验证逻辑/);
  assert.equal(JSON.stringify(snapshot).includes("Private manual explanation"), false);
  assert.ok(JSON.stringify(await sql`SELECT before,after FROM audit_log`).includes("confirm"));
  const latest = (await monitorEventDetail("event"))!;
  await assert.rejects(previewMonitorEventReview("event", { version: latest.version, reason: "test", verification: { outcome: "not_effective", time: null } }));
}));

for (const definition of [codex, claude, grok]) test(`${definition.monitorId}: saved announcement time survives another source and manual wording edits`, async () => inMonitor(definition, async () => {
  const at = "2026-10-10T12:00:00Z";
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status) VALUES(${definition.monitorId},'source',${definition.authors[0]!.handle},${at},'https://example.test/source','Synthetic promise','processed')`;
  await sql.begin(async db => writePostActions(db, (await sourcePost("source", db))!, [{ eventId: "event", action: "announce", title: properName("Another round is coming"), summary: null, time: bt("2026-10-10T18:00:00Z") }], { events: [{ id: "event", type: "reset_credit" }] }));
  let input = await loadActionInput(); const announcement = input.actions[0]!;
  assert.deepEqual(announcement.time, bt("2026-10-10T18:00:00Z"));
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status) VALUES(${definition.monitorId},'second',${definition.authors[0]!.handle},${at},'https://example.test/second','Same promise','processed')`;
  await sql.begin(async db => writePostActions(db, (await sourcePost("second", db))!, [{ id: announcement.id, eventId: "event", action: "announce", title: announcement.title, summary: announcement.summary, time: bt("2026-10-10T18:00:00Z") }]));
  const detail = (await monitorEventDetail("event"))!;
  const body = { version: detail.version, versions: detail.versions, actions: { update: [{ id: announcement.id, action: "announce", title: properName("Next round announced"), summary: null, time: bt("2026-10-10T18:00:00Z") }] } };
  const preview = (await previewMonitorEventReview("event", body))!;
  await submitMonitorEventReview("event", { ...body, previewToken: preview.previewToken }, "test-admin");
  await sweepConfirmationResults([definition], Date.parse("2026-10-10T17:59:59Z"));
  input = await loadActionInput();
  assert.equal(input.actions.length, 1); assert.deepEqual(input.actions[0]!.time, bt("2026-10-10T18:00:00Z")); assert.equal(input.actions[0]!.sources.length, 2);
  const snapshot = await publicV2Snapshot();
  assert.equal(snapshot.hasAnnouncement, true); assert.deepEqual(snapshot.announcedResetTime, bt("2026-10-10T18:00:00Z"));
  assert.equal(snapshot.events[0]!.status, "announced"); assert.deepEqual(snapshot.events[0]!.time, bt("2026-10-10T18:00:00Z"));
}));

test("admin rejects clearing an accepted announcement time", async () => inMonitor(codex, async () => {
  const at = "2026-10-10T12:00:00Z";
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status) VALUES('codex','source',${codex.authors[0]!.handle},${at},'https://example.test/source','Synthetic promise','processed')`;
  await sql.begin(async db => writePostActions(db, (await sourcePost("source", db))!, [{ eventId: "event", action: "announce", title: properName("Reset planned"), summary: null, time: bt(at) }], { events: [{ id: "event", type: "direct_reset" }] }));
  const input = await loadActionInput(), announcement = input.actions[0]!;
  const detail = (await monitorEventDetail("event"))!;
  for (const time of [null, { kind: "date", date: "2026-10-10", timeZone: "UTC" }, { kind: "unknown" }]) {
    const body = { version: detail.version, versions: detail.versions, actions: { update: [{ id: announcement.id, action: "announce", title: announcement.title, summary: null, time }] } };
    await assert.rejects(previewMonitorEventReview("event", body));
  }
  assert.deepEqual((await loadActionInput()).actions[0]!.time, announcement.time);
}));

test("correcting an announcement invalidates the old inference even at the same boundary", async () => inMonitor(codex, async () => {
  const at = "2026-10-10T12:00:00Z";
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status) VALUES('codex','source',${codex.authors[0]!.handle},${at},'https://example.test/source','Synthetic promise','processed')`;
  await sql.begin(async db => writePostActions(db, (await sourcePost("source", db))!, [{ eventId: "event", action: "announce", title: properName("Reset planned"), summary: null, time: bt(at) }], { events: [{ id: "event", type: "direct_reset" }] }));
  await sweepConfirmationResults([codex]);
  const input = await loadActionInput(), announcement = input.actions.find(action => action.action === "announce")!, confirmation = input.actions.find(action => !action.sources.length)!;
  const detail = (await monitorEventDetail("event"))!;
  const time = { kind: "deadline", at } as const;
  const body = { version: detail.version, versions: detail.versions, actions: { update: [{ id: announcement.id, action: "announce", title: announcement.title, summary: announcement.summary, time }] } };
  const preview = (await previewMonitorEventReview("event", body))!;
  await submitMonitorEventReview("event", { ...body, previewToken: preview.previewToken }, "test-admin");
  const saved = await loadActionInput(), latest = saved.actions.find(action => action.id === announcement.id)!;
  assert.equal(latest.action, "announce"); assert.equal(latest.id, announcement.id); assert.equal(latest.sequence, announcement.sequence); assert.equal(saved.actions.length, 2); assert.deepEqual(latest.time, time);
  assert.ok(saved.actions.some(action => action.id === confirmation.id));
  const snapshot = await publicV2Snapshot();
  assert.equal(snapshot.events[0]!.status, "announced"); assert.deepEqual(snapshot.announcedResetTime, time); assert.equal(snapshot.resetTime, null);
  const reread = (await monitorEventDetail("event"))!;
  const restore = { ...body, version: reread.version, versions: reread.versions, actions: { update: [{ ...body.actions.update[0], time: bt(at) }] } };
  const restorePreview = (await previewMonitorEventReview("event", restore))!;
  await submitMonitorEventReview("event", { ...restore, previewToken: restorePreview.previewToken }, "test-admin");
  assert.equal((await publicV2Snapshot()).events[0]!.status, "announced", "returning to the old time does not revive old confirmation");
  await sweepConfirmationResults([codex]);
  const completed = await publicV2Snapshot();
  assert.equal(completed.events[0]!.status, "completed");
  assert.notEqual(reduceEvent(saved.events[0]!, await loadActionInput())!.confirmationId, confirmation.id);
}));

test("new manual confirmations reject future instants", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T00:00:00Z") });
  await inMonitor(codex, async () => {
    await sql`INSERT INTO monitor_event_records(monitor_id,id,type,created_at) VALUES('codex','event','direct_reset','2026-11-01T12:00:00Z')`;
    const detail = (await monitorEventDetail("event"))!;
    const time = { kind: "instant", at: "2026-11-02T08:00:00Z" } as const;
    const body = { version: detail.version, versions: detail.versions, actions: { create: [{ localKey: "manual", eventId: "event", action: "confirm", title: properName("Quota restored"), summary: null, time }] } };
    await assert.rejects(previewMonitorEventReview("event", body), /不能在未来/);
    assert.ok(await previewMonitorEventReview("event", { ...body, actions: { create: [{ ...body.actions.create[0]!, time: { ...time, at: "2026-11-01T08:00:00Z" } }] } }));
  });
});

test("editing an announcement preserves its inferred instant in the source zone", async t => {
  const now = Date.parse("2026-11-03T06:00:00Z"), sourceAt = "2026-10-10T12:00:00Z";
  t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  await inMonitor(codex, async () => {
    const time = { kind: "instant", at: "2026-11-03T06:00:00Z" } as const;
    await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status) VALUES('codex','source',${codex.authors[0]!.handle},${sourceAt},'https://example.test/source','Synthetic source','processed')`;
    await sql.begin(async db => writePostActions(db, (await sourcePost("source", db))!, [{ eventId: "event", action: "announce", title: properName("Reset scheduled"), summary: null, time }], { events: [{ id: "event", type: "direct_reset" }] }));
    await sweepConfirmationResults([codex], now);
    const input = await loadActionInput(), confirmation = input.actions.find(action => action.sources.length === 0)!;
    assert.ok(confirmation);
    const announcement = input.actions.find(action => action.action === "announce")!;
    const detail = (await monitorEventDetail("event"))!;
    const body = { version: detail.version, versions: detail.versions, actions: { update: [{ id: announcement.id, action: "announce", invalidatesEvent: false, title: properName("Corrected announcement wording"), summary: null, time }] } };
    const preview = (await previewMonitorEventReview("event", body))!;
    await submitMonitorEventReview("event", { ...body, previewToken: preview.previewToken }, "test-admin");
    const saved = (await loadActionInput()).actions.find(action => action.id === confirmation.id)!;
    assert.deepEqual(saved.time, bt("2026-11-03T06:00:00Z"));
    assert.deepEqual(saved.sources, []);
  });
});
