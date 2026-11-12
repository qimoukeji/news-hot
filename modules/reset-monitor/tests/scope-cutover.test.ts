import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { loadActionInput } from "../backend/action-store.ts";
import { editorialStatus, officialEditorialInput, saveEditorialState } from "../backend/event-editorial.ts";
import { projectPublicV2, properName } from "../backend/public-v2.ts";
import { assertScopeCutoverComplete, legacyScopeBaselineKey, sweepConfirmationResults } from "../backend/webhook-events.ts";
import { retryWebhookDelivery } from "../backend/webhooks.ts";
import { executeScopeCutover, inventoryScopeCutover, legacyWebhookFingerprint } from "../scripts/scope-cutover.ts";
import { threadRecognitionVersion } from "../backend/recognize.ts";
import { legacyEditorialVersion, legacyEventTime, loadLegacyTimeInput } from "../scripts/time-cutover.ts";

const at = "2026-11-10T05:00:00Z";
const event = "legacy-scope";
const source = "174500000000001";
const subscription = "20000000-0000-4000-8000-000000000001";
const notification = "20000000-0000-4000-8000-000000000002";
const delivery = "20000000-0000-4000-8000-000000000003";
const summary = properName("Only Pro $500 users received a weekly quota reset.");
const overview = (now = Date.parse(at) + 1) => sql.begin("read only", db => inventoryScopeCutover(db, [codex], now));
const apply = (review: unknown, now = Date.parse(at) + 1) => sql.begin(db => executeScopeCutover(db, [codex], review, now));

beforeEach(async () => {
  await sql`DELETE FROM monitor_webhook_deliveries`;
  await sql`DELETE FROM monitor_webhook_notifications`;
  await sql`DELETE FROM monitor_webhook_subscriptions`;
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`INSERT INTO monitor_event_records(monitor_id,id,type,title,scope,created_at)
    VALUES('codex',${event},'direct_reset',${sql.json(properName("Reset recorded"))},
      ${sql.json({ type: "paid_users", note: properName("Paid users"), productCodes: ["codex"], planCodes: ["pro-500"], quotaWindowCodes: ["weekly"] })},${at})`;
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status)
    VALUES('codex',${source},'thsottiaux',${at},${`https://x.com/thsottiaux/status/${source}`},${summary.en},'processed')`;
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,time,sources,created_at)
    VALUES('codex','legacy-confirm',${event},1,'confirm',${sql.json(properName("Quota reset"))},
      ${sql.json({ kind: "instant", at })},${sql.json([{ postId: source }])},${at})`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES
    ('codex',${legacyScopeBaselineKey},'{"initialized":true}'::jsonb),
    ('codex',${`webhook:event:${event}`},'{"revision":4,"fingerprint":"legacy","withdrawn":false,"notified":true}'::jsonb)`;
  await inMonitor(codex, () => sql.begin(async db => {
    const input = await loadActionInput(db);
    await saveEditorialState(db, input.events[0]!, input, "ready");
  }));
  await saveOldFingerprint();
});
after(async () => { await stopBoss(); await closeDb(); });

async function saveOldFingerprint() {
  const fingerprint = await inMonitor(codex, async () => {
    const input = await loadLegacyTimeInput(sql, codex.monitorId);
    return legacyWebhookFingerprint(input.events[0]!, input, Date.parse(at) + 1);
  });
  await sql`UPDATE monitor_state SET value=jsonb_set(value,'{fingerprint}',${sql.json(fingerprint)})
    WHERE monitor_id='codex' AND key=${`webhook:event:${event}`}`;
}

async function appendProgress() {
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,time,sources,created_at)
    VALUES('codex','next-progress',${event},2,'progress',${sql.json(properName("New progress"))},
      ${sql.json({ kind: "instant", at })},${sql.json([{ postId: source }])},${at})`;
}

async function queueOld(status: "pending" | "failed") {
  await sql`INSERT INTO monitor_webhook_subscriptions(id,name,url,platforms,enabled,enabled_at,secret)
    VALUES(${subscription},'fixture','https://example.test/webhook',ARRAY['codex'],true,${at},'synthetic')`;
  await sql`INSERT INTO monitor_webhook_notifications(id,monitor_id,event_id,revision,payload)
    VALUES(${notification},'codex',${event},4,'{"event":{"scope":{"productCodes":["codex"]}}}'::jsonb)`;
  await sql`INSERT INTO monitor_webhook_deliveries(id,subscription_id,notification_id,generation,status)
    VALUES(${delivery},${subscription},${notification},1,${status})`;
}

