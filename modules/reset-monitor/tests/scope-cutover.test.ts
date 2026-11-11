import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { loadActionInput } from "../backend/action-store.ts";
import { editorialStatus, officialEditorialInput, saveEditorialState } from "../backend/event-editorial.ts";
import { projectPublicV2, properName } from "../backend/public-v2.ts";
import { assertScopeCutoverComplete, legacyScopeBaselineKey, sweepConfirmationResults } from "../backend/webhook-events.ts";
import { retryWebhookDelivery } from "../backend/webhooks.ts";
import { executeScopeCutover, inventoryScopeCutover, legacyWebhookFingerprint } from "../scripts/scope-cutover.ts";
import { threadRecognitionVersion } from "../backend/recognize.ts";

const at = "2026-11-10T05:00:00Z";
const event = "legacy-scope";
const source = "174500000000001";
const subscription = "20000000-0000-4000-8000-000000000001";
const notification = "20000000-0000-4000-8000-000000000002";
const delivery = "20000000-0000-4000-8000-000000000003";
const summary = properName("Only Pro $500 users received a weekly quota reset.");
const overview = () => sql.begin("read only", db => inventoryScopeCutover(db, [codex]));
const apply = (review: unknown) => sql.begin(db => executeScopeCutover(db, [codex], review, Date.parse(at) + 1));

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
    const input = await loadActionInput();
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
  assert.deepEqual(inventory.events, []);
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

test("an unpublished business change blocks rebasing rather than swallowing its notification", async () => {
  await appendProgress();
  const inventory = await overview();
  assert.deepEqual(inventory.unpublishedEvents, [{ monitorId: "codex", eventId: event }]);
  await assert.rejects(apply({ fingerprint: inventory.fingerprint, events: [] }), /unpublished changes/);
  const [baseline] = await sql`SELECT value FROM monitor_state WHERE key=${`webhook:event:${event}`}`;
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
