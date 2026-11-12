import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Db } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { fixture } from "./action-fixture.ts";
import { inventoryScopeCutover } from "../scripts/scope-cutover.ts";
import type { LegacyTimeInput } from "../scripts/time-cutover.ts";

/** Read-only synthetic inventory: unrecognized SQL fails before any connection can be used. */
function inventoryDb(input: LegacyTimeInput): Db {
  const db = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    if (query.includes("FROM pg_attribute")) return [{ type: "jsonb" }];
    if (query.startsWith("SELECT id,type,title")) return structuredClone(input.events);
    if (query.startsWith("SELECT id,author,published_at")) return structuredClone(input.posts);
    if (query.startsWith("SELECT id,event_id,sequence")) return structuredClone(input.actions);
    if (query.startsWith("SELECT key,value FROM monitor_state")) return [];
    if (query.startsWith("SELECT key FROM monitor_state")) {
      const prefix = query.includes("'recognition:standalone-followup:'") ? "recognition:standalone-followup:" : values[1];
      const ids = prefix === "recognition:standalone-followup:" ? input.standaloneFollowupIds
        : prefix === "confirmation:invalidated:" ? input.invalidatedInferenceIds
        : prefix === "confirmation:manual:" ? input.manualConfirmationIds : undefined;
      assert.equal(typeof prefix, "string");
      return [...ids ?? []].map(id => ({ key: `${prefix}${id}` }));
    }
    if (query.startsWith("SELECT * FROM monitor_state") || query.startsWith("SELECT * FROM monitor_webhook_")
      || query.startsWith("SELECT d.id,d.status,n.monitor_id,n.event_id,n.revision")
      || query.startsWith("SELECT monitor_id,key FROM monitor_state") || query.startsWith("SELECT platforms,count(*)")
      || query.startsWith("SELECT monitor_id,id FROM monitor_event_records") || query.startsWith("SELECT key,value,updated_at FROM settings")) return [];
    throw new Error(`Unexpected read-only cutover query: ${query}`);
  };
  return db as unknown as Db;
}

const cli = (...args: string[]) => spawnSync(process.execPath, ["modules/reset-monitor/scripts/scope-cutover.ts", ...args],
  { encoding: "utf8", env: { ...process.env, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", WEBHOOK_PUSH_ENABLED: "false",
    SERVERCHAN_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false" }, windowsHide: true });

test("scope/time apply requires stopped writers and a complete backup before connecting to the target", () => {
  const result = cli("--apply", "not-read.json");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Apply requires stopped API\/workers and a complete database backup/);
  assert.equal(result.stdout, "");
});

test("scope/time apply refuses an invalid backup before starting a transaction", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scope-cutover-cli-"));
  try {
    const review = path.join(directory, "review.json"), backup = path.join(directory, "invalid.dump");
    await writeFile(review, JSON.stringify({ fingerprint: "0".repeat(64), times: [], events: [] }));
    await writeFile(backup, "invalid database backup");
    const result = cli("--apply", review, "--worker-stopped", "--database-backup", backup);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Backup is not a PostgreSQL custom-format dump/);
    assert.equal(result.stdout, "");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("silent confirmation inventory covers scope-only and time-only changes without touching unrelated events", async () => {
  const due = Date.parse("2026-10-10T18:00:00Z");
  for (const kind of ["scope-only", "time-only", "unchanged"] as const) {
    const input: LegacyTimeInput = fixture();
    input.actions[0]!.action = "announce";
    input.actions[0]!.time = kind === "time-only" ? null : { kind: "instant", at: "2026-10-10T18:00:00Z" };
    if (kind === "scope-only") Object.assign(input.events[0]!, {
      scope: { type: "unknown", note: null, productCodes: [], planCodes: [], quotaWindowCodes: [] },
    });
    const before = structuredClone(input);
    const inventory = await inventoryScopeCutover(inventoryDb(input), [codex], due);
    assert.equal(inventory.times.length, kind === "time-only" ? 1 : 0, kind);
    assert.equal(inventory.fieldsToRemove, kind === "scope-only" ? 1 : 0, kind);
    assert.equal(inventory.inferredConfirmations.length, kind === "unchanged" ? 0 : 1, kind);
    if (kind !== "unchanged") assert.deepEqual(inventory.inferredConfirmations[0]!.time, { kind: "instant", at: "2026-10-10T18:00:00Z" });
    assert.deepEqual(input, before);
  }
});

test("scope-only inventory becomes stale when a precise announcement falls due during the writer stop", async () => {
  const input = fixture(), due = Date.parse("2026-10-10T18:00:00Z");
  input.actions[0]!.action = "announce";
  input.actions[0]!.time = { kind: "instant", at: "2026-10-10T18:00:00Z" };
  Object.assign(input.events[0]!, { scope: { type: "unknown", note: null, productCodes: [] } });
  const db = inventoryDb(input);
  const before = await inventoryScopeCutover(db, [codex], due - 1);
  const stopped = await inventoryScopeCutover(db, [codex], due + 60_000);
  assert.deepEqual(before.inferredConfirmations, []);
  assert.equal(stopped.inferredConfirmations.length, 1);
  assert.notEqual(before.fingerprint, stopped.fingerprint);
  assert.equal(stopped.fingerprint, (await inventoryScopeCutover(db, [codex], due + 120_000)).fingerprint);
});

test("inventory fingerprints serialize all identity sets with stable ordering", async () => {
  const input = fixture();
  const now = Date.parse("2026-10-10T18:00:00Z");
  for (const field of ["standaloneFollowupIds", "invalidatedInferenceIds", "manualConfirmationIds"] as const) {
    input[field] = new Set(["second", "first"]);
    const before = await inventoryScopeCutover(inventoryDb(input), [codex], now);
    input[field] = new Set(["first", "second"]);
    assert.equal((await inventoryScopeCutover(inventoryDb(input), [codex], now)).fingerprint, before.fingerprint, field);
    input[field] = new Set(["first"]);
    assert.notEqual((await inventoryScopeCutover(inventoryDb(input), [codex], now)).fingerprint, before.fingerprint, field);
  }
});