test("read-only inventory requires reviewed text, and cutover preserves the event and prior webhook revision", async () => {
  await queueOld("failed");
  await assert.rejects(assertScopeCutoverComplete(), /reviewed reset-monitor scope cutover/);
  const inventory = await overview();
  assert.equal(inventory.fieldsToRemove, 1);
  assert.deepEqual(inventory.events[0]?.legacy, { productCodes: ["codex"], planCodes: ["pro-500"], quotaWindowCodes: ["weekly"] });
  assert.deepEqual(inventory.events[0]?.actions[0]?.urls, [`https://x.com/thsottiaux/status/${source}`]);
  assert.equal(inventory.deliveries[0]?.status, "failed");
  await assert.rejects(apply({ fingerprint: inventory.fingerprint, events: [] }), /one reviewed entry/);
  const row = { monitorId: "codex", eventId: event, reviewed: true };
  await assert.rejects(apply({ fingerprint: inventory.fingerprint, events: [row] }), /no complete action summary/);
  await assert.rejects(apply({ fingerprint: inventory.fingerprint, events: [{ ...row, summary }] }), /no complete action summary/);
  const applied = await apply({ fingerprint: inventory.fingerprint, events: [{ ...row, summary,
    actions: [{ id: "legacy-confirm", summary }] }] });
  assert.deepEqual(applied, { events: 1, actions: 1 });
  await assertScopeCutoverComplete();
  const input = await inMonitor(codex, () => loadActionInput());
  assert.deepEqual(Object.keys(input.events[0]!.scope!).sort(), ["note", "type"]);
  assert.deepEqual(input.actions[0]!.summary, summary);
  assert.equal(editorialStatus(input.events[0]!, input), "ready");
  const published = projectPublicV2(input, codex, Date.parse(at) + 1).events[0]!;
  assert.equal(published.id, event);
  assert.equal(published.summary?.en, summary.en);
  assert.equal(published.updates[0]!.summary?.en, summary.en);
  assert.equal(published.updates[0]!.sources[0]!.postId, source);
  await appendProgress();
  const changed = await inMonitor(codex, () => loadActionInput());
  assert.ok(officialEditorialInput(changed.events[0]!, changed)?.actions.some(action => action.summary?.en === summary.en));
  await sql`DELETE FROM monitor_event_actions WHERE id='next-progress'`;
  await sweepConfirmationResults([codex], Date.parse(at) + 1);
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 1);
  await assert.rejects(retryWebhookDelivery(subscription, delivery, "operator review", "fixture"), /旧格式通知/);
  const [old] = await sql`SELECT status FROM monitor_webhook_deliveries WHERE id=${delivery}`;
  assert.equal(old!.status, "failed");
});

test("cutover rejects stale inventories and never disposes of pending work or deliveries", async () => {
  const initial = await overview();
  await queueOld("pending");
  await assert.rejects(apply({ fingerprint: initial.fingerprint, events: [] }), /fresh inventory/);
  const withDelivery = await overview();
  await assert.rejects(apply({ fingerprint: withDelivery.fingerprint, events: [] }), /outstanding recognition, deliveries/);
  await sql`UPDATE monitor_webhook_deliveries SET status='sent' WHERE id=${delivery}`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex','recognition:pending:fixture','{}'::jsonb)`;
  const withWork = await overview();
  assert.equal(withWork.pendingRecognition.length, 1);
  await assert.rejects(apply({ fingerprint: withWork.fingerprint, events: [] }), /outstanding recognition, deliveries/);
  await assert.rejects(assertScopeCutoverComplete(), /reviewed reset-monitor scope cutover/);
});

test("empty retired arrays need no invented summary and unknown never retains the historical all-users label", async () => {
  await sql`UPDATE monitor_event_records SET scope=${sql.json({ type: "unknown", note: properName("All users"),
    productCodes: [], planCodes: [], quotaWindowCodes: [] })} WHERE id=${event}`;
  await saveOldFingerprint();
  const inventory = await overview();
  assert.equal(inventory.fieldsToRemove, 1);
  assert.deepEqual(inventory.reviewTemplate.events, []);
  assert.equal(inventory.events[0]!.reviewRequired, false);
  assert.deepEqual(await apply({ fingerprint: inventory.fingerprint, events: [] }), { events: 1, actions: 0 });
  const input = await inMonitor(codex, () => loadActionInput());
  assert.equal(input.events[0]!.scope?.type, "unknown");
  assert.equal(input.events[0]!.scope?.note?.en, "Eligibility unspecified");
  assert.equal(input.events[0]!.summary, null);
  await sweepConfirmationResults([codex], Date.parse(at) + 1);
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
});

test("reviewed empty-code records can correct an audience or add a sourced summary", async () => {
  await sql`UPDATE monitor_event_records SET scope=${sql.json({ type: "all_users", note: properName("All users"),
    productCodes: [], planCodes: [], quotaWindowCodes: [] })}`;
  await saveOldFingerprint();
  const inventory = await overview();
  assert.equal(inventory.events[0]!.reviewRequired, false);
  assert.deepEqual(await apply({ fingerprint: inventory.fingerprint, events: [{ monitorId: "codex", eventId: event,
    reviewed: true, scope: { type: "unknown", note: null }, actions: [{ id: "legacy-confirm", summary }] }] }), { events: 1, actions: 1 });
  const input = await inMonitor(codex, () => loadActionInput());
  assert.deepEqual(input.events[0]!.scope, { type: "unknown", note: null });
  assert.deepEqual(input.actions[0]!.summary, summary);
});

test("an unpublished business change blocks rebasing rather than swallowing its notification", async () => {
  await appendProgress();
  const inventory = await overview();
  assert.deepEqual(inventory.unpublishedEvents, [{ monitorId: "codex", eventId: event }]);
  await assert.rejects(apply({ fingerprint: inventory.fingerprint, events: [] }), /unpublished changes/);
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
});

