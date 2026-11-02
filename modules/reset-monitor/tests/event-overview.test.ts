import { bt } from "./business-time-fixture.ts";
import { stub, gate } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { inMonitor } from "../backend/context.ts";
import { loadActionInput, sourcePost, writePostActions } from "../backend/action-store.ts";
import { processPublicV2Pending } from "../backend/public-v2-generate.ts";
import { processEventOverviews } from "../backend/event-overview.ts";
import { properName, publicV2Snapshot } from "../backend/public-v2.ts";
import { initializeWebhookBaselines } from "../backend/webhook-events.ts";
import { enqueuePublicV2 } from "../backend/public-v2-work.ts";
import { editorialKey } from "../backend/event-editorial.ts";
import { updateMonitorEvent } from "../backend/admin.ts";
import { rowVersion } from "../backend/action-store.ts";
import { exportPublicV2, previewPublicV2, applyPublicV2 } from "../backend/public-v2-review.ts";
import { editorialReady } from "../backend/event-editorial.ts";

let beforeReply: (() => Promise<void>) | null = null;
let invalid = false;
const inputs: any[] = [];
const model = await stub(async (_hit, request) => {
  const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content);
  inputs.push(input);
  if (beforeReply) { const run = beforeReply; beforeReply = null; await run(); }
  if (!("status" in input)) {
    const fill = (text: Record<string, string> | null) => text ? { ...properName(Object.values(text)[0]!), ...text } : null;
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ title: fill(input.title), summary: fill(input.summary), note: fill(input.note) }) } }] };
  }
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    title: properName(invalid ? "人工核实已生效" : `Whole activity: ${input.status}`),
    summary: properName("This overview summarizes the activity's scope, schedule and result."),
  }) } }] };
});
Object.assign(process.env, { MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "synthetic", LLM_MODEL: "synthetic-overviews" });
config.allowPrivateNetworkFetch = true;
installModules([createMonitorServer(codex)]);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM receipts`; await sql`DELETE FROM budgets`;
  await sql`DELETE FROM monitor_webhook_deliveries`; await sql`DELETE FROM monitor_webhook_notifications`; await sql`DELETE FROM monitor_webhook_subscriptions`;
  inputs.length = 0; beforeReply = null; invalid = false; config.modelCallsEnabled = true;
});
after(async () => { installModules([]); await model.close(); await closeDb(); });

async function seed(action: "announce" | "confirm" = "announce") {
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,processing_status)
    VALUES('codex','post','thsottiaux','2026-11-02T00:00:00Z','https://example.test/post',${sql.json(properName("Source"))},'processed')`;
  await sql.begin(async db => {
    await writePostActions(db, (await sourcePost("post", db))!, [{ eventId: "event", action, title: properName(`Individual ${action}`), summary: null, time: bt("2026-11-02") }],
      { events: [{ id: "event", type: "direct_reset", title: properName("Original announcement") }] });
    await enqueuePublicV2(db, ["event"]);
  });
}
async function complete() {
  await sql.begin(async db => {
    await writePostActions(db, (await sourcePost("post", db))!, [{ eventId: "event", action: "confirm", title: properName("Individual confirmation"), summary: null, time: bt("2026-11-02T02:00:00Z") }]);
    await enqueuePublicV2(db, ["event"]);
  });
}

test("minute worker generates independent overviews once per facts version and updates after confirmation", async () => inMonitor(codex, async () => {
  await seed();
  assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
  assert.equal((await processPublicV2Pending()).overviews, 1);
  let event = (await publicV2Snapshot()).events[0]!;
  assert.equal(event.title.en, "Whole activity: announced"); assert.notEqual(event.title.en, event.updates[0]!.title.en);
  assert.equal((await processEventOverviews()).overviews, 0); assert.equal(inputs.length, 1);
  await complete();
  event = (await publicV2Snapshot()).events[0]!;
  assert.equal(event.status, "completed"); assert.equal(event.summary, null); assert.notEqual(event.title.en, "Whole activity: announced");
  assert.equal((await processPublicV2Pending()).overviews, 1);
  assert.equal((await publicV2Snapshot()).events[0]!.title.en, "Whole activity: completed");
  assert.equal(inputs[1].actions.length, 2); assert.equal("text" in inputs[1].actions[0], false);
  assert.equal((await processEventOverviews()).overviews, 0);
}));

