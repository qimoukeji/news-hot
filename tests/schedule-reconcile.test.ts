import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { PgBoss } from "pg-boss";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { currentSchedules } from "../apps/worker/src/schedules.ts";

const boss = new PgBoss({ connectionString: config.databaseUrl, schedule: false, supervise: false });
after(async () => { await boss.stop({ graceful: false }); await closeDb(); });

async function command(...args: string[]) {
  const child = spawn(process.execPath, ["scripts/reconcile-schedules.ts", ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}

test("site schedule reconciliation previews, removes retired execution work and keeps history without running tasks", async () => {
  installModules(SERVER_MODULES);
  const expected = ["cron.claude-reset.tick", "cron.grok-reset.tick", "cron.monitor.tick", "cron.ops.alerts", "cron.ops.recover", "cron.ops.retention", "cron.reset-subscriptions.sweep"];
  assert.deepEqual(currentSchedules().map(s => `cron.${s.name}`).sort(), expected);
  await boss.start();
  for (const name of ["cron.sources.schedule", "cron.old.unscheduled", "business.saved", "cron.monitor.tick"]) {
    await boss.createQueue(name);
    await boss.send(name, {}, { startAfter: "2099-01-01" });
  }
  await boss.schedule("cron.sources.schedule", "* * * * *");
  await sql`INSERT INTO job_runs(job,status,finished_at) VALUES('sources.schedule','ok',now())`;
  const beforeRuns = await sql`SELECT * FROM job_runs ORDER BY id`;
  const beforeReceipts = await sql`SELECT * FROM receipts ORDER BY id`;
  const snapshot = async () => ({
    queues: await sql`SELECT to_jsonb(q) AS row FROM pgboss.queue q ORDER BY name`,
    schedules: await sql`SELECT to_jsonb(s) AS row FROM pgboss.schedule s ORDER BY name,key`,
    jobs: await sql`SELECT to_jsonb(j) AS row FROM pgboss.job j ORDER BY name,id`,
    runs: await sql`SELECT * FROM job_runs ORDER BY id`,
  });
  const before = await snapshot();
  const preview = await command();
  assert.equal(preview.code, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.deepEqual(plan.keep, expected);
  assert.deepEqual(plan.remove, ["cron.old.unscheduled", "cron.sources.schedule"]);
  assert.deepEqual(await snapshot(), before, "preview cannot mutate jobs, schedule definitions, queues or run history");
  assert.ok(await boss.getQueue("cron.sources.schedule"), "preview cannot mutate queues");
  const refused = await command("--apply");
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /worker-stopped/);
  const applied = await command("--apply", "--worker-stopped");
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual((await boss.getQueues()).map(q => q.name).filter(name => name.startsWith("cron.")).sort(), expected);
  assert.deepEqual((await boss.getSchedules()).map(s => s.name).sort(), expected);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name IN ('cron.sources.schedule','cron.old.unscheduled')`).length, 0);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name='business.saved'`).length, 1);
  assert.deepEqual(await sql`SELECT * FROM job_runs ORDER BY id`, beforeRuns, "operator process must never run task handlers");
  assert.deepEqual(await sql`SELECT * FROM receipts ORDER BY id`, beforeReceipts);
  assert.equal((await sql`SELECT id FROM audit_log WHERE action='schedules.reconcile'`).length, 1);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name IN ('cron.ops.alerts','cron.ops.recover','cron.ops.retention','cron.claude-reset.tick','cron.grok-reset.tick')`).length, 0,
    "operator process must not dispatch cron work");
  const again = await command("--apply", "--worker-stopped");
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).remove, []);

  await boss.createQueue("cron.active.retired");
  await boss.send("cron.active.retired", {});
  await boss.fetch("cron.active.retired");
  const active = await command("--apply", "--worker-stopped");
  assert.notEqual(active.code, 0);
  assert.match(active.stderr, /Active cron jobs remain/);
  assert.ok(await boss.getQueue("cron.active.retired"), "active work must be inspected before removal");
  installModules([{ name: "fixture", schedules: [
    { name: "fixture.unlisted", cron: "0 0 1 1 *", run: async () => ({}) },
    { name: "fixture.disabled", cron: "0 0 1 1 *", when: () => false, run: async () => ({}) },
  ] }]);
  assert.deepEqual(currentSchedules().map(s => s.name).sort(), ["fixture.unlisted", "ops.alerts", "ops.recover", "ops.retention"]);
});
