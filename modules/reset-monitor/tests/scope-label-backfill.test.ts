import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { loadActionInput } from "../backend/action-store.ts";
import { inMonitor } from "../backend/context.ts";
import { properName } from "../backend/public-v2.ts";
import { defaultScopeLabel, fixedScopeNote } from "../backend/scope-labels.ts";
import { captureWebhookEvent, initializeWebhookBaselines, loadWebhookBaselines, readyEvent, replaceWebhookFingerprint } from "../backend/webhook-events.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { applyScopeLabels, inventoryScopeLabels } from "../scripts/scope-label-backfill.ts";
import type { EditorialScope } from "../actions.ts";

const at = "2026-10-23T12:00:00Z";
const now = Date.parse(at) + 1;
const eventId = "scope-event";
const sourceId = "123456";
const title = properName("Quota reset");
const oldNote = { zh: "仅限受影响的 Pro 用户" };
const summary = { ...properName("Only affected Pro users were eligible."), zh: oldNote.zh };
const inventory = () => sql.begin("read only", db => inventoryScopeLabels(db, [codex], now));
const apply = (review: unknown) => sql.begin(db => applyScopeLabels(db, review, [codex], now));
const capture = () => inMonitor(codex, () => sql.begin(db => captureWebhookEvent(db, eventId, undefined, now)));
const baseline = () => inMonitor(codex, async () => (await loadWebhookBaselines(sql))?.get(eventId));
const notifications = async () => [...await sql<{ action: string; revision: number }[]>`SELECT payload->>'action' AS action,revision
  FROM monitor_webhook_notifications ORDER BY revision`];

beforeEach(async () => {
  await sql`DELETE FROM monitor_webhook_deliveries`;
  await sql`DELETE FROM monitor_webhook_notifications`;
  await sql`DELETE FROM monitor_webhook_subscriptions`;
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`;
});
after(async () => { await stopBoss(); await closeDb(); });

async function addEvent(scope: EditorialScope | null = null) {
  await sql`INSERT INTO monitor_event_records(monitor_id,id,type,title,scope,created_at)
    VALUES('codex',${eventId},'direct_reset',${sql.json(title)},${scope ? sql.json(scope) : null},${at})`;
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status)
    VALUES('codex',${sourceId},'thsottiaux',${at},'https://x.com/thsottiaux/status/123456',${summary.en},'processed')`;
}

async function addAction(action: "confirm" | "progress", text: { zh: string } = title) {
  const sequence = action === "confirm" ? 1 : 2;
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,time,sources,created_at)
    VALUES('codex',${action},${eventId},${sequence},${action},${sql.json(text)},${sql.json({ kind: "instant", at })},${sql.json([{ postId: sourceId }])},${at})`;
}

async function enableSubscription() {
  await sql`INSERT INTO monitor_webhook_subscriptions(id,name,url,platforms,enabled,enabled_at,secret)
    VALUES('20000000-0000-4000-8000-000000000001','scope fixture','https://example.test/webhook',ARRAY['codex'],true,${at},'fixture-secret')`;
}

test("historical custom unknown labels require review and preserve eligibility in the sourced action summary", async () => {
  await addEvent({ type: "unknown", note: oldNote });
  await addAction("confirm");
  await initializeWebhookBaselines([codex], now);
  const before = await baseline();
  assert.ok(before?.historicalPending);
  const snapshot = await inventory();
  assert.deepEqual(snapshot.selected.map(row => row.scope?.note), [oldNote]);
  assert.equal(snapshot.selected[0]!.actions[0]!.id, "confirm");
  assert.equal(snapshot.selected[0]!.sources[0]!.postId, sourceId);
  await assert.rejects(apply({ fingerprint: snapshot.fingerprint, selected: [] }), /需要一项范围核对/);
  const selected = { monitorId: "codex", id: eventId, audience: "single", note: summary };
  await assert.rejects(apply({ fingerprint: snapshot.fingerprint, selected: [selected] }), /对应摘要中保留已核对资格/);
  assert.deepEqual(await apply({ fingerprint: snapshot.fingerprint, selected: [{ ...selected, actions: [{ id: "confirm", summary }] }] }),
    { changed: 1, reviewed: 1 });
  const saved = await inMonitor(codex, () => loadActionInput());
  assert.equal(saved.events[0]!.scope?.type, "selected_users");
  assert.deepEqual(saved.actions[0]!.summary, summary);
  assert.deepEqual(await baseline(), before);
  assert.deepEqual(await notifications(), []);
});

test("a draft retains its first created notification when its scope is backfilled", async () => {
  await addEvent();
  await initializeWebhookBaselines([codex], now);
  await enableSubscription();
  const before = await baseline();
  assert.ok(before?.withdrawn);
  const { fingerprint } = await inventory();
  await apply({ fingerprint, selected: [] });
  assert.deepEqual(await baseline(), before);
  await addAction("confirm");
  await capture();
  await capture();
  assert.deepEqual(await notifications(), [{ action: "created", revision: 1 }]);
});

test("backfill advances only the verified fingerprint and stops on a real update still awaiting translation", async () => {
  await addEvent();
  await addAction("confirm");
  await initializeWebhookBaselines([codex], now);
  await enableSubscription();
  const before = await baseline();
  assert.ok(before?.fingerprint);
  await addAction("progress", { zh: "进一步说明" });
  await capture();
  const pending = await inventory();
  assert.deepEqual(pending.unpublished, [{ monitorId: "codex", id: eventId }]);
  await assert.rejects(apply({ fingerprint: pending.fingerprint, selected: [] }), /尚未发布的 Webhook 变更/);
  assert.deepEqual(await baseline(), before);
  await sql`UPDATE monitor_event_actions SET title=${sql.json(properName("Further details"))} WHERE monitor_id='codex' AND id='progress'`;
  await capture();
  assert.deepEqual(await notifications(), [{ action: "updated", revision: 1 }]);
  await sql`UPDATE monitor_webhook_deliveries SET status='sent',sent_at=now()`;
  const published = await baseline();
  const { fingerprint, unpublished } = await inventory();
  assert.deepEqual(unpublished, []);
  await apply({ fingerprint, selected: [] });
  const rebased = await baseline();
  assert.notEqual(rebased!.fingerprint, published!.fingerprint);
  assert.deepEqual(rebased, { ...published, fingerprint: rebased!.fingerprint });
  await capture();
  assert.deepEqual(await notifications(), [{ action: "updated", revision: 1 }]);
});

test("a stored all-users label rebases the previous unspecified label without a new revision", async () => {
  await addEvent({ type: "unknown", note: fixedScopeNote("unknown") });
  await addAction("confirm");
  await initializeWebhookBaselines([codex], now);
  await enableSubscription();
  const current = await baseline();
  await inMonitor(codex, async () => {
    const input = await loadActionInput();
    const event = readyEvent(input.events[0]!, input, now)!;
    const previous = { ...event, scope: { type: "unknown", note: defaultScopeLabel("unknown") } };
    await replaceWebhookFingerprint(sql, eventId, sha256(stableJson(previous)));
  });
  const { fingerprint, unpublished } = await inventory();
  assert.deepEqual(unpublished, []);
  await apply({ fingerprint, selected: [] });
  assert.deepEqual(await baseline(), current);
  await capture();
  assert.deepEqual(await notifications(), []);
});