test("concurrent action changes discard the old model response", async () => inMonitor(codex, async () => {
  await seed(); const entered = gate(), release = gate();
  beforeReply = async () => { entered.open(); await release.promise; };
  const processing = processEventOverviews();
  try { await entered.promise; await complete(); } finally { release.open(); }
  assert.equal((await processing).overviews, 0);
  assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
  await processEventOverviews();
  assert.equal((await publicV2Snapshot()).events[0]!.title.en, "Whole activity: completed");
}));

test("concurrent event edits survive generation and later actions invalidate their version", async () => inMonitor(codex, async () => {
  await seed(); const entered = gate(), release = gate();
  beforeReply = async () => { entered.open(); await release.promise; };
  const processing = processEventOverviews();
  try {
    await entered.promise; const row = (await loadActionInput()).events[0]!;
    await updateMonitorEvent(row.id, { version: rowVersion(row), patch: { title: properName("Independent edited overview") } }, "reviewer");
  } finally { release.open(); }
  assert.equal((await processing).overviews, 0);
  assert.equal((await publicV2Snapshot()).events[0]!.title.en, "Independent edited overview");
  await complete(); assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
  await processEventOverviews(); assert.equal((await publicV2Snapshot()).events[0]!.title.en, "Whole activity: completed");
}));

test("operational output fails closed without repeated purchases; disabled models make no calls", async () => inMonitor(codex, async () => {
  await seed(); config.modelCallsEnabled = false; assert.equal((await processEventOverviews()).overviews, 0); assert.equal(inputs.length, 0);
  config.modelCallsEnabled = true; invalid = true;
  assert.equal((await processEventOverviews()).overviews, 0); assert.equal(inputs.length, 1);
  assert.equal((await processEventOverviews()).overviews, 0); assert.equal(inputs.length, 1);
  assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
  const [state] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${editorialKey("event")}`;
  assert.equal(state!.value.status, "needs_review");
}));

test("overview-only refresh preserves notification count and revision", async () => inMonitor(codex, async () => {
  await seed(); await initializeWebhookBaselines([codex], Date.parse("2026-11-01T00:00:00Z"));
  await complete();
  const [before] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='webhook:event:event'`;
  await processEventOverviews();
  const [after] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='webhook:event:event'`;
  assert.equal(after!.value.revision, before!.value.revision);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
  assert.notEqual(after!.value.fingerprint, before!.value.fingerprint);
}));

test("budget rejection leaves the overview eligible after budget restoration", async () => inMonitor(codex, async () => {
  await seed(); await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('llm',0,100,100)`;
  await assert.rejects(processEventOverviews(), /Budget for llm exhausted/);
  assert.equal(inputs.length, 0);
  assert.equal((await sql`SELECT 1 FROM monitor_state WHERE monitor_id='codex' AND key=${editorialKey("event")}`).length, 0);
  await sql`UPDATE budgets SET per_minute=100 WHERE service='llm'`;
  assert.equal((await processEventOverviews()).overviews, 1);
}));