test("cutover applies a reviewed audience correction while retaining quota detail in the action summary and suppressing replay", async () => {
  await queueOld("failed");
  await sql`UPDATE monitor_event_records SET scope=scope || ${sql.json({ type: "all_users", note: properName("Pro $500 users · weekly quota") })}`;
  await saveOldFingerprint();
  const inventory = await overview();
  assert.equal(inventory.events[0]!.scope.note?.en, "Pro $500 users · weekly quota");
  const reviewed = { monitorId: "codex", eventId: event, reviewed: true, actions: [{ id: "legacy-confirm", summary }] };
  await assert.rejects(apply({ fingerprint: inventory.fingerprint, events: [{ ...reviewed,
    scope: { type: "selected_users", note: null } }] }), /complete audience label/);
  const scope = { type: "selected_users", note: properName("Eligible subscribers") };
  await apply({ fingerprint: inventory.fingerprint, events: [{ ...reviewed, scope }] });
  const input = await inMonitor(codex, () => loadActionInput());
  const published = projectPublicV2(input, codex, Date.parse(at) + 1).events[0]!;
  assert.deepEqual(published.scope, scope);
  assert.deepEqual(published.updates[0]!.summary, summary);
  await sweepConfirmationResults([codex], Date.parse(at) + 1);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 1);
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
});

test("ready historical content is rebased before the first real post-cutover update", async () => {
  await queueOld("failed");
  await sql`UPDATE monitor_state SET value=value || '{"historicalPending":true,"fingerprint":null}'::jsonb
    WHERE key=${`webhook:event:${event}`}`;
  const inventory = await overview();
  await apply({ fingerprint: inventory.fingerprint, events: [{ monitorId: "codex", eventId: event, reviewed: true,
    actions: [{ id: "legacy-confirm", summary }] }] });
  await appendProgress();
  await sweepConfirmationResults([codex], Date.parse(at) + 1);
  const notices = await sql`SELECT revision,payload FROM monitor_webhook_notifications WHERE revision=5`;
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.payload.action, "updated");
});

test("startup rejects standalone old recognition work and accepts resumable current work", async () => {
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_state`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex','recognition:pending:old','{"promptVersion":"retired"}'::jsonb)`;
  await assert.rejects(assertScopeCutoverComplete(), /reviewed reset-monitor scope cutover/);
  await sql`UPDATE monitor_state SET value=${sql.json({ promptVersion: threadRecognitionVersion })}`;
  await assertScopeCutoverComplete();
});

for (const existingSummary of [false, true]) test(`source-free confirmation cutover preserves ${existingSummary ? "existing" : "reviewed"} eligibility without inventing official evidence`, async () => {
  await queueOld("failed");
  await sql`UPDATE monitor_event_actions SET sources='[]'::jsonb,summary=${existingSummary ? sql.json(summary) : null}`;
  await saveOldFingerprint();
  const inventory = await overview();
  assert.deepEqual(inventory.events[0]!.actions[0]!.urls, []);
  await apply({ fingerprint: inventory.fingerprint, events: [{ monitorId: "codex", eventId: event, reviewed: true,
    ...(existingSummary ? {} : { actions: [{ id: "legacy-confirm", summary }] }) }] });
  await assertScopeCutoverComplete();
  const input = await inMonitor(codex, () => loadActionInput());
  assert.equal(input.events[0]!.id, event);
  assert.deepEqual(Object.keys(input.events[0]!.scope!).sort(), ["note", "type"]);
  const action = input.actions[0]!;
  assert.equal(action.id, "legacy-confirm");
  assert.deepEqual(action.summary, summary);
  assert.deepEqual(action.sources, []);
  assert.deepEqual(action.time, { kind: "instant", at });
  assert.equal(officialEditorialInput(input.events[0]!, input), null);
  const published = projectPublicV2(input, codex, Date.parse(at) + 1).events[0]!;
  assert.equal(published.status, "completed");
  assert.deepEqual(published.updates[0]!.sources, []);
  await sweepConfirmationResults([codex], Date.parse(at) + 1);
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 1);
});

test("a source-free confirmation still needs its own complete summary rather than only an event summary", async () => {
  await sql`UPDATE monitor_event_actions SET sources='[]'::jsonb`;
  await saveOldFingerprint();
  const inventory = await overview();
  await assert.rejects(apply({ fingerprint: inventory.fingerprint,
    events: [{ monitorId: "codex", eventId: event, reviewed: true, summary }] }), /no complete action summary/);
  const [row] = await sql`SELECT scope FROM monitor_event_records WHERE id=${event}`;
  assert.deepEqual(row!.scope.planCodes, ["pro-500"]);
});

