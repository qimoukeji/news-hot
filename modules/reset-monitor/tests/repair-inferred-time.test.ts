import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { inMonitor, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { loadActionInput, rowVersion } from "../backend/action-store.ts";
import { inferenceBoundary, inferredConfirmation } from "../backend/confirmation.ts";
import { saveEditorialState, editorialStatus } from "../backend/event-editorial.ts";
import { initializeWebhookBaselines } from "../backend/webhook-events.ts";
import { deliverWebhook, retryWebhookDelivery } from "../backend/webhooks.ts";
import { properName, projectPublicV2, projectRawV2 } from "../backend/public-v2.ts";
import { previewInferredTimeRepair, applyInferredTimeRepair } from "../scripts/repair-inferred-time.ts";
import type { BusinessTime } from "../public-v2.ts";

const at = "2026-10-01T00:00:00Z";
beforeEach(async () => {
  await sql`DELETE FROM monitor_webhook_deliveries`; await sql`DELETE FROM monitor_webhook_notifications`; await sql`DELETE FROM monitor_webhook_subscriptions`;
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`;
});
after(closeDb);
const dump = (file: string) => execFileSync(process.env.PG_DUMP ?? "pg_dump", ["--format=custom", "--file", file, process.env.DATABASE_URL!],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });

async function legacy(definition: ResetMonitorBackendDefinition, id: string, time: BusinessTime) {
  return inMonitor(definition, async () => {
    await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,title,processing_status)
      VALUES(${definition.monitorId},${`${id}-source`},${definition.authors[0]!.handle},${at},${`https://example.test/${id}`},'Private synthetic original source',${sql.json(properName("Synthetic source"))},'processed')`;
    await sql`INSERT INTO monitor_event_records(monitor_id,id,type,title,created_at,updated_at)
      VALUES(${definition.monitorId},${id},'reset_credit',${sql.json(properName("Synthetic event"))},${at},${at})`;
    await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,time,sources,created_at,updated_at)
      VALUES(${definition.monitorId},${`${id}-announce`},${id},1,'announce',${sql.json(properName("Synthetic plan"))},${sql.json(time)},${sql.json([{ postId: `${id}-source` }])},${at},${at})`;
    const input = await loadActionInput(), action = inferredConfirmation(input.events.find(event => event.id === id)!, input, inferenceBoundary(time) + 1_000)!;
    assert.ok(action);
    await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,summary,time,sources,created_at,updated_at)
      VALUES(${definition.monitorId},${action.id},${id},${action.sequence},'confirm',${sql.json(action.title)},${sql.json(action.summary!)},${sql.json(time)},'[]'::jsonb,${action.created_at},${action.updated_at})`;
    return action.id;
  });
}

