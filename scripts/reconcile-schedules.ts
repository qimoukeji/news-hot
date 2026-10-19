import { parseArgs } from "node:util";
import { PgBoss } from "pg-boss";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { currentSchedules, reconcileSchedules } from "../apps/worker/src/schedules.ts";

const { values } = parseArgs({ options: { apply: { type: "boolean" }, "worker-stopped": { type: "boolean" } }, strict: true });
if (values.apply && !values["worker-stopped"]) throw new Error("--apply requires --worker-stopped after stopping every worker");
installModules(SERVER_MODULES);
// No task handlers, timers, maintenance, or schema creation in this operator process.
const boss = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss", application_name: "aihot-schedule-reconcile",
  schedule: false, supervise: false, migrate: false, createSchema: false });
boss.on("error", error => console.error("Schedule connection error:", error.message));
try {
  await boss.start();
  const definitions = currentSchedules();
  const keep = definitions.map(s => `cron.${s.name}`).sort();
  const current = (await boss.getQueues()).map(q => q.name).filter(name => name.startsWith("cron.")).sort();
  const remove = current.filter(name => !keep.includes(name));
  const plan = { current, keep, remove, add: keep.filter(name => !current.includes(name)) };
  if (values.apply) {
    const active = await sql`SELECT id FROM pgboss.job WHERE name LIKE 'cron.%' AND state='active' LIMIT 1`;
    if (active.length) throw new Error("Active cron jobs remain; stop every worker and inspect unfinished work before reconciliation");
    await reconcileSchedules(boss, definitions);
    await audit("operator", "schedules.reconcile", "cron", "Synchronize site schedule definitions while workers are stopped", { current }, { keep, remove, add: plan.add });
  }
  console.log(JSON.stringify({ applied: !!values.apply, ...plan }, null, 2));
} finally {
  await boss.stop({ graceful: false });
  await closeDb();
}