test("mixed events cannot use an unsourced summary to bypass preserving official eligibility", async () => {
  const personalSummary = properName("Only the manually checked account was restored.");
  await sql`UPDATE monitor_event_actions SET sources='[]'::jsonb,summary=${sql.json(personalSummary)},sequence=2`;
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,time,sources,created_at)
    VALUES('codex','official-announce',${event},1,'announce',${sql.json(properName("Official announcement"))},
      ${sql.json({ kind: "instant", at })},${sql.json([{ postId: source }])},${at})`;
  await saveOldFingerprint();
  const inventory = await overview();
  const reviewed = { monitorId: "codex", eventId: event, reviewed: true, summary: personalSummary,
    actions: [{ id: "legacy-confirm", summary: personalSummary }] };
  await assert.rejects(apply({ fingerprint: inventory.fingerprint, events: [reviewed] }), /no complete action summary/);
  await apply({ fingerprint: inventory.fingerprint, events: [{ ...reviewed,
    actions: [{ id: "official-announce", summary }] }] });
  const input = await inMonitor(codex, () => loadActionInput());
  const official = officialEditorialInput(input.events[0]!, input)!;
  assert.equal(official.actions.length, 1);
  assert.deepEqual(official.actions[0]!.summary, summary);
  assert.ok(official.actions.every(action => action.summary?.en !== personalSummary.en));
  assert.deepEqual(input.actions.find(action => action.id === "legacy-confirm")!.sources, []);
});

const reviewScope = () => [{ monitorId: "codex", eventId: event, reviewed: true,
  actions: [{ id: "legacy-confirm", summary }] }];
const reviewTimes = (inventory: Awaited<ReturnType<typeof overview>>) => inventory.times.map(({ monitorId, actionId }) => ({ monitorId, actionId, reviewed: true }));

test("reviewed drafts preserve retired eligibility in a complete event summary without creating or publishing actions", async () => {
  await sql`DELETE FROM monitor_event_actions`;
  await sql`UPDATE monitor_state SET value=value || '{"fingerprint":null,"withdrawn":true,"notified":false}'::jsonb
    WHERE key=${`webhook:event:${event}`}`;
  const inventory = await overview();
  assert.equal(inventory.events[0]!.reviewRequired, true);
  assert.deepEqual(inventory.events[0]!.actions, []);
  assert.deepEqual(inventory.inferredConfirmations, []);
  const reviewed = { monitorId: "codex", eventId: event, reviewed: true };
  await assert.rejects(apply({ fingerprint: inventory.fingerprint, events: [reviewed] }), /no complete event summary/);
  await sql`UPDATE monitor_event_records SET summary=${sql.json({ en: summary.en })} WHERE id=${event}`;
  const incomplete = await overview();
  await assert.rejects(apply({ fingerprint: incomplete.fingerprint, events: [reviewed] }), /no complete event summary/);
  assert.deepEqual(await apply({ fingerprint: incomplete.fingerprint, events: [{ ...reviewed, summary }] }), { events: 1, actions: 0 });
  const saved = await inMonitor(codex, () => loadActionInput());
  assert.deepEqual(saved.events[0]!.summary, summary);
  assert.deepEqual(Object.keys(saved.events[0]!.scope!).sort(), ["note", "type"]);
  assert.equal(saved.actions.length, 0);
  assert.deepEqual(projectPublicV2(saved, codex, Date.parse(at)).events, []);
  await sweepConfirmationResults([codex], Date.parse(at) + 1);
  assert.equal((await sql`SELECT id FROM monitor_event_actions`).length, 0);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
});

test("reviewed drafts may retain an already complete saved event summary", async () => {
  await sql`DELETE FROM monitor_event_actions`;
  await sql`UPDATE monitor_event_records SET summary=${sql.json(summary)} WHERE id=${event}`;
  await sql`UPDATE monitor_state SET value=value || '{"fingerprint":null,"withdrawn":true,"notified":false}'::jsonb
    WHERE key=${`webhook:event:${event}`}`;
  const inventory = await overview();
  assert.deepEqual(await apply({ fingerprint: inventory.fingerprint,
    events: [{ monitorId: "codex", eventId: event, reviewed: true }] }), { events: 1, actions: 0 });
  const saved = await inMonitor(codex, () => loadActionInput());
  assert.deepEqual(saved.events[0]!.summary, summary);
  assert.equal(saved.actions.length, 0);
  assert.deepEqual(projectPublicV2(saved, codex).events, []);
});

test("joint inventory lists every legacy time and requires exact per-action review before one atomic scope/time switch", async () => {
  await sql`UPDATE monitor_event_actions SET sequence=2,time=${sql.json({ kind: "date", date: "2026-11-11", timeZone: "America/Los_Angeles" })}`;
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,time,sources,created_at)
    VALUES('codex','unknown-announce',${event},1,'announce',${sql.json(properName("Future reset"))},NULL,${sql.json([{ postId: source }])},${at})`;
  await saveOldFingerprint();
  const inventory = await overview();
  assert.deepEqual(inventory.timeProblems, []);
  assert.equal(inventory.times.length, 2);
  assert.deepEqual(inventory.times.find(row => row.actionId === "legacy-confirm")!.after, { kind: "instant", at });
  assert.deepEqual(inventory.times.find(row => row.actionId === "unknown-announce")!.after, { kind: "instant", at: "2026-11-10T18:00:00Z" });
  assert.equal(inventory.times[0]!.sources[0]!.postId, source);
  const review = { fingerprint: inventory.fingerprint, events: reviewScope() };
  await assert.rejects(apply(review), /Each time conversion requires exactly one reviewed entry/);
  const times = reviewTimes(inventory);
  await assert.rejects(apply({ ...review, times: [...times, times[0]] }), /exactly one reviewed entry/);
  await assert.rejects(apply({ ...review, times: [times[0]] }), /exactly one reviewed entry/);
  assert.deepEqual(await apply({ ...review, times }), { events: 1, actions: 1, times: 2 });
  const after = await overview();
  assert.equal(after.times.length, 0);
  assert.equal(after.fieldsToRemove, 0);
  assert.deepEqual(after.unpublishedEvents, []);
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
  await sweepConfirmationResults([codex], Date.parse(at) + 1);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
});

