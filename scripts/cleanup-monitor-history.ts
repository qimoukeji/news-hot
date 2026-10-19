import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { sql, closeDb } from "@aihot/backend/db";
import { monitorHistorySnapshot, monitorHistoryPlan, cleanupMonitorHistory } from "@aihot/reset-monitor/backend/history-cleanup";
import { RESET_MONITORS } from "@aihot/site/reset-monitors";

const { values } = parseArgs({ options: { apply: { type: "boolean" }, fingerprint: { type: "string" }, backup: { type: "string" } }, strict: true });
try {
  const monitors = Object.keys(RESET_MONITORS);
  if (!values.apply) {
    const plan = await sql.begin("isolation level repeatable read read only", async db => monitorHistoryPlan(await monitorHistorySnapshot(monitors, db)));
    console.log(JSON.stringify(plan, null, 2));
  } else {
    if (!values.fingerprint || !values.backup) throw new Error("--apply requires the reviewed --fingerprint and a verified custom-format --backup file");
    const dump = await readFile(values.backup);
    if (dump.length < 1024 || dump.subarray(0, 5).toString() !== "PGDMP") throw new Error("Backup is not a PostgreSQL custom-format dump");
    console.log(JSON.stringify(await cleanupMonitorHistory(monitors, values.fingerprint), null, 2));
  }
} finally { await closeDb(); }
