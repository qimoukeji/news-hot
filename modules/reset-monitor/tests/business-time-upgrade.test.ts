import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import postgres from "postgres";
import { runMigrations } from "../../../scripts/migrate.ts";
import { loadLegacyTimeInput } from "../scripts/time-cutover.ts";
import { inventoryScopeCutover } from "../scripts/scope-cutover.ts";
import { legacyScopeBaselineKey } from "../backend/webhook-events.ts";
import { closeDb } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { editorialPromptVersion, editorialRecordVersion } from "../backend/event-editorial.ts";
import { convertLegacyInput, loadScalarUpgradeInput, restoreUpgradeSets, serializeUpgradeSets, timeUpgradeKey, timeUpgradeThrough, upgradeEditorialFacts, upgradeEditorialVersion, upgradeHash, type LegacyInput, type StructuredUpgradeInput, type UpgradeSetSnapshot, type UpgradeState } from "../scripts/business-time-upgrade.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dumpCommand = process.env.PG_DUMP ?? "pg_dump";
const restoreCommand = process.env.PG_RESTORE ?? "pg_restore";

test("a scalar database upgrades through backup, preview, resumable apply and guarded JSONB cleanup", { timeout: 240000 }, async context => {
  for (const command of [dumpCommand, restoreCommand]) {
    const version = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (version.error) { context.skip("pg_dump and pg_restore are required for the database backup/restore exercise"); return; }
    assert.equal(version.status, 0, `${command} must be executable`);
  }
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `business_time_upgrade_${id}_test`, restoreName = `business_time_restore_${id}_test`;
  const urlOf = (name: string) => { const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`; return url.toString(); };
  const admin = postgres(urlOf("postgres"), { max: 1, onnotice: () => {} });
  let db: postgres.Sql | undefined, restored: postgres.Sql | undefined;
  const directory = mkdtempSync(path.join(tmpdir(), "business-time-upgrade-"));
  const commandPaths = [dumpCommand, restoreCommand].filter(command => path.isAbsolute(command)).map(command => path.dirname(command));
  const env = { ...process.env, PATH: [...commandPaths, process.env.PATH ?? ""].join(path.delimiter), DATABASE_URL: urlOf(databaseName), MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false", WEBHOOK_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false", PGPASSWORD: "" };
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, ["modules/reset-monitor/scripts/migrate-business-time.ts", ...args],
    { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const output = (name: string) => path.join(directory, name);
  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    await admin`CREATE DATABASE ${admin(restoreName)}`;
    db = postgres(urlOf(databaseName), { max: 1, onnotice: () => {} });
    await runMigrations(db, root, { through: timeUpgradeThrough });
    const localized = (text: string) => Object.fromEntries(["en", "zh", "zh-Hant", "ja", "ko", "ru", "es"].map(language => [language, text]));
    const records = [
      { id: "legacy-date", action: "announce", time: "2026-11-02", sourced: true },
      { id: "legacy-range", action: "confirm", time: "2026-11-01T23:00:00Z/2026-11-02T01:00:00Z", sourced: true },
      { id: "inferred-manual", action: "confirm", time: "2026-11-02T05:42:26.123456789+08:00", sourced: false },
    ];
    for (const row of records) {
      await db`INSERT INTO monitor_event_records(monitor_id,id,type,title,summary,created_at,updated_at)
        VALUES(${codex.monitorId},${row.id},'direct_reset',${db.json(localized(row.id))},NULL,'2026-10-31T00:00:00Z','2026-10-31T00:00:00Z')`;
      if (row.sourced) await db`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,processing_status,created_at,updated_at)
        VALUES(${codex.monitorId},${row.id},'thsottiaux','2026-10-31T00:00:00Z',${`https://x.com/thsottiaux/status/${row.id}`},${db.json(localized(row.id))},'processed','2026-10-31T00:00:00Z','2026-10-31T00:00:00Z')`;
      await db`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,invalidates_event,title,summary,time,sources,created_at,updated_at)
        VALUES(${codex.monitorId},${row.id},${row.id},1,${row.action},false,${db.json(localized(row.id))},NULL,${row.time},${db.json(row.sourced ? [{ postId: row.id }] : [])},'2026-10-31T00:00:00.123456Z','2026-10-31T00:00:00.123456Z')`;
    }
    for (const key of ["recognition:standalone-followup:legacy-range", "confirmation:invalidated:inferred-retired", "confirmation:manual:inferred-manual"]) {
      await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${codex.monitorId},${key},'true'::jsonb)`;
      await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES('claude',${key + '-other-monitor'},'true'::jsonb)`;
    }
    const before = await db.begin(tx => loadScalarUpgradeInput(tx, codex.monitorId));
    const expectedSets: UpgradeSetSnapshot = { standaloneFollowupIds: ["legacy-range"], invalidatedInferenceIds: ["inferred-retired"], manualConfirmationIds: ["inferred-manual"] };
    assert.deepEqual(serializeUpgradeSets(before), expectedSets, "legacy loader reads every marker within its monitor");
    const after = convertLegacyInput(before), states: UpgradeState[] = [];
    for (const event of after.events) {
      const facts = upgradeEditorialFacts(event, after)!;
      const version = upgradeHash({ prompt: editorialPromptVersion, facts: { ...facts, actions: facts.actions.map(action => ({ ...action, time: before.actions.find(old => old.id === action.id)!.time })) } });
      states.push({ key: `public_v2:overview:${event.id}`, value: { status: event.id === "legacy-range" ? "needs_review" : "ready", version: event.id === "inferred-manual" ? "stale" : version, recordVersion: editorialRecordVersion(event) } });
      states.push({ key: `webhook:event:${event.id}`, value: { revision: 7, fingerprint: "scalar-fingerprint", notified: true, withdrawn: false } });
    }
    states.push({ key: "public_v2:translation:action:legacy-date", value: { status: "failed", version: upgradeHash(before.actions.find(action => action.id === "legacy-date")), receiptId: 42 } });
    for (const state of states) await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${codex.monitorId},${state.key},${db.json(state.value as never)})`;
    const subscription = randomUUID();
    await db`INSERT INTO monitor_webhook_subscriptions(id,name,url,platforms,enabled,secret) VALUES(${subscription},'Synthetic test','https://example.invalid/webhook',ARRAY['codex'],false,'synthetic-test-secret')`;
    for (const [index, status] of ["pending", "sending", "failed", "sent"].entries()) {
      const notification = randomUUID();
      await db`INSERT INTO monitor_webhook_notifications(id,monitor_id,event_id,revision,payload) VALUES(${notification},${codex.monitorId},'legacy-date',${index + 1},'{"schemaVersion":2,"time":"old display payload"}')`;
      await db`INSERT INTO monitor_webhook_deliveries(id,subscription_id,notification_id,generation,status) VALUES(${randomUUID()},${subscription},${notification},1,${status})`;
    }
    const snapshot = async () => ({ actions: [...await db!`SELECT * FROM monitor_event_actions ORDER BY id`], events: [...await db!`SELECT * FROM monitor_event_records ORDER BY id`],
      states: [...await db!`SELECT * FROM monitor_state ORDER BY monitor_id,key`], deliveries: [...await db!`SELECT * FROM monitor_webhook_deliveries ORDER BY id`], notifications: [...await db!`SELECT * FROM monitor_webhook_notifications ORDER BY id`] });
    await assert.rejects(runMigrations(db, root), /preflight failed.*not been converted/s);
    assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name='0147_monitor_actions_business_time_check.sql'`).length, 0, "unconverted data stops the whole cleanup batch");
    const previewBefore = await snapshot();
    await cli("--output", output("preview"));
    assert.deepEqual(await snapshot(), previewBefore, "preview never changes database rows or metadata");
    for (const phase of ["before", "after"] as const) {
      const saved = JSON.parse(readFileSync(path.join(output("preview"), `${codex.monitorId}-${phase}.json`), "utf8")) as {
        input: Omit<LegacyInput | StructuredUpgradeInput, keyof UpgradeSetSnapshot> & UpgradeSetSnapshot;
      };
      for (const key of Object.keys(expectedSets) as Array<keyof UpgradeSetSnapshot>) assert.deepEqual(saved.input[key], expectedSets[key], `${phase} snapshot retains ${key} as an array`);
      assert.deepEqual(serializeUpgradeSets({ ...saved.input, ...restoreUpgradeSets(saved.input) }), expectedSets);
    }
    // A conflicting partial conversion is rejected before any writes. A correct first batch
    // represents an interrupted run and must be safe to resume without modifying scalar facts.
    await db`UPDATE monitor_event_actions SET business_time='{"kind":"date","date":"2000-01-01","timeZone":"UTC"}' WHERE id='legacy-date'`;
    const conflicting = await snapshot();
    await assert.rejects(cli("--output", output("conflicting-preview")), /conflicting partial conversion/);
    assert.deepEqual(await snapshot(), conflicting);
    await db`UPDATE monitor_event_actions SET business_time=${db.json(after.actions.find(action => action.id === "legacy-date")!.time!)} WHERE id='legacy-date'`;
    const backup = output("scalar.dump");
    execFileSync(dumpCommand, ["--format=custom", "--no-owner", "--no-privileges", "--file", backup, "--dbname", urlOf(databaseName)], { env, stdio: "pipe" });
    execFileSync(restoreCommand, ["--exit-on-error", "--no-owner", "--no-privileges", "--dbname", urlOf(restoreName), backup], { env, stdio: "pipe" });
    restored = postgres(urlOf(restoreName), { max: 1, onnotice: () => {} });
    assert.equal((await restored`SELECT count(*)::int AS count FROM monitor_event_actions`)[0].count, 3);
    assert.deepEqual(serializeUpgradeSets(await restored.begin(tx => loadScalarUpgradeInput(tx, codex.monitorId))), expectedSets, "restored database retains marker sets");
    assert.equal((await restored`SELECT atttypid::regtype::text AS type FROM pg_attribute WHERE attrelid='monitor_event_actions'::regclass AND attname='time'`)[0].type, "text", "backup restores the old schema and records");
    const invalidBackup = output("invalid.dump"), beforeInvalid = await snapshot();
    writeFileSync(invalidBackup, "This is not a PostgreSQL archive");
    await assert.rejects(cli("--output", output("invalid-backup"), "--apply", "--worker-stopped", "--database-backup", invalidBackup), /custom-format dump/);
    assert.deepEqual(await snapshot(), beforeInvalid, "invalid backups are rejected before target writes");
    const apply = (name: string) => cli("--output", output(name), "--apply", "--worker-stopped", "--database-backup", backup, "--batch-size", "1");
    await apply("apply");
    const firstApply = await snapshot();
    await apply("repeat");
    const repeated = await snapshot();
    assert.deepEqual(repeated.actions, firstApply.actions, "repeat apply preserves action timestamps and converted facts");
    assert.deepEqual(repeated.events, firstApply.events);
    assert.deepEqual(repeated.notifications, firstApply.notifications, "no historical notification is created");
    assert.equal(repeated.deliveries.filter(row => row.status === "sent").length, 1);
    assert.equal(repeated.deliveries.filter(row => row.status === "cancelled").length, 3);
    const overview = (await db`SELECT value FROM monitor_state WHERE monitor_id=${codex.monitorId} AND key='public_v2:overview:legacy-date'`)[0].value;
    assert.equal(overview.status, "ready");
    assert.equal(overview.version, upgradeEditorialVersion(after.events.find(event => event.id === "legacy-date")!, after));
    assert.equal((await db`SELECT value->>'version' AS version FROM monitor_state WHERE monitor_id=${codex.monitorId} AND key='public_v2:overview:inferred-manual'`)[0].version, "stale", "stale overview remains invalid");
    assert.equal((await db`SELECT value->>'version' AS version FROM monitor_state WHERE monitor_id=${codex.monitorId} AND key='public_v2:translation:action:legacy-date'`)[0].version, upgradeHash(after.actions.find(action => action.id === "legacy-date")));
    assert.equal((await db`SELECT value->>'revision' AS revision FROM monitor_state WHERE monitor_id=${codex.monitorId} AND key='webhook:event:legacy-date'`)[0].revision, "7");
    assert.equal((await db`SELECT value->>'complete' AS complete FROM monitor_state WHERE monitor_id=${codex.monitorId} AND key=${timeUpgradeKey}`)[0].complete, "true");
    await runMigrations(db, root);
    // New application processes use fresh connections after the type switch; a cached scalar
    // SELECT cannot be reused with a JSONB result column on the same PostgreSQL connection.
    await db.end();
    db = postgres(urlOf(databaseName), { max: 1, onnotice: () => {} });
    assert.deepEqual([...await db`SELECT attname,atttypid::regtype::text AS type FROM pg_attribute WHERE attrelid='monitor_event_actions'::regclass AND attnum>0 AND NOT attisdropped AND attname IN ('time','business_time')`], [{ attname: "time", type: "jsonb" }]);
    const final = await db.begin(tx => loadLegacyTimeInput(tx, codex.monitorId));
    assert.deepEqual(serializeUpgradeSets(final), expectedSets, "conversion and cleanup preserve every marker set");
    assert.ok((await db`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM monitor_event_actions`).every(row => row.at === "2026-10-31T00:00:00.123456Z"), "PostgreSQL microsecond timestamps remain unchanged");
    assert.deepEqual(final.actions.map(action => [action.id, action.time]), after.actions.map(action => [action.id, action.time]));
    await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${codex.monitorId},${legacyScopeBaselineKey},'{"initialized":true}'::jsonb)`;
    const cutover = await db.begin("read only", tx => inventoryScopeCutover(tx, [codex], Date.parse("2026-11-04T00:00:00Z")));
    assert.deepEqual(cutover.unpublishedEvents, [], "the subsequent scope/time tool recognizes baselines written by the historical CLI");
    assert.deepEqual(cutover.times.map(row => row.actionId), ["legacy-date", "legacy-range"]);
    assert.equal((await db`SELECT count(*)::int AS count FROM monitor_webhook_notifications`)[0].count, 4);
    await assert.rejects(db`UPDATE monitor_event_actions SET time='"old scalar"' WHERE id='legacy-date'`, /monitor_actions_business_time_check/);
    await assert.rejects(db`UPDATE monitor_event_actions SET time=NULL WHERE id='inferred-manual'`, /monitor_actions_structured_sources_check/);
    assert.equal(await runMigrations(db, root), 0);
  } finally {
    await restored?.end(); await db?.end();
    for (const name of [restoreName, databaseName]) {
      assert.match(name, /^business_time_(upgrade|restore)_[a-f0-9]+_test$/);
      await admin`DROP DATABASE IF EXISTS ${admin(name)} WITH (FORCE)`;
    }
    await admin.end(); await closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});