test("a later scope review failure rolls back already-written time changes", async () => {
  await sql`UPDATE monitor_event_actions SET time=${sql.json({ kind: "instant", at: "2026-11-09T01:00:00Z" })}`;
  await saveOldFingerprint();
  const inventory = await overview();
  const before = await sql`SELECT time,updated_at FROM monitor_event_actions`;
  await assert.rejects(apply({ fingerprint: inventory.fingerprint, times: reviewTimes(inventory),
    events: [{ monitorId: "codex", eventId: event, reviewed: true }] }), /no complete action summary/);
  assert.deepEqual(await sql`SELECT time,updated_at FROM monitor_event_actions`, before);
  const [scope] = await sql`SELECT scope FROM monitor_event_records`;
  assert.deepEqual(scope!.scope.planCodes, ["pro-500"]);
});

test("failure in a second monitor rolls back the first monitor's scope and time writes", async () => {
  await sql`UPDATE monitor_event_actions SET time=${sql.json({ kind: "instant", at: "2026-11-09T01:00:00Z" })}`;
  await saveOldFingerprint();
  await sql`INSERT INTO monitor_event_records(monitor_id,id,type,title,scope,created_at)
    SELECT 'claude',id,type,title,scope,created_at FROM monitor_event_records WHERE monitor_id='codex'`;
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status)
    SELECT 'claude',id,author,published_at,url,text,processing_status FROM monitor_source_posts WHERE monitor_id='codex'`;
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,time,sources,created_at)
    SELECT 'claude',id,event_id,sequence,action,title,time,sources,created_at FROM monitor_event_actions WHERE monitor_id='codex'`;
  const definitions = [codex, claude];
  const inventory = await sql.begin("read only", db => inventoryScopeCutover(db, definitions));
  const before = await sql`SELECT monitor_id,id,time,updated_at FROM monitor_event_actions ORDER BY monitor_id,id`;
  await assert.rejects(sql.begin(db => executeScopeCutover(db, definitions, { fingerprint: inventory.fingerprint,
    times: reviewTimes(inventory), events: [...reviewScope(), { monitorId: "claude", eventId: event, reviewed: true }] })), /no complete action summary/);
  assert.deepEqual(await sql`SELECT monitor_id,id,time,updated_at FROM monitor_event_actions ORDER BY monitor_id,id`, before);
  const scopes = await sql`SELECT scope FROM monitor_event_records`;
  assert.ok(scopes.every(row => row.scope.planCodes[0] === "pro-500"));
});

