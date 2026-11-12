import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { convertLegacyInput, convertLegacyTime, loadScalarUpgradeInput, planUpgradeStates, projectUpgradeEvents, restoreUpgradeSets, serializeUpgradeSets, timeUpgradeDigest, timeUpgradeKey, upgradeHash, upgradeJson, verifyBusinessTimeUpgrade, type LegacyInput, type StructuredUpgradeInput, type UpgradeSetSnapshot, type UpgradeState, type UpgradeTimeRow } from "./business-time-upgrade.ts";
import { withoutPostOriginal } from "../actions.ts";

async function main() {
  const { values } = parseArgs({ options: {
    output: { type: "string" }, apply: { type: "boolean", default: false },
    "worker-stopped": { type: "boolean", default: false }, "database-backup": { type: "string" },
    "batch-size": { type: "string", default: "200" },
    "verification-database-env": { type: "string" },
  } });
  if (!values.output) throw new Error("Usage: migrate-business-time.ts --output NEW_DIRECTORY [--apply --worker-stopped --database-backup VERIFIED_DUMP] [--verification-database-env ENV_NAME] [--batch-size 200]");
  if (values.apply && (!values["worker-stopped"] || !values["database-backup"])) throw new Error("Applying requires stopped writers and deliveries plus --database-backup VERIFIED_DUMP; restore-test the backup separately first");
  const batchSize = Number(values["batch-size"]);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("batch-size must be between 1 and 1000");
  const verificationEnv = values["verification-database-env"];
  if (verificationEnv && (!/^[A-Z][A-Z0-9_]*$/.test(verificationEnv) || !process.env[verificationEnv])) throw new Error("verification-database-env must name a configured process environment variable");
  const verificationDatabaseUrl = verificationEnv ? process.env[verificationEnv] : undefined;
  let backup: { path: string; bytes: number; sha256: string } | undefined;
  if (values["database-backup"]) {
    const file = path.resolve(values["database-backup"]), info = await stat(file);
    if (!info.isFile() || !info.size) throw new Error("Database backup must be an existing nonempty file");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    backup = { path: file, bytes: info.size, sha256: digest.digest("hex") };
  }
  const output = path.resolve(values.output);
  await mkdir(output, { recursive: false });
  const { sql, closeDb } = await import("@aihot/backend/db");
  if (values.apply) {
    const { verifyActionBackup } = await import("../backend/backup.ts");
    try { await verifyActionBackup(backup!.path, verificationDatabaseUrl); }
    catch (error) { await closeDb(); throw error; }
  }
  const { RESET_MONITOR_BACKENDS } = await import("@aihot/site/reset-monitor-backends");
  const { inMonitor } = await import("../backend/context.ts");
  type Prepared = { definition: typeof RESET_MONITOR_BACKENDS[number]; before: LegacyInput; after: StructuredUpgradeInput; states: UpgradeState[]; updates: UpgradeState[]; timestamps: Record<string, string> };
  const prepared: Prepared[] = [];
  try {
    const types = await sql<{ attname: string; type: string }[]>`SELECT attname,atttypid::regtype::text AS type FROM pg_attribute
      WHERE attrelid='monitor_event_actions'::regclass AND attnum>0 AND NOT attisdropped AND attname IN ('time','business_time')`;
    if (!types.some(row => row.attname === "time" && row.type === "text")) throw new Error("Upgrade expects the scalar time column; the application never converts old formats at runtime");
    if (values.apply && !types.some(row => row.attname === "business_time" && row.type === "jsonb")) throw new Error("Apply the 0146 cutoff migration before conversion");
    const monitors = await sql<{ monitor_id: string }[]>`SELECT DISTINCT monitor_id FROM monitor_event_actions`;
    for (const { monitor_id } of monitors) if (!RESET_MONITOR_BACKENDS.some(definition => definition.monitorId === monitor_id)) throw new Error(`Unknown monitor ${monitor_id}; configure its definition before conversion`);
    // Validate every monitor and the files read back from disk before the first database write.
    for (const definition of RESET_MONITOR_BACKENDS) await inMonitor(definition, async () => {
      const { before, states, timestamps } = await sql.begin("isolation level repeatable read read only", async db => ({
        before: await loadScalarUpgradeInput(db, definition.monitorId),
        states: await db<UpgradeState[]>`SELECT key,value FROM monitor_state WHERE monitor_id=${definition.monitorId}
          AND (key LIKE 'public_v2:overview:%' OR key LIKE 'public_v2:translation:action:%' OR key LIKE 'webhook:event:%') ORDER BY key`,
        timestamps: Object.fromEntries((await db<{ id: string; at: string }[]>`SELECT id,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM monitor_event_actions WHERE monitor_id=${definition.monitorId}`).map(row => [row.id, row.at])),
      }));
      const snapshot = { ...before, posts: before.posts.map(withoutPostOriginal), ...serializeUpgradeSets(before) };
      const snapshotFile = path.join(output, `${definition.monitorId}-before.json`);
      await writeFile(snapshotFile, JSON.stringify({ input: snapshot, states, timestamps }, null, 2), { flag: "wx" });
      const saved = JSON.parse(await readFile(snapshotFile, "utf8")) as { input: Omit<LegacyInput, keyof UpgradeSetSnapshot> & UpgradeSetSnapshot; states: UpgradeState[]; timestamps: Record<string, string> };
      assert.equal(upgradeJson(saved.input), upgradeJson(snapshot), "Backup snapshot failed read-back verification");
      const savedInput: LegacyInput = { ...saved.input, ...restoreUpgradeSets(saved.input) };
      const after = convertLegacyInput(savedInput);
      const updates = planUpgradeStates(savedInput, after, saved.states, projectUpgradeEvents(after, definition));
      assert.deepEqual(after.actions.map(action => [action.id, action.event_id, action.sequence, action.sources]), before.actions.map(action => [action.id, action.event_id, action.sequence, action.sources]));
      if (types.some(row => row.attname === "business_time")) {
        const shadows = await sql<{ id: string; business_time: unknown }[]>`SELECT id,business_time FROM monitor_event_actions WHERE monitor_id=${definition.monitorId}`;
        for (const row of shadows) if (row.business_time !== null && upgradeJson(row.business_time) !== upgradeJson(after.actions.find(action => action.id === row.id)?.time)) throw new Error(`Action ${row.id} has a conflicting partial conversion`);
      }
      await writeFile(path.join(output, `${definition.monitorId}-after.json`), JSON.stringify({ input: { ...after, ...serializeUpgradeSets(after) }, stateUpdates: updates }, null, 2), { flag: "wx" });
      assert.deepEqual(saved.timestamps, timestamps, "Exact database timestamps failed backup read-back verification");
      prepared.push({ definition, before, after, states: [...states], updates, timestamps });
    });
    await writeFile(path.join(output, "manifest.json"), JSON.stringify({ apply: values.apply, databaseBackup: backup, monitors: prepared.map(item => ({ id: item.definition.monitorId, actions: item.after.actions.length, snapshot: upgradeHash({ input: { ...item.before, posts: item.before.posts.map(withoutPostOriginal) }, states: item.states }) })) }, null, 2), { flag: "wx" });
    const summary: Array<{ monitor: string; actions: number; states: number; applied: boolean }> = [];
    for (const item of prepared) {
      const { definition, before, after, states, updates, timestamps } = item;
      if (values.apply) await inMonitor(definition, async () => {
        // Old time and record timestamps stay unchanged, so an interrupted run can be resumed
        // with a new output directory and exact-match already converted rows are simply retained.
        for (let start = 0; start < after.actions.length; start += batchSize) await sql.begin(async db => {
          for (const action of after.actions.slice(start, start + batchSize)) {
            const original = before.actions.find(row => row.id === action.id)!;
            const changed = await db`UPDATE monitor_event_actions SET business_time=${action.time === null ? null : db.json(action.time)}
              WHERE monitor_id=${definition.monitorId} AND id=${action.id} AND time IS NOT DISTINCT FROM ${original.time}
              AND to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=${timestamps[action.id]}
              AND (business_time IS NULL OR business_time=${action.time === null ? null : db.json(action.time)}) RETURNING id`;
            if (changed.length !== 1) throw new Error(`Action ${action.id} changed since preview; stop writers and rerun`);
          }
        });
        await sql.begin(async db => {
          // Lock in normal event/action order, then hold tables against any writer until metadata
          // and the completion digest commit together. No model or queue is started by this tool.
          await db`LOCK TABLE monitor_event_records,monitor_event_actions,monitor_source_posts,monitor_state IN SHARE ROW EXCLUSIVE MODE`;
          const current = await loadScalarUpgradeInput(db, definition.monitorId);
          assert.equal(upgradeJson({ ...current, posts: current.posts.map(withoutPostOriginal) }), upgradeJson({ ...before, posts: before.posts.map(withoutPostOriginal) }), "Records changed during conversion; rerun with writers stopped");
          const latestStates = await db<UpgradeState[]>`SELECT key,value FROM monitor_state WHERE monitor_id=${definition.monitorId}
            AND (key LIKE 'public_v2:overview:%' OR key LIKE 'public_v2:translation:action:%' OR key LIKE 'webhook:event:%') ORDER BY key`;
          assert.equal(upgradeJson(latestStates), upgradeJson(states), "Publication state changed during conversion");
          const rows = await db<(UpgradeTimeRow & { exact_updated_at: string })[]>`SELECT monitor_id,id,time,business_time,extract(epoch from updated_at)::text AS updated_at,
            to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_updated_at FROM monitor_event_actions WHERE monitor_id=${definition.monitorId} ORDER BY id`;
          for (const row of rows) {
            assert.equal(upgradeJson(row.business_time), upgradeJson(convertLegacyTime(row.time)), `Action ${row.id} conversion mismatch`);
            assert.equal(row.exact_updated_at, timestamps[row.id], `Action ${row.id} timestamp changed during conversion`);
          }
          for (const state of updates) await db`UPDATE monitor_state SET value=${db.json(state.value as never)},updated_at=clock_timestamp() WHERE monitor_id=${definition.monitorId} AND key=${state.key}`;
          await db`UPDATE monitor_webhook_deliveries d SET status='cancelled',next_attempt_at=NULL,last_error='Time contract upgraded; historical payload will not be replayed',updated_at=clock_timestamp()
            FROM monitor_webhook_notifications n WHERE d.notification_id=n.id AND n.monitor_id=${definition.monitorId} AND d.status IN ('pending','sending','failed')`;
          const value = { complete: true, digest: timeUpgradeDigest(rows) };
          await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${definition.monitorId},${timeUpgradeKey},${db.json(value)})
            ON CONFLICT(monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`;
        });
      });
      const result = { monitor: definition.monitorId, actions: after.actions.length, states: updates.length, applied: values.apply };
      summary.push(result); console.log(JSON.stringify(result));
    }
    if (values.apply) await verifyBusinessTimeUpgrade(sql);
    await writeFile(path.join(output, "result.json"), JSON.stringify(summary, null, 2), { flag: "wx" });
  } finally { await closeDb(); }
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database]") : "Business time upgrade failed");
  process.exitCode = 1;
});
