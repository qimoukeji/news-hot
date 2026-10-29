import { siteQueueSelection } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PgBoss } from "pg-boss";
import { DEPLOYMENT } from "@aihot/site";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { ensureQueue, getBoss, stopBoss, queueEnabled, QueueDisabledError, workModuleQueues } from "@aihot/backend/jobs/queue";
import { registerContentJobs } from "@aihot/backend/jobs/content";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { registerNotifyJobs } from "@aihot/backend/jobs/notify";
import { registerPublicationJobs } from "@aihot/backend/jobs/publication";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { currentSchedules, reconcileSchedules, registerSchedules } from "../apps/worker/src/schedules.ts";

after(async () => { DEPLOYMENT.queues = null; installModules([]); await stopBoss(); await closeDb(); });
test("worker restarts preserve only the configured business queues and cron definitions while safety valves stay closed", async () => {
  DEPLOYMENT.queues = siteQueueSelection;
  assert.deepEqual(DEPLOYMENT.engineSchedules, []);
  process.env.COLLECT_ENABLED = "false";
  config.modelCallsEnabled = false;
  installModules(SERVER_MODULES);
  const expected = siteQueueSelection!.filter(name => !name.endsWith(".translate")).sort();
  const expectedSchedules = expected.filter(name => name.startsWith("cron."));
  assert.deepEqual(currentSchedules().map(item => `cron.${item.name}`).sort(), expectedSchedules);
  for (const schedule of currentSchedules().filter(schedule => schedule.name.endsWith(".tick"))) assert.deepEqual(await schedule.run(), { skipped: true, reason: "automatic_processing_disabled" });
  for (let boot = 0; boot < 2; boot++) {
    const boss = new PgBoss({ connectionString: config.databaseUrl, schedule: false, supervise: false });
    await boss.start();
    try {
      await registerContentJobs(boss);
      await registerSourceJobs(boss);
      await registerEventJobs(boss);
      await registerNotifyJobs(boss);
      await registerPublicationJobs(boss);
      await workModuleQueues(boss);
      await registerSchedules(boss);
      assert.deepEqual((await boss.getQueues()).map(queue => queue.name).filter(name => !name.startsWith("__pgboss__")).sort(), expected);
      assert.deepEqual((await boss.getSchedules()).map(item => item.name).sort(), expectedSchedules);
      await assert.rejects(ensureQueue("content.analyze"), QueueDisabledError);
      assert.equal(queueEnabled("reset.webhook"), false);
      // Reconciliation runs with the worker stopped; stop polling before retiring its queues.
      for (const name of expectedSchedules) await boss.offWork(name);
      await reconcileSchedules(boss, [{ name: "fixture.denied", cron: "* * * * *", run: async () => null }]);
      assert.equal(await boss.getQueue("cron.fixture.denied"), null);
      await reconcileSchedules(boss);
      assert.deepEqual((await boss.getQueues()).map(queue => queue.name).filter(name => !name.startsWith("__pgboss__")).sort(), expected);
      assert.equal((await sql`SELECT 1 FROM receipts`).length, 0);
    } finally { await boss.stop({ graceful: false }); }
  }
});

test("monitor translation schedules register independently with model calls enabled and collection disabled", async () => {
  const originalCalls = config.modelCallsEnabled, originalCollecting = process.env.COLLECT_ENABLED;
  DEPLOYMENT.queues = siteQueueSelection;
  installModules(SERVER_MODULES);
  config.modelCallsEnabled = true;
  process.env.COLLECT_ENABLED = "false";
  const translationQueues = ["cron.claude-reset.translate", "cron.codex-reset.translate", "cron.grok-reset.translate"];
  const expectedSchedules = siteQueueSelection!.filter(name => name.startsWith("cron.")).sort();
  const boss = new PgBoss({ connectionString: config.databaseUrl, schedule: false, supervise: false });
  await boss.start();
  try {
    assert.deepEqual(currentSchedules().map(item => `cron.${item.name}`).sort(), expectedSchedules);
    assert.deepEqual(currentSchedules().filter(item => item.name.endsWith(".translate")).map(item => `cron.${item.name}`).sort(), translationQueues);
    for (const schedule of currentSchedules().filter(item => item.name.endsWith(".tick")))
      assert.deepEqual(await schedule.run(), { skipped: true, reason: "automatic_processing_disabled" });
    await registerSchedules(boss);
    assert.deepEqual((await boss.getSchedules()).map(item => item.name).sort(), expectedSchedules);
    for (const name of translationQueues) assert.ok(await boss.getQueue(name));
    assert.equal(queueEnabled("content.translate"), false);
    assert.equal(queueEnabled("cron.content.translate"), false);
    assert.equal((await sql`SELECT id FROM receipts`).length, 0, "registering cron definitions must not invoke a model");
    for (const name of expectedSchedules) await boss.offWork(name);
    config.modelCallsEnabled = false;
    await reconcileSchedules(boss);
    for (const name of translationQueues) assert.equal(await boss.getQueue(name), null);
    assert.deepEqual((await boss.getSchedules()).map(item => item.name).sort(), expectedSchedules.filter(name => !name.endsWith(".translate")));
  } finally {
    await boss.stop({ graceful: false });
    config.modelCallsEnabled = originalCalls;
    process.env.COLLECT_ENABLED = originalCollecting;
  }
});

test("an already ensured queue is still rejected after the site disables it", async () => {
  DEPLOYMENT.queues = null;
  await ensureQueue("fixture.cached");
  const boss = await getBoss();
  assert.ok(await boss.getQueue("fixture.cached"));
  DEPLOYMENT.queues = siteQueueSelection;
  await assert.rejects(ensureQueue("fixture.cached"), QueueDisabledError);
  await boss.deleteQueue("fixture.cached");
});