test("matching failed overview and translation identities stay failed after time conversion, while stale identities stay stale", async () => {
  await sql`UPDATE monitor_event_actions SET time=${sql.json({ kind: "instant", at: "2026-11-09T01:00:00Z" })},summary=${sql.json(summary)}`;
  await saveOldFingerprint();
  const before = await loadLegacyTimeInput(sql, "codex");
  const action = before.actions[0]!;
  await sql`UPDATE monitor_state SET value=${sql.json({ status: "failed", version: legacyEditorialVersion(before.events[0]!, before), receiptId: 17 })}
    WHERE key=${`public_v2:overview:${event}`}`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES
    ('codex','public_v2:translation:action:legacy-confirm',${sql.json({ status: "failed", version: sha256(stableJson(action)), receiptId: 18 })}),
    ('codex',${`public_v2:translation:event:${event}`},'{"status":"failed","version":"stale","receiptId":19}'::jsonb)`;
  const inventory = await overview();
  await apply({ fingerprint: inventory.fingerprint, times: reviewTimes(inventory), events: [{ monitorId: "codex", eventId: event, reviewed: true }] });
  const states = await sql`SELECT key,value FROM monitor_state WHERE starts_with(key,'public_v2:') ORDER BY key`;
  assert.ok(states.every(row => row.value.status === "failed"));
  assert.equal(states.find(row => row.key === `public_v2:overview:${event}`)!.value.receiptId, 17);
  const saved = await inMonitor(codex, () => loadActionInput());
  assert.equal(states.find(row => row.key === 'public_v2:translation:action:legacy-confirm')!.value.version, sha256(stableJson(saved.actions[0])));
  assert.equal(states.find(row => row.key === `public_v2:translation:event:${event}`)!.value.version, "stale");
});

test("time conversion previews and cancels failed old deliveries without deleting the notification or changing its revision", async () => {
  await queueOld("failed");
  await sql`UPDATE monitor_event_actions SET time=${sql.json({ kind: "instant", at: "2026-11-09T01:00:00Z" })}`;
  await saveOldFingerprint();
  const inventory = await overview();
  assert.deepEqual(inventory.timeDeliveriesToCancel, [delivery]);
  const notifications = await sql`SELECT * FROM monitor_webhook_notifications`;
  await apply({ fingerprint: inventory.fingerprint, times: reviewTimes(inventory), events: reviewScope() });
  assert.deepEqual(await sql`SELECT * FROM monitor_webhook_notifications`, notifications);
  const [sent] = await sql`SELECT status FROM monitor_webhook_deliveries WHERE id=${delivery}`;
  assert.equal(sent!.status, "cancelled");
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
});

test("invalid historical time retains the same action and fallback, records source review, and suppresses historical review notifications", async () => {
  await sql`UPDATE monitor_event_actions SET action='announce',time=${sql.json({ kind: "range", from: "bad", through: "2026-11-10T18:00:00Z" })}`;
  await sql`UPDATE monitor_state SET value=value || '{"historicalPending":true,"fingerprint":null}'::jsonb WHERE key=${`webhook:event:${event}`}`;
  await sql`INSERT INTO settings(key,value,updated_by) VALUES('reset.review-notifications','{"attempts":3}'::jsonb,'fixture')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex',${`review-notification:episode:${source}:old`},'{"status":"pending","postId":"old"}'::jsonb)`;
  const inventory = await overview();
  assert.deepEqual(inventory.times[0]!.reviewPostIds, [source]);
  await apply({ fingerprint: inventory.fingerprint, times: reviewTimes(inventory), events: reviewScope() });
  const [post] = await sql`SELECT processing_status,review_reason FROM monitor_source_posts WHERE id=${source}`;
  assert.equal(post!.processing_status, "needs_attention");
  assert.match(post!.review_reason, /publication-day 18:00 UTC fallback requires review/);
  const [action] = await sql`SELECT id,time FROM monitor_event_actions`;
  assert.equal(action!.id, "legacy-confirm");
  assert.deepEqual(action!.time, { kind: "instant", at: "2026-11-10T18:00:00Z" });
  const episodes = await sql`SELECT value FROM monitor_state WHERE starts_with(key,'review-notification:episode:')`;
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]!.value.status, "cancelled");
  const [settings] = await sql`SELECT value FROM settings WHERE key='reset.review-notifications'`;
  assert.equal(settings!.value.attempts, 3);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
});

test("time-only cutover rebases existing history without a retired scope marker and keeps sent notifications intact", async () => {
  await sql`UPDATE monitor_event_records SET scope=${sql.json({ type: "paid_users", note: properName("Paid users") })}`;
  await sql`DELETE FROM monitor_state WHERE key=${legacyScopeBaselineKey}`;
  // Start with a valid current-format baseline, then replace its time by an old official confirmation time.
  const old = { kind: "instant", at: "2026-11-09T01:00:00Z" };
  await sql`UPDATE monitor_event_actions SET time=${sql.json(old)}`;
  const current = await inMonitor(codex, () => loadActionInput());
  const raw = projectPublicV2(current, codex, Date.parse(at)).events[0]!;
  // Notification comparison uses the raw title/summary, not editorial publication filtering.
  const { projectRawV2 } = await import("../backend/public-v2.ts");
  const savedRaw = projectRawV2(current, codex, Date.parse(at)).events[0]!;
  await sql`UPDATE monitor_state SET value=value || ${sql.json({ fingerprint: sha256(stableJson({ ...savedRaw, time: old, updates: savedRaw.updates.map(update => ({ ...update, time: old })) })) })}
    WHERE key=${`webhook:event:${event}`}`;
  await queueOld("failed");
  await sql`UPDATE monitor_webhook_deliveries SET status='sent' WHERE id=${delivery}`;
  const sentBefore = await sql`SELECT * FROM monitor_webhook_notifications`;
  const inventory = await overview();
  assert.deepEqual(inventory.unpublishedEvents, []);
  assert.equal(inventory.times.length, 1);
  await apply({ fingerprint: inventory.fingerprint, times: reviewTimes(inventory), events: [] });
  assert.deepEqual(await sql`SELECT * FROM monitor_webhook_notifications`, sentBefore);
  await sweepConfirmationResults([codex], Date.parse(at) + 1);
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
  assert.equal(raw.id, event);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 1);
});

test("due historical announcements are confirmed inside the cutover; the first sweep emits no historical update", async () => {
  await queueOld("failed");
  await sql`UPDATE monitor_webhook_deliveries SET status='sent' WHERE id=${delivery}`;
  await sql`UPDATE monitor_event_actions SET action='announce',time=NULL,summary=${sql.json(summary)} WHERE id='legacy-confirm'`;
  await saveOldFingerprint();
  const beforeDue = await overview();
  assert.deepEqual(beforeDue.inferredConfirmations, []);
  const now = Date.parse("2026-11-10T18:00:00Z") + 1;
  await assert.rejects(apply({ fingerprint: beforeDue.fingerprint, events: reviewScope(), times: reviewTimes(beforeDue) }, now), /fresh inventory/);
  const due = await overview(now);
  assert.equal(due.inferredConfirmations.length, 1);
  assert.deepEqual(due.inferredConfirmations[0]!.time, { kind: "instant", at: "2026-11-10T18:00:00Z" });
  assert.deepEqual(await apply({ fingerprint: due.fingerprint, events: reviewScope(), times: reviewTimes(due) }, now),
    { events: 1, actions: 1, times: 1, inferred: 1 });
  const saved = await inMonitor(codex, () => loadActionInput());
  assert.equal(saved.actions.length, 2);
  const inferred = saved.actions.find(action => action.id === due.inferredConfirmations[0]!.actionId)!;
  assert.deepEqual(inferred.time, due.inferredConfirmations[0]!.time);
  assert.deepEqual(inferred.sources, []);
  await sweepConfirmationResults([codex], now + 1);
  assert.equal((await sql`SELECT id FROM monitor_event_actions`).length, 2);
  assert.deepEqual([...await sql`SELECT revision FROM monitor_webhook_notifications`], [{ revision: 4 }]);
});

