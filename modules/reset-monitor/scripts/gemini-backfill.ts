import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { closeDb, createDatabase, sql, type Db, type Sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { BudgetExceededError, withStagedReceiptLedger } from "@aihot/backend/providers/receipts";
import { backendDefinition as gemini } from "../../gemini-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { collectorName, cursorKey } from "../config.ts";
import { lockActionRecords } from "../backend/action-store.ts";
import { verifyActionBackup } from "../backend/backup.ts";
import { collectPosts, CollectionIncompleteError } from "../backend/collection.ts";
import { collectionCoverageKey, CollectionCoverage, reconcileCollectionCoverage } from "../backend/collection-coverage.ts";
import { inMonitor } from "../backend/context.ts";
import { processPublicV2Pending } from "../backend/public-v2-generate.ts";
import { geminiBackfillGate } from "../backend/scan.ts";
import { processPending } from "../backend/thread-processing.ts";
import { establishHistoricalWebhookBaselines } from "../backend/webhook-events.ts";

const scope = "gemini";
const stageKey = "backfill:gemini:stage:v1";
const appliedKey = "backfill:gemini:applied:v1";
const start = Date.parse("2026-08-31T16:00:00Z");
const week = 7 * 86_400_000;
const columns = {
  monitor_source_posts: ["author", "published_at", "url", "text", "quoted_post", "reply_to", "context_only", "filtered_out", "title", "summary",
    "source_receipt_id", "model_receipt_id", "processing_status", "review_reason", "created_at", "updated_at"],
  monitor_event_records: ["type", "title", "summary", "scope", "withdrawn", "created_at", "updated_at"],
  monitor_event_actions: ["event_id", "sequence", "action", "invalidates_event", "title", "summary", "time", "sources", "created_at", "updated_at"],
} as const;
type Table = keyof typeof columns;
const tables = Object.keys(columns) as Table[];
const row = z.looseObject({ id: z.string().min(1), monitor_id: z.literal(scope) });
type Row = z.infer<typeof row>;
const stateRow = z.strictObject({ key: z.string().regex(/^(?:recognition:historical:|public_v2:(?:overview|translation|inference_invalidated):).+/), value: z.json() });
const stageSchema = z.strictObject({
  run: z.uuid(), upper: z.int().min(start + 1), lower: z.int().min(start), baseline: z.string().length(64),
  original: z.record(z.string(), z.record(z.string(), z.string())), ready: z.boolean(), blocked: z.array(z.int().min(start)).default([]),
});
type Stage = z.infer<typeof stageSchema>;
const bundleSchema = z.strictObject({
  version: z.literal(1), run: z.uuid(), upper: z.int().min(start + 1), baseline: z.string().length(64),
  changes: z.strictObject({ monitor_source_posts: z.array(row), monitor_event_records: z.array(row), monitor_event_actions: z.array(row) }),
  state: z.array(stateRow), receipts: z.array(z.strictObject({ id: z.int().positive(), status: z.enum(["completed", "failed", "received"]) })),
});
type Bundle = z.infer<typeof bundleSchema>;

async function snapshot(db: Db) {
  const result = {} as Record<Table, Row[]>;
  for (const table of tables) {
    const rows = await db<{ row: Row }[]>`SELECT to_jsonb(t) AS row FROM ${db(table)} t WHERE monitor_id=${scope} ORDER BY id`;
    result[table] = rows.map(item => item.row);
  }
  return result;
}

async function readState(db: Db, key: string): Promise<unknown> {
  const [record] = await db`SELECT value FROM monitor_state WHERE monitor_id=${scope} AND key=${key}`;
  return record?.value;
}

async function saveState(db: Db, key: string, value: unknown) {
  await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${scope},${key},${db.json(value as never)})
    ON CONFLICT(monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`;
}

async function stageInfo(ledger: Sql): Promise<Stage> {
  const saved = await readState(sql, stageKey);
  if (saved) return stageSchema.parse(saved);
  const local = await snapshot(sql);
  const baseline = sha256(stableJson(local));
  if (sha256(stableJson(await snapshot(ledger))) !== baseline) throw new Error("The staging clone differs from production Gemini records");
  if (local.monitor_source_posts.some(post => !post.context_only && ["pending", "failed"].includes(String(post.processing_status)))) {
    throw new Error("Resolve existing Gemini recognition work before staging");
  }
  const original = Object.fromEntries(tables.map(table => [table, Object.fromEntries(local[table].map(post => [post.id, sha256(stableJson(post))]))]));
  const stage = stageSchema.parse({ run: randomUUID(), upper: Math.floor(Date.now() / 1000) * 1000, lower: start, baseline, original, ready: false });
  await saveState(sql, stageKey, stage);
  return stage;
}

async function collect(ledger: Sql) {
  installModules([createMonitorServer(gemini)]);
  const stage = await stageInfo(ledger);
  if (stage.ready) return stage;
  await withStagedReceiptLedger(ledger, stage.run, async () => {
    const finishWindow = async (lower: number) => {
      const upper = Math.min(lower + week, stage.upper);
      try {
        const result = await collectPosts({ historicalLower: lower, startedAt: new Date(upper),
          roundId: [stage.run, lower, upper].join(":"), resume: true });
        return result.collectionComplete && !result.contextLimitReached ? "done" : "partial";
      } catch (error) {
        if (!(error instanceof CollectionIncompleteError) || !error.detail.searchFailures.some(failure => failure.recovery === "manual")) throw error;
        console.log(error.message);
        return "review";
      }
    };
    for (const lower of [...stage.blocked]) {
      const status = await finishWindow(lower);
      if (status === "partial") return;
      if (status === "done") {
        stage.blocked = stage.blocked.filter(value => value !== lower);
        await saveState(sql, stageKey, stage);
      }
    }
    while (stage.lower < stage.upper) {
      const status = await finishWindow(stage.lower);
      if (status === "partial") return;
      if (status === "review") stage.blocked.push(stage.lower);
      stage.lower = Math.min(stage.lower + week, stage.upper);
      await saveState(sql, stageKey, stage);
    }
    if (stage.blocked.length) return;
    await processPending();
    await processPublicV2Pending();
    const [pending] = await sql`SELECT EXISTS (SELECT 1 FROM monitor_source_posts
      WHERE monitor_id=${scope} AND NOT context_only AND processing_status IN ('pending','failed')) AS present`;
    if (pending?.present) throw new Error("Staging has unresolved recognition failures. Resolve them in staging before exporting.");
    stage.ready = true;
    await saveState(sql, stageKey, stage);
  });
  return stage;
}

async function exportBundle(path: string) {
  const stage = stageSchema.parse(await readState(sql, stageKey));
  if (!stage.ready || stage.lower !== stage.upper) throw new Error("Staging is incomplete");
  const staged = await snapshot(sql);
  const changes = {} as Bundle["changes"];
  for (const table of tables) {
    const ids = new Set(staged[table].map(item => item.id));
    if (Object.keys(stage.original[table] ?? {}).some(id => !ids.has(id))) throw new Error("The staged data removed an existing record");
    changes[table] = staged[table].filter(item => Object.hasOwn(stage.original[table] ?? {}, item.id)
      ? stage.original[table][item.id] !== sha256(stableJson(item)) : true);
  }
  const touched = new Set(tables.flatMap(table => changes[table].map(item => item.id)));
  for (const action of changes.monitor_event_actions) touched.add(String(action.event_id));
  const stagedState = await sql`SELECT key,value FROM monitor_state WHERE monitor_id=${scope} AND
    (starts_with(key,'recognition:historical:') OR starts_with(key,'public_v2:overview:') OR starts_with(key,'public_v2:translation:')) ORDER BY key`;
  const state = stagedState.filter(item => touched.has(item.key.split(":").at(-1)!));
  const receipts = await sql`SELECT id::integer,status FROM receipts WHERE purpose LIKE 'reset_monitor.gemini.%'
    AND strpos(logical_key,${"gemini-history:" + stage.run + ":"})>0 ORDER BY id`;
  const bundle = bundleSchema.parse({ version: 1, run: stage.run, upper: stage.upper, baseline: stage.baseline, changes, state, receipts });
  await writeFile(path, JSON.stringify(bundle), { flag: "wx", mode: 0o600 });
  return bundle;
}

async function assertBaseline(db: Db, bundle: Bundle) {
  if (sha256(stableJson(await snapshot(db))) !== bundle.baseline) throw new Error("Production Gemini records changed after staging");
}

function fingerprint(bundle: Bundle) {
  return sha256(stableJson(bundle));
}

async function apply(bundle: Bundle) {
  const digest = fingerprint(bundle);
  return sql.begin(async tx => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${gemini.names.tick}))`;
    if (await readState(tx, appliedKey) === digest) return;
    if (await readState(tx, geminiBackfillGate) !== digest) throw new Error("The exact bundle must be gated before sync");
    const current = await snapshot(tx);
    await lockActionRecords(tx, current.monitor_event_records.map(item => item.id),
      current.monitor_event_actions.map(item => item.id), current.monitor_source_posts.map(item => item.id));
    await assertBaseline(tx, bundle);
    for (const receipt of bundle.receipts) {
      const result = await tx`SELECT 1 FROM receipts WHERE id=${receipt.id} AND purpose LIKE 'reset_monitor.gemini.%'
        AND strpos(logical_key,${"gemini-history:" + bundle.run + ":"})>0`;
      if (!result.length) throw new Error("A staged receipt is missing from the production ledger");
      if (receipt.status !== "received") await tx`UPDATE receipts SET status=${receipt.status},updated_at=now(),
        completed_at=CASE WHEN ${receipt.status}='completed' THEN coalesce(completed_at,now()) ELSE completed_at END
        WHERE id=${receipt.id} AND status='received'`;
    }
    for (const table of tables) {
      if (!bundle.changes[table].length) continue;
      const update = tx.unsafe(columns[table].map(column => column + "=EXCLUDED." + column).join(", "));
      await tx`INSERT INTO ${tx(table)} SELECT * FROM jsonb_populate_recordset(NULL::${tx(table)},${tx.json(bundle.changes[table] as never)})
        ON CONFLICT(monitor_id,id) DO UPDATE SET ${update}`;
    }
    for (const item of bundle.state) await saveState(tx, item.key, item.value);
    const eventIds = new Set([...bundle.changes.monitor_event_records.map(item => item.id),
      ...bundle.changes.monitor_event_actions.map(item => String(item.event_id))]);
    await establishHistoricalWebhookBaselines(tx, eventIds);
    const upper = new Date(bundle.upper).toISOString();
    const existing = await readState(tx, collectionCoverageKey());
    if (existing && Date.parse(CollectionCoverage.parse(existing).scopeEffectiveAt ?? upper) > bundle.upper) {
      throw new Error("The existing daily coverage would leave a gap");
    }
    if (!existing) {
      if (await readState(tx, cursorKey())) throw new Error("A daily checkpoint exists without a coverage boundary");
      await saveState(tx, collectionCoverageKey(), reconcileCollectionCoverage(null, gemini, upper, upper));
    }
    await saveState(tx, appliedKey, digest);
    await tx`DELETE FROM monitor_state WHERE monitor_id=${scope} AND key=${geminiBackfillGate}`;
  });
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    bundle: { type: "string" }, backup: { type: "string" },
  } });
  const [mode] = positionals;
  const [database] = await sql`SELECT current_database() AS name`;
  if (mode === "collect" || mode === "export") {
    if (!String(database?.name).endsWith("_gemini_stage")) throw new Error("Staging database name must end with _gemini_stage");
    for (const key of ["WEBHOOK_PUSH_ENABLED", "SERVERCHAN_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
      if (process.env[key] === "true") throw new Error("Disable delivery in the staging process");
    }
    if (mode === "export") {
      if (!values.bundle) throw new Error("Provide --bundle");
      const bundle = await exportBundle(values.bundle);
      console.log(JSON.stringify({ digest: fingerprint(bundle), upper: new Date(bundle.upper).toISOString() }));
      return;
    }
    if (process.env.COLLECT_ENABLED !== "true" || process.env.MODEL_CALLS_ENABLED !== "true" || collectorName() !== "twitterapi_io") {
      throw new Error("Enable collection and model calls with TwitterAPI.io in the staging process");
    }
    const ledgerUrl = process.env.GEMINI_BACKFILL_LEDGER_DATABASE_URL;
    if (!ledgerUrl) throw new Error("Provide the shared receipt ledger in GEMINI_BACKFILL_LEDGER_DATABASE_URL");
    const ledger = createDatabase(ledgerUrl);
    try {
      const [remote] = await ledger`SELECT current_database() AS name`;
      if (!remote || remote.name === database?.name) throw new Error("The shared ledger must be separate from staging");
      const connection = await sql.reserve();
      try {
        const [lock] = await connection`SELECT pg_try_advisory_lock(hashtext(${stageKey})) AS acquired`;
        if (!lock?.acquired) throw new Error("Gemini staging is already running");
        try {
          const stage = await collect(ledger);
          console.log(JSON.stringify({ ready: stage.ready, upper: new Date(stage.upper).toISOString(), next: new Date(stage.lower).toISOString(), blocked: stage.blocked.map(at => new Date(at).toISOString()) }));
        } finally { await connection`SELECT pg_advisory_unlock(hashtext(${stageKey}))`; }
      } finally { connection.release(); }
    } finally { await ledger.end({ timeout: 5 }); }
    return;
  }
  if (!["preview", "gate", "apply"].includes(mode) || !values.bundle) throw new Error("Use collect, export, preview, gate or apply with --bundle for bundle operations");
  const bundle = bundleSchema.parse(JSON.parse(await readFile(values.bundle, "utf8")));
  const digest = fingerprint(bundle);
  if (mode === "gate") {
    await sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${gemini.names.tick}))`;
      await assertBaseline(tx, bundle);
      const gate = await readState(tx, geminiBackfillGate);
      if (gate && gate !== digest) throw new Error("Another backfill is already gated");
      await saveState(tx, geminiBackfillGate, digest);
    });
  } else if (mode === "apply") {
    if (!values.backup || collectorName() !== "twitterapi_io") throw new Error("Apply requires --backup and GEMINI_RESET_PROVIDER=twitterapi_io");
    await verifyActionBackup(values.backup, process.env.GEMINI_BACKFILL_VERIFY_DATABASE_URL);
    await apply(bundle);
  } else {
    const previous = await readState(sql, appliedKey);
    if (previous !== digest) await assertBaseline(sql, bundle);
  }
  console.log(JSON.stringify({ mode, digest, upper: new Date(bundle.upper).toISOString(),
    rows: Object.fromEntries(tables.map(table => [table, bundle.changes[table].length])), receipts: bundle.receipts.length }));
}

try {
  await inMonitor(gemini, main);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Gemini backfill failed");
  process.exitCode = error instanceof BudgetExceededError ? 75 : 1;
} finally {
  await closeDb();
}
