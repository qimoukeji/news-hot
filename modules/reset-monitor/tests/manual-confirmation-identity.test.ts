import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { loadActionInput, sourcePost, writePostActions } from "../backend/action-store.ts";
import { monitorEventDetail, previewMonitorEventReview, submitMonitorEventReview } from "../backend/manual-review.ts";
import { properName, publicV2Snapshot } from "../backend/public-v2.ts";
import { inferredConfirmation } from "../backend/confirmation.ts";
import { reduceEvent, type ActionDraft } from "../actions.ts";

const at = "2026-10-11T12:00:00Z", manualAt = "2026-10-11T19:00:00Z";
const instant = (at: string) => ({ kind: "instant" as const, at });
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`; await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`;
});
after(closeDb);
async function initialize() {
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status)
    VALUES('codex','source',${codex.authors[0]!.handle},${at},'https://example.test/source','We will reset usage.','processed')`;
  await sql.begin(async db => writePostActions(db, (await sourcePost("source", db))!, [{ eventId: "event", action: "announce",
    title: properName("Reset planned"), summary: null, time: instant("2026-10-11T18:00:00Z") }],
  { events: [{ id: "event", type: "direct_reset" }] }));
  const input = await loadActionInput(), event = input.events[0]!;
  const automatic = inferredConfirmation(event, input, Date.parse(manualAt))!;
  assert.ok(automatic);
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,summary,time,sources,created_at,updated_at)
    VALUES('codex',${automatic.id},${event.id},2,'confirm',${sql.json(automatic.title)},${sql.json(automatic.summary!)},${sql.json(automatic.time)},'[]'::jsonb,${automatic.created_at},${automatic.updated_at})`;
  return { automatic, announcement: input.actions[0]! };
}
async function edit(actions: { create?: unknown[]; update?: unknown[] }, extra: Record<string, unknown> = {}) {
  const detail = (await monitorEventDetail("event"))!;
  const body = { version: detail.version, versions: detail.versions, actions, ...extra };
  const preview = (await previewMonitorEventReview("event", body))!;
  await submitMonitorEventReview("event", { ...body, previewToken: preview.previewToken }, "test-admin");
}
for (const method of ["create", "update"] as const) for (const revisedBy of ["admin", "recognition"] as const)
  test(`${method} manual confirmation retains its identity and completion after ${revisedBy} refines the plan`, async () => inMonitor(codex, async () => {
    const { automatic, announcement } = await initialize();
    const confirmation = { action: "confirm", title: properName("Reset completed"), summary: null, time: instant(manualAt) };
    await edit(method === "create" ? { create: [{ ...confirmation, localKey: "manual", eventId: "event" }] }
      : { update: [{ ...confirmation, id: automatic.id }] });
    let input = await loadActionInput();
    assert.equal(input.actions.length, 2);
    assert.ok(input.manualConfirmationIds?.has(automatic.id), "manual identity survives loading a fresh database snapshot");
    const revised: ActionDraft = { id: announcement.id, eventId: "event", action: "announce", title: announcement.title,
      summary: announcement.summary, time: instant("2026-10-12T20:00:00Z") };
    if (revisedBy === "admin") await edit({ update: [revised] });
    else {
      await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status)
        VALUES('codex','followup',${codex.authors[0]!.handle},${manualAt},'https://example.test/followup','The usage reset is scheduled for tomorrow.','processed')`;
      await sql.begin(async db => writePostActions(db, (await sourcePost("followup", db))!, [revised],
        { refineAnnouncementIds: new Set([announcement.id]) }));
    }
    input = await loadActionInput();
    assert.equal(input.actions.length, 2);
    assert.equal(input.actions.find(action => action.id === automatic.id)!.sequence, 2);
    assert.equal(input.invalidatedInferenceIds?.has(automatic.id), false);
    assert.equal(reduceEvent(input.events[0]!, input)!.status, "completed");
    assert.deepEqual(reduceEvent(input.events[0]!, input)!.confirmedTime, instant(manualAt));
    const output = await publicV2Snapshot();
    assert.equal(output.events[0]!.updates.find(update => update.id === automatic.id)!.action, "confirm");
    assert.equal(JSON.stringify(output).includes("manualConfirmationIds"), false);
    assert.ok(JSON.stringify(await sql`SELECT after FROM audit_log`).includes("manualConfirmationIds"));
  }));

test("an unchanged explicit manual confirmation still records its identity and changes the record version", async () => inMonitor(codex, async () => {
  const { automatic } = await initialize();
  const before = (await loadActionInput()).actions.find(action => action.id === automatic.id)!;
  await edit({ update: [{ id: before.id, action: before.action, title: before.title, summary: before.summary, time: before.time }] });
  const input = await loadActionInput(), saved = input.actions.find(action => action.id === before.id)!;
  assert.ok(input.manualConfirmationIds?.has(saved.id));
  assert.notEqual(new Date(saved.updated_at).getTime(), new Date(before.updated_at).getTime());
  assert.equal(saved.id, before.id); assert.deepEqual(saved.time, before.time);
}));

test("manual correction restores a retired inference without losing its ID or retaining invalidation state", async () => inMonitor(codex, async () => {
  const { automatic, announcement } = await initialize();
  await edit({ update: [{ id: announcement.id, action: "announce", title: announcement.title, summary: null,
    time: instant("2026-10-12T20:00:00Z") }] });
  let input = await loadActionInput();
  assert.ok(input.invalidatedInferenceIds?.has(automatic.id));
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "announced");
  await edit({ update: [{ id: automatic.id, action: "confirm", title: properName("Reset completed"), summary: null, time: instant(manualAt) }] });
  input = await loadActionInput();
  assert.ok(input.manualConfirmationIds?.has(automatic.id));
  assert.equal(input.invalidatedInferenceIds?.has(automatic.id), false);
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "completed");
  assert.deepEqual(reduceEvent(input.events[0]!, input)!.confirmedTime, instant(manualAt));
}));

test("official evidence removes the manual marker and subsequent source removal cleans confirmation state", async () => inMonitor(codex, async () => {
  const { automatic } = await initialize();
  await edit({ update: [{ id: automatic.id, action: "confirm", title: properName("Reset completed"), summary: null, time: instant(manualAt) }] });
  await sql.begin(async db => writePostActions(db, (await sourcePost("source", db))!, [{ id: automatic.id, eventId: "event", action: "confirm",
    title: properName("Official confirmation"), summary: null, time: instant(at) }]));
  let input = await loadActionInput();
  assert.equal(input.manualConfirmationIds?.has(automatic.id), false);
  assert.deepEqual(input.actions.find(action => action.id === automatic.id)!.sources, [{ postId: "source" }]);
  await edit({}, { sources: { remove: [{ actionId: automatic.id, postId: "source" }] } });
  input = await loadActionInput();
  assert.ok(!input.actions.some(action => action.id === automatic.id));
  assert.equal(input.manualConfirmationIds?.has(automatic.id), false);
  assert.equal(input.invalidatedInferenceIds?.has(automatic.id), false);
}));
