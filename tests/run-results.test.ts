import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { runsOverview } from "@aihot/backend/admin/runs";
import { backendDefinition } from "../modules/codex-reset/backend-definition.ts";
import type { ReviewNotificationRunData } from "../modules/reset-monitor/review-notification-run-data.ts";
import { REVIEW_NOTIFICATION_JOB, subscriptionsModule } from "../modules/reset-monitor/subscriptions-module.ts";
import { createSubscriptionsServer } from "../modules/reset-monitor/subscriptions-server.ts";

after(async () => { installModules([]); await stopBoss(); await closeDb(); });

test("the owning module exposes partial notification results and hides raw details in shared tables", async () => {
  const boss = await getBoss();
  const queue = `cron.${REVIEW_NOTIFICATION_JOB}`;
  await boss.createQueue(queue);
  await boss.schedule(queue, "* * * * *");
  const raw = "https://sctapi.ftqq.com/SCTSyntheticPrivateKey.send must-not-expose-private-payload";
  const jobId = await boss.send(queue, {});
  assert.ok(jobId);
  await sql`UPDATE pgboss.job SET state='failed', completed_on=now(), output=${sql.json({ message: raw })} WHERE id=${jobId}`;
  const definition = { ...backendDefinition, monitorId: "configured-monitor", product: "Configured Product", adminPath: "/admin/configured-monitor" };
  installModules([
    createSubscriptionsServer([definition]),
    { name: "another-module", admin: { runs: async () => ({ unchanged: true }), currentJobs: async () => ["other-notify.task"] } },
  ]);
  const error = { monitorId: definition.monitorId, code: "http", status: 503 };
  const detail = { sent: 2, failed: 1, errors: [{ ...error, message: raw }, { monitorId: raw, code: "transport" }], rawResponse: raw, sourceText: raw };
  const emptyRun = { sent: 0, failed: 0, unknown: 0, cancelled: 0, skippedQuota: 0, skippedExpired: 0, disabled: false };
  await sql`INSERT INTO job_runs(job,status,started_at,finished_at,detail)
    SELECT ${REVIEW_NOTIFICATION_JOB},'ok',now() - n * interval '1 minute',now() - n * interval '1 minute',${sql.json(emptyRun)} FROM generate_series(2,15) AS n`;
  await sql`INSERT INTO job_runs(job,status,started_at,finished_at,error,detail) VALUES
    (${REVIEW_NOTIFICATION_JOB},'failed',now() - interval '1 minute',now() - interval '1 minute',${raw},${sql.json(detail)}),
    (${REVIEW_NOTIFICATION_JOB},'ok',now(),now(),NULL,${sql.json(emptyRun)}),
    ('other-notify.task','ok',now(),now(),NULL,${sql.json({ sent: 1, errors: [raw] })})`;
  const attemptedAt = "2026-11-11T04:00:00.000Z";
  const failedIssue = { postId: "1234567890123456789", status: "failed", attemptedAt, error: { code: "rejected", providerCode: -40001, message: raw }, rawResponse: raw };
  const unknownIssue = { postId: "1234567890123456790", status: "unknown", attemptedAt: "2026-11-11T03:00:00.000Z", error: { code: "transport", url: raw } };
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES
    (${definition.monitorId},'review-notification:episode:failed',${sql.json(failedIssue)}),
    (${definition.monitorId},'review-notification:episode:unknown',${sql.json(unknownIssue)}),
    (${definition.monitorId},'review-notification:episode:sent',${sql.json({ ...failedIssue, status: "sent" })}),
    (${definition.monitorId},'review-notification:episode:invalid-post',${sql.json({ ...failedIssue, postId: raw })}),
    ('unconfigured-monitor','review-notification:episode:unknown',${sql.json(unknownIssue)})`;
  const overview = await runsOverview();
  const panel = overview.modules[subscriptionsModule.name] as ReviewNotificationRunData;
  assert.deepEqual(overview.modules["another-module"], { unchanged: true });
  assert.equal(panel.latest?.status, "ok");
  assert.deepEqual(panel.latest?.detail, { ...emptyRun, errors: [] });
  assert.equal(panel.history.length, 9);
  assert.equal(panel.history[0]?.status, "failed");
  assert.deepEqual(panel.history[0]?.detail, { sent: 2, failed: 1, errors: [error] });
  assert.deepEqual(panel.issues, [
    { monitorId: definition.monitorId, postId: failedIssue.postId, status: "failed", attemptedAt, error: { monitorId: definition.monitorId, code: "rejected", providerCode: -40001 } },
    { monitorId: definition.monitorId, postId: unknownIssue.postId, status: "unknown", attemptedAt: unknownIssue.attemptedAt, error: { monitorId: definition.monitorId, code: "transport" } },
  ]);
  assert.equal(overview.jobs.find(row => row.job === REVIEW_NOTIFICATION_JOB)?.failed_24h, 1);
  assert.equal(overview.timeline.find(row => row.job === REVIEW_NOTIFICATION_JOB && row.status === "failed")?.error, null);
  for (const rows of [overview.jobs, overview.timeline]) {
    const owned = rows.find(row => row.job === REVIEW_NOTIFICATION_JOB)!;
    assert.equal(owned.status, "ok");
    assert.equal(owned.error, null);
    assert.equal(owned.detail, null);
    assert.equal(rows.find(row => row.job === "other-notify.task")!.detail, null);
  }
  assert.equal(overview.failedJobs.find(job => job.name === queue)?.last_output, null);
  assert.doesNotMatch(JSON.stringify(overview), /sctapi\.ftqq\.com|SCTSyntheticPrivateKey|must-not-expose-private-payload/);
});

test("latest runs and timeline share safe business statistics without publishing arbitrary task details", async () => {
  await getBoss();
  installModules([{ name: "run-result-test", admin: { currentJobs: async () => ["monitor.tick", "grok-reset.tick", "generic.task"] } }]);
  const reviewed = { processed: 5, reviewed: 3, failed: 0, schemaFailures: 1, rawResponse: { text: "private-job-payload" }, sourceText: "private-job-payload" };
  const partial = { outcome: "partial", complete: false, collectionComplete: false, pages: 5, windowPages: 10, reason: "page_limit", stored: 20 };
  await sql`INSERT INTO job_runs(job,status,finished_at,detail) VALUES
    ('monitor.tick','ok',now(),${sql.json(reviewed)}),
    ('grok-reset.tick','ok',now(),${sql.json(partial)}),
    ('generic.task','ok',now(),' {"text":"private-job-payload"}'::jsonb)`;
  const overview = await runsOverview();
  for (const rows of [overview.jobs, overview.timeline]) {
    assert.deepEqual(rows.find(row => row.job === "monitor.tick")!.detail, { processed: 5, reviewed: 3, failed: 0, schemaFailures: 1 });
    assert.deepEqual(rows.find(row => row.job === "grok-reset.tick")!.detail, partial);
    assert.equal(rows.find(row => row.job === "generic.task")!.detail, null);
  }
  assert.doesNotMatch(JSON.stringify({ jobs: overview.jobs, timeline: overview.timeline }), /private-job-payload/);
});