test("source-free completion uses neutral program text without calling the overview model", async () => inMonitor(codex, async () => {
  await seed();
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,invalidates_event,title,summary,time,sources)
    VALUES('codex','elapsed','event',2,'confirm',false,${sql.json(properName("已到预告时间"))},NULL,${sql.json(bt("2026-11-02"))},'[]'::jsonb)`;
  assert.equal((await processPublicV2Pending()).overviews, 1);
  assert.equal(inputs.length, 0);
  const event = (await publicV2Snapshot()).events[0]!;
  assert.equal(event.status, "completed"); assert.match(event.title.zh, /状态已更新/);
  assert.match(event.summary!.zh, /账户显示为准/); assert.doesNotMatch(event.title.zh, /官方|人工|验证逻辑/);
}));

test("completing scope translations preserves the event text edited for the same facts", async () => inMonitor(codex, async () => {
  await seed(); const row = (await loadActionInput()).events[0]!;
  await updateMonitorEvent(row.id, { version: rowVersion(row), patch: {
    title: { zh: "本轮额度活动概述" }, summary: null,
    scope: { type: "selected_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: { zh: "符合活动条件的账户" } },
  } }, "reviewer");
  assert.deepEqual(await processPublicV2Pending(), { enriched: 1 });
  assert.equal((await publicV2Snapshot()).events[0]!.title.zh, "本轮额度活动概述");
  assert.equal(inputs.length, 1); assert.equal("status" in inputs[0], false, "only translation was needed");
}));

for (const partialEvent of [false, true]) test(`action translation preserves a current ${partialEvent ? "partially translated" : "complete"} edited overview`, async () => inMonitor(codex, async () => {
  await seed();
  await sql`UPDATE monitor_event_actions SET title='{"zh":"额度恢复预告"}'::jsonb,summary='{"zh":"本轮额度即将恢复"}'::jsonb WHERE monitor_id='codex' AND event_id='event'`;
  const row = (await loadActionInput()).events[0]!;
  const title = partialEvent ? { zh: "本轮活动的自定义概述" } : properName("本轮活动的自定义概述");
  const summary = partialEvent ? { zh: "保留已有的活动说明" } : properName("保留已有的活动说明");
  await updateMonitorEvent(row.id, { version: rowVersion(row), patch: { title, summary } }, "reviewer");
  const before = await loadActionInput(), action = before.actions[0]!;
  assert.deepEqual(await processPublicV2Pending(), { enriched: partialEvent ? 2 : 1 });
  const after = await loadActionInput(), event = (await publicV2Snapshot()).events[0]!;
  assert.equal(event.title.zh, "本轮活动的自定义概述"); assert.equal(event.summary!.zh, "保留已有的活动说明");
  assert.equal(editorialReady(after.events[0]!, after), true);
  assert.equal(after.actions[0]!.title.zh, action.title.zh); assert.equal(after.actions[0]!.summary!.zh, action.summary!.zh);
  assert.deepEqual(after.actions[0]!.sources, action.sources); assert.deepEqual(after.actions[0]!.time, action.time);
  assert.ok(inputs.every(input => !("status" in input)), "only missing translations may be purchased");
  assert.deepEqual(await processPublicV2Pending(), { enriched: 0 });
}));

test("action translation cannot make a genuinely outdated overview current again", async () => inMonitor(codex, async () => {
  await seed(); await processEventOverviews(); await complete();
  await sql`UPDATE monitor_event_actions SET title='{"zh":"额度已恢复"}'::jsonb WHERE monitor_id='codex' AND action='confirm'`;
  assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
  assert.deepEqual(await processPublicV2Pending(), { enriched: 1, overviews: 1 });
  assert.equal((await publicV2Snapshot()).events[0]!.title.en, "Whole activity: completed");
}));

test("an event edited while action translation is in flight keeps the newer overview", async () => inMonitor(codex, async () => {
  await seed();
  await sql`UPDATE monitor_event_actions SET title='{"zh":"额度恢复预告"}'::jsonb WHERE monitor_id='codex'`;
  let row = (await loadActionInput()).events[0]!;
  await updateMonitorEvent(row.id, { version: rowVersion(row), patch: { title: properName("Initial edited overview") } }, "reviewer");
  const entered = gate(), release = gate();
  beforeReply = async () => { entered.open(); await release.promise; };
  const processing = processPublicV2Pending();
  try {
    await entered.promise; row = (await loadActionInput()).events[0]!;
    await updateMonitorEvent(row.id, { version: rowVersion(row), patch: { title: properName("Newer edited overview") } }, "reviewer");
  } finally { release.open(); }
  assert.deepEqual(await processing, { enriched: 1 });
  assert.equal((await publicV2Snapshot()).events[0]!.title.en, "Newer edited overview");
  assert.ok(inputs.every(input => !("status" in input)));
}));

test("a real action change during translation rejects the old response and regenerates the overview", async () => inMonitor(codex, async () => {
  await seed();
  await sql`UPDATE monitor_event_actions SET title='{"zh":"额度恢复预告"}'::jsonb WHERE monitor_id='codex'`;
  const initial = await loadActionInput(), row = initial.events[0]!, action = initial.actions[0]!;
  await updateMonitorEvent(row.id, { version: rowVersion(row), patch: { title: properName("Overview before the plan changed") } }, "reviewer");
  const entered = gate(), release = gate();
  beforeReply = async () => { entered.open(); await release.promise; };
  const processing = processPublicV2Pending();
  try {
    await entered.promise;
    await sql.begin(async db => {
      await writePostActions(db, (await sourcePost("post", db))!, [{ id: action.id, eventId: row.id, action: "announce",
        title: properName("Changed plan"), summary: null, time: bt("2026-11-03") }], { editExisting: true });
      await enqueuePublicV2(db, [row.id]);
    });
  } finally { release.open(); }
  assert.deepEqual(await processing, { enriched: 0, overviews: 1 });
  const after = await loadActionInput();
  assert.deepEqual(after.actions[0]!.time, bt("2026-11-03")); assert.equal(after.actions[0]!.title.en, "Changed plan");
  assert.equal((await publicV2Snapshot()).events[0]!.title.en, "Whole activity: announced");
  assert.equal(inputs.find(input => "status" in input)!.actions[0].title.en, "Changed plan");
}));

for (const edit of ["none", "action", "scope"] as const) test(`a full bundle with ${edit} changes does not reapprove the unchanged outdated event overview`, async () => inMonitor(codex, async () => {
  await seed(); await processEventOverviews(); await complete();
  const bundle = await exportPublicV2([codex]), reviews = bundle.monitors[0]!.reviews;
  if (edit === "action") reviews.find(review => review.kind === "action")!.editorial.summary = properName("Corrected activity detail");
  if (edit === "scope") reviews.find(review => review.kind === "event")!.editorial.scope = { type: "paid_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: properName("Paid users") };
  const preview = await previewPublicV2(bundle, [codex]);
  assert.equal(preview.snapshots[0]!.events[0]!.status, "completed"); assert.equal(preview.snapshots[0]!.events[0]!.summary, null);
  assert.notEqual(preview.snapshots[0]!.events[0]!.title.en, "Whole activity: announced");
  await applyPublicV2(bundle, [codex], "Review saved fields", "reviewer");
  const input = await loadActionInput(); assert.equal(editorialReady(input.events[0]!, input), false);
  assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
  assert.equal((await processEventOverviews()).overviews, 1);
  assert.equal((await publicV2Snapshot()).events[0]!.title.en, "Whole activity: completed");
}));

test("an explicitly edited bundle overview binds to current facts until the next action change", async () => inMonitor(codex, async () => {
  await seed(); await complete();
  const bundle = await exportPublicV2([codex]), review = bundle.monitors[0]!.reviews.find(review => review.kind === "event")!;
  review.editorial.title = properName("An independent completed activity overview");
  review.editorial.summary = properName("The completed activity's scope and result");
  assert.equal((await previewPublicV2(bundle, [codex])).snapshots[0]!.events[0]!.title.en, review.editorial.title.en);
  await applyPublicV2(bundle, [codex], "Edit overview", "reviewer");
  assert.equal((await publicV2Snapshot()).events[0]!.title.en, review.editorial.title.en);
  assert.equal((await processEventOverviews()).overviews, 0);
  await sql.begin(async db => {
    await writePostActions(db, (await sourcePost("post", db))!, [{ eventId: "event", action: "progress", title: properName("Distribution update"), summary: null, time: bt("2026-11-02T03:00:00Z") }]);
    await enqueuePublicV2(db, ["event"]);
  });
  assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
  assert.equal((await processEventOverviews()).overviews, 1);
}));