test("scope-only precise announcements becoming due while writers stop are silently confirmed before rebasing history", async () => {
  await queueOld("failed");
  await sql`UPDATE monitor_webhook_deliveries SET status='sent' WHERE id=${delivery}`;
  await sql`UPDATE monitor_event_actions SET action='announce',summary=${sql.json(summary)} WHERE id='legacy-confirm'`;
  await saveOldFingerprint();
  const beforeStop = Date.parse(at) - 1, stopped = Date.parse(at) + 60_000;
  const beforeDue = await overview(beforeStop);
  assert.deepEqual(beforeDue.times, []);
  assert.deepEqual(beforeDue.inferredConfirmations, []);
  await assert.rejects(apply({ fingerprint: beforeDue.fingerprint, events: reviewScope() }, stopped), /fresh inventory/);
  const inventory = await overview(stopped);
  assert.deepEqual(inventory.times, []);
  assert.equal(inventory.inferredConfirmations.length, 1);
  assert.deepEqual(inventory.inferredConfirmations[0]!.time, { kind: "instant", at });
  const history = await sql`SELECT * FROM monitor_webhook_notifications`;
  const deliveries = await sql`SELECT * FROM monitor_webhook_deliveries`;
  assert.deepEqual(await apply({ fingerprint: inventory.fingerprint, events: reviewScope() }, stopped),
    { events: 1, actions: 1, inferred: 1 });
  const saved = await inMonitor(codex, () => loadActionInput());
  const confirmation = saved.actions.find(action => action.id === inventory.inferredConfirmations[0]!.actionId)!;
  assert.deepEqual(confirmation.time, { kind: "instant", at });
  assert.deepEqual(confirmation.sources, []);
  assert.equal(new Date(confirmation.created_at).toISOString(), new Date(stopped).toISOString());
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
  const { readyEvent } = await import("../backend/webhook-events.ts");
  const ready = await inMonitor(codex, async () => readyEvent(saved.events[0]!, saved, stopped));
  assert.equal(baseline!.value.fingerprint, sha256(stableJson(ready)));
  for (const now of [stopped + 1, stopped + 60_000]) await sweepConfirmationResults([codex], now);
  assert.equal((await sql`SELECT id FROM monitor_event_actions`).length, 2);
  assert.deepEqual(await sql`SELECT * FROM monitor_webhook_notifications`, history);
  assert.deepEqual(await sql`SELECT * FROM monitor_webhook_deliveries`, deliveries);
  const [swept] = await sql`SELECT value FROM monitor_state WHERE key=${`webhook:event:${event}`}`;
  assert.equal(swept!.value.revision, 4);
});

test("time-only due announcements remain silent without retired scope fields", async () => {
  await sql`UPDATE monitor_event_records SET scope=${sql.json({ type: "paid_users", note: properName("Paid users") })}`;
  await sql`DELETE FROM monitor_state WHERE key=${legacyScopeBaselineKey}`;
  await sql`UPDATE monitor_event_actions SET action='announce',time=NULL,summary=${sql.json(summary)}`;
  await saveOldFingerprint();
  const now = Date.parse("2026-11-10T18:00:00Z") + 1;
  const inventory = await overview(now);
  assert.equal(inventory.fieldsToRemove, 0);
  assert.equal(inventory.times.length, 1);
  assert.equal(inventory.inferredConfirmations.length, 1);
  assert.deepEqual(await apply({ fingerprint: inventory.fingerprint, times: reviewTimes(inventory), events: [] }, now),
    { events: 0, actions: 0, times: 1, inferred: 1 });
  await sweepConfirmationResults([codex], now + 1);
  assert.equal((await sql`SELECT id FROM monitor_event_actions`).length, 2);
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
});