test("reviewed inferred-time repair preserves records and editorial state, cancels old unsent deliveries and creates no historical notifications", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "inferred-time-repair-")), backup = path.join(dir, "complete.dump");
  const time: BusinessTime = { kind: "range", from: "2026-10-31T05:42:26Z", through: "2026-11-02T05:42:26.123456789Z" };
  try {
    const id = await legacy(codex, "repair", time);
    const officialId = await legacy(codex, "official", { kind: "date", date: "2026-10-10", timeZone: "Asia/Shanghai" });
    await sql`UPDATE monitor_event_actions SET sources=${sql.json([{ postId: "official-source" }])} WHERE monitor_id='codex' AND id=${officialId}`;
    const claudeId = await legacy(claude, "other-platform", { kind: "date", date: "2026-10-12", timeZone: "Asia/Shanghai" });
    await sql`UPDATE monitor_event_actions SET id='administrator-confirmation' WHERE monitor_id='claude' AND id=${claudeId}`;
    let before = await inMonitor(codex, () => loadActionInput());
    const row = before.events.find(event => event.id === "repair")!, action = before.actions.find(action => action.id === id)!;
    await inMonitor(codex, () => saveEditorialState(sql, row, before, "edited"));
    for (const [key, version] of [[`public_v2:translation:action:${id}`, rowVersion(action)], ["public_v2:translation:event:repair", rowVersion(row)]]) {
      await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex',${key},${sql.json({ status: "failed", version, receiptId: 123 })})`;
    }
    await initializeWebhookBaselines([codex]);
    await sql`UPDATE monitor_state SET value=value || '{"revision":7,"notified":true}'::jsonb WHERE monitor_id='codex' AND key='webhook:event:repair'`;
    before = await inMonitor(codex, () => loadActionInput());
    const oldEvent = projectPublicV2(before, codex).events.find(event => event.id === "repair")!;
    const notificationId = randomUUID();
    await sql`INSERT INTO monitor_webhook_notifications(id,monitor_id,event_id,revision,payload)
      VALUES(${notificationId},'codex','repair',7,${sql.json({ schemaVersion: 2, id: notificationId, occurredAt: at, platform: "codex", eventId: "repair", revision: 7, action: "updated", event: oldEvent })})`;
    const deliveries: Array<{ id: string; subscriptionId: string; status: string }> = [];
    for (const status of ["pending", "sending", "failed", "sent"]) {
      const subscriptionId = randomUUID(), deliveryId = randomUUID();
      await sql`INSERT INTO monitor_webhook_subscriptions(id,name,url,platforms,enabled,enabled_at,secret)
        VALUES(${subscriptionId},${`Synthetic ${status}`},'https://example.test/hook',ARRAY['codex'],true,${at},'synthetic-test-secret')`;
      await sql`INSERT INTO monitor_webhook_deliveries(id,subscription_id,notification_id,generation,status)
        VALUES(${deliveryId},${subscriptionId},${notificationId},1,${status})`;
      deliveries.push({ id: deliveryId, subscriptionId, status });
    }
    const preview = await previewInferredTimeRepair(path.join(dir, "preview"));
    const codexPreview = preview.monitors.find(row => row.monitorId === "codex")!;
    assert.equal(codexPreview.changes.length, 1);
    assert.deepEqual(codexPreview.problems, []);
    assert.equal(codexPreview.cancelledDeliveryIds.length, 3);
    assert.equal(preview.monitors.find(row => row.monitorId === "claude")!.changes.length, 0);
    assert.doesNotMatch(await readFile(path.join(dir, "preview", "codex-before.json"), "utf8"), /Private synthetic original source|synthetic-test-secret/);
    dump(backup);
    const result = await applyInferredTimeRepair(preview, { output: path.join(dir, "apply"), databaseBackup: backup, workerStopped: true });
    assert.equal(result.find(row => row.monitorId === "codex")!.repaired, 1);
    const after = await inMonitor(codex, () => loadActionInput()), saved = after.actions.find(action => action.id === id)!;
    assert.deepEqual(saved.time, { kind: "instant", at: time.through });
    assert.deepEqual([saved.id, saved.created_at, saved.sources], [action.id, action.created_at, action.sources]);
    assert.deepEqual(after.actions.find(action => action.id === "repair-announce"), before.actions.find(action => action.id === "repair-announce"));
    assert.deepEqual(after.actions.find(action => action.id === officialId), before.actions.find(action => action.id === officialId));
    assert.deepEqual(after.posts, before.posts);
    assert.equal(editorialStatus(after.events.find(event => event.id === "repair")!, after), "edited");
    for (const [key, version] of [[`public_v2:translation:action:${id}`, rowVersion(saved)], ["public_v2:translation:event:repair", rowVersion(after.events.find(event => event.id === "repair"))]]) {
      const [state] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${key}`;
      assert.deepEqual(state!.value, { status: "failed", version, receiptId: 123 });
    }
    const [baseline] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='webhook:event:repair'`;
    assert.equal(baseline!.value.revision, 7);
    assert.equal(baseline!.value.notified, true);
    assert.equal(baseline!.value.fingerprint, sha256(stableJson(projectRawV2(after, codex).events.find(event => event.id === "repair"))));
    assert.equal((await sql`SELECT id FROM monitor_webhook_notifications`).length, 1);
    for (const delivery of deliveries) {
      const [saved] = await sql`SELECT status FROM monitor_webhook_deliveries WHERE id=${delivery.id}`;
      assert.equal(saved!.status, delivery.status === "sent" ? "sent" : "cancelled");
      if (delivery.status === "failed") await assert.rejects(retryWebhookDelivery(delivery.subscriptionId, delivery.id, "Synthetic retry", "test"), /仅可重发/);
      let sends = 0;
      await deliverWebhook(delivery.id, { pushEnabled: () => true, transport: async () => { sends++; throw new Error("Historical delivery must never send"); } });
      assert.equal(sends, 0);
    }
    const stable = await previewInferredTimeRepair(path.join(dir, "after-preview"));
    assert.ok(stable.monitors.every(row => row.changes.length === 0 && row.problems.length === 0));
    assert.equal((await sql`SELECT id FROM audit_log WHERE action LIKE '%repair_inferred_time'`).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("inferred-time repair refuses missing stop acknowledgement, incomplete backups and changed reviewed facts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "inferred-time-repair-guard-")), backup = path.join(dir, "complete.dump");
  try {
    const id = await legacy(codex, "repair", { kind: "date", date: "2026-11-02", timeZone: "Asia/Shanghai" });
    const preview = await previewInferredTimeRepair(path.join(dir, "preview"));
    await assert.rejects(applyInferredTimeRepair(preview, { output: path.join(dir, "not-stopped"), databaseBackup: backup, workerStopped: false }), /Stop API writers/);
    const invalid = path.join(dir, "not-a-backup.dump"); await writeFile(invalid, "not a backup");
    await assert.rejects(applyInferredTimeRepair(preview, { output: path.join(dir, "invalid"), databaseBackup: invalid, workerStopped: true }), /not a PostgreSQL custom-format dump/);
    dump(backup);
    await sql`UPDATE monitor_event_actions SET updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${id}`;
    await assert.rejects(applyInferredTimeRepair(preview, { output: path.join(dir, "stale"), databaseBackup: backup, workerStopped: true }), /Repair evidence changed/);
    const [action] = await sql`SELECT time FROM monitor_event_actions WHERE monitor_id='codex' AND id=${id}`;
    assert.deepEqual(action!.time, { kind: "date", date: "2026-11-02", timeZone: "Asia/Shanghai" });
    assert.equal((await sql`SELECT id FROM audit_log WHERE action LIKE '%repair_inferred_time'`).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a migrated original-null ID is repairable only with its reviewed original defaults snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "inferred-time-prior-defaults-")), prior = path.join(dir, "prior"), backup = path.join(dir, "complete.dump");
  try {
    const time: BusinessTime = { kind: "date", date: "2026-10-01", timeZone: "Asia/Shanghai" };
    const currentId = await legacy(codex, "legacy", time);
    const historicalId = `inferred-${sha256(stableJson({ event: "legacy", plan: sha256(stableJson([{ id: "legacy-announce", action: "announce", time: null }])) }))}`;
    await sql`UPDATE monitor_event_actions SET id=${historicalId} WHERE monitor_id='codex' AND id=${currentId}`;
    const withoutEvidence = await previewInferredTimeRepair(path.join(dir, "without-evidence"));
    assert.equal(withoutEvidence.monitors.find(row => row.monitorId === "codex")!.problems.length, 1);
    const input = await inMonitor(codex, () => loadActionInput());
    await mkdir(prior);
    await writeFile(path.join(prior, "codex-before.json"), JSON.stringify({ ...input,
      posts: input.posts.map(post => ({ ...post, text: null, quoted_post: null })),
      actions: input.actions.map(action => ({ ...action, time: action.action === "announce" ? null : time.date })) }));
    for (const monitor of ["claude", "grok"]) await writeFile(path.join(prior, `${monitor}-before.json`), JSON.stringify({ events: [], posts: [], actions: [] }));
    const reviewed = await previewInferredTimeRepair(path.join(dir, "with-evidence"), prior);
    const plan = reviewed.monitors.find(row => row.monitorId === "codex")!;
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.changes[0]!.idProof, "scalar-defaults");
    assert.equal(plan.defaultsEvidence[0]!.originalTime, null);
    dump(backup);
    await applyInferredTimeRepair(reviewed, { output: path.join(dir, "apply"), databaseBackup: backup, workerStopped: true });
    const [action] = await sql`SELECT id,time FROM monitor_event_actions WHERE monitor_id='codex' AND id=${historicalId}`;
    assert.equal(action!.id, historicalId);
    assert.deepEqual(action!.time, { kind: "instant", at: "2026-10-01T10:00:00Z" });
    const next = await previewInferredTimeRepair(path.join(dir, "next"), prior);
    assert.ok(next.monitors.every(row => row.changes.length === 0 && row.problems.length === 0));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