test("cutover preserves manual confirmation identity and its valid legacy baseline despite an old invalidation marker", async () => {
  await sql`UPDATE monitor_event_actions SET sources='[]'::jsonb,summary=${sql.json(summary)}`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES
    ('codex','confirmation:manual:legacy-confirm','true'::jsonb),
    ('codex','confirmation:invalidated:legacy-confirm','true'::jsonb)`;
  await saveOldFingerprint();
  const before = await loadLegacyTimeInput(sql, codex.monitorId);
  assert.deepEqual(before.manualConfirmationIds, new Set(["legacy-confirm"]));
  assert.deepEqual(before.invalidatedInferenceIds, new Set(["legacy-confirm"]));
  assert.equal(legacyEventTime(event, before)?.status, "completed");
  const inventory = await overview();
  assert.deepEqual(inventory.unpublishedEvents, []);
  assert.deepEqual(inventory.inferredConfirmations, []);
  assert.deepEqual(await apply({ fingerprint: inventory.fingerprint,
    events: [{ monitorId: "codex", eventId: event, reviewed: true }] }), { events: 1, actions: 0 });
  const saved = await inMonitor(codex, () => loadActionInput());
  assert.deepEqual(saved.manualConfirmationIds, before.manualConfirmationIds);
  assert.deepEqual(saved.invalidatedInferenceIds, before.invalidatedInferenceIds);
  assert.deepEqual(saved.actions[0]!.time, before.actions[0]!.time);
  assert.equal(projectPublicV2(saved, codex, Date.parse(at) + 1).events[0]!.status, "completed");
  await sweepConfirmationResults([codex], Date.parse(at) + 1);
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE key=${`webhook:event:${event}`}`;
  assert.equal(baseline!.value.revision, 4);
  assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 0);
});

test("fingerprints reject post-inventory changes to saved time, arbitrary state and sent notification payloads", async () => {
  await queueOld("failed");
  await sql`UPDATE monitor_webhook_deliveries SET status='sent' WHERE id=${delivery}`;
  for (const mutate of [
    () => sql`UPDATE monitor_event_actions SET time=${sql.json({ kind: "instant", at: "2026-11-09T01:00:00Z" })}`,
    () => sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex','unrelated:state','{"edited":true}'::jsonb)`,
    () => sql`UPDATE monitor_webhook_notifications SET payload=payload || '{"changed":true}'::jsonb`,
  ]) {
    const inventory = await overview();
    await mutate();
    await assert.rejects(apply({ fingerprint: inventory.fingerprint, events: reviewScope(), times: reviewTimes(inventory) }), /fresh inventory/);
  }
});

test("legacy fingerprints match fixed old raw event fixtures independently of the inventory helper", async () => {
  const all = { en: "All users", zh: "所有用户", "zh-Hant": "所有使用者", ja: "すべてのユーザー",
    ko: "모든 사용자", ru: "Все пользователи", es: "Todos los usuarios" };
  const arrays = { productCodes: ["old-product"], planCodes: ["old-plan"], quotaWindowCodes: ["old-cycle"] };
  const custom = properName("Restricted legacy accounts");
  const fixtures = [
    { saved: { ...arrays, type: "selected_users", note: custom }, published: { ...arrays, type: "selected_users", note: custom } },
    { saved: { ...arrays, type: "unknown", note: { zh: "所有用户" } }, published: { ...arrays, type: "unknown", note: all } },
    { saved: { ...arrays, type: "unknown", note: null }, published: { ...arrays, type: "unknown", note: all } },
    { saved: null, published: { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: all } },
  ];
  const publishedAt = "2026-11-10T05:00:00.000Z";
  const input = await inMonitor(codex, () => loadActionInput());
  for (const fixture of fixtures) {
    const row = { ...input.events[0]!, scope: fixture.saved as typeof input.events[0]["scope"] };
    const expected = { id: event, type: "direct_reset", status: "completed", publishedAt,
      title: properName("Reset recorded"), summary: null, time: { kind: "instant", at }, scope: fixture.published,
      updates: [{ id: "legacy-confirm", action: "confirm", invalidatesEvent: false, publishedAt,
        title: properName("Quota reset"), summary: null, time: { kind: "instant", at },
        sources: [{ postId: source, sourceId: "x-account:thsottiaux", url: `https://x.com/thsottiaux/status/${source}` }] }] };
    const actual = await inMonitor(codex, () => legacyWebhookFingerprint(row, { ...input, events: [row] }, Date.parse(at) + 1));
    assert.equal(actual, sha256(stableJson(expected)), `legacy scope ${JSON.stringify(fixture.saved)}`);
  }
});

test("legacy null and date fingerprints match fixed pre-cutover raw times without using the current action contract", async () => {
  const input = await loadLegacyTimeInput(sql, "codex");
  const row = input.events[0]!;
  const publishedAt = "2026-11-10T05:00:00.000Z";
  const date = { kind: "date", date: "2026-11-11", timeZone: "Asia/Shanghai" } as const;
  for (const kind of ["announce", "confirm"] as const) for (const time of [null, date]) {
    const legacy = { ...input, actions: [{ ...input.actions[0]!, action: kind, time }] };
    const oldTime = time ?? (kind === "confirm" ? { kind: "instant", at: publishedAt } : null);
    const expected = { id: event, type: "direct_reset", status: kind === "confirm" ? "completed" : "announced", publishedAt,
      title: properName("Reset recorded"), summary: null, time: oldTime, scope: row.scope,
      updates: [{ id: "legacy-confirm", action: kind, invalidatesEvent: false, publishedAt,
        title: properName("Quota reset"), summary: null, time: oldTime,
        sources: [{ postId: source, sourceId: "x-account:thsottiaux", url: `https://x.com/thsottiaux/status/${source}` }] }] };
    assert.equal(await inMonitor(codex, () => legacyWebhookFingerprint(row, legacy, Date.parse(at))), sha256(stableJson(expected)));
  }
});
