import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { migrationChecks } from "../scripts/migrate.ts";
import type { MigrationPlan } from "../scripts/migration-safety.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const files = new Map<string, MigrationPlan>([["9080_guarded_drop.sql", { kind: "drop-column", table: "example", column: "obsolete" }]]);
function fixture(source?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "migration-module-checks-"));
  roots.push(root);
  if (source !== undefined) {
    mkdirSync(path.join(root, "site/modules"), { recursive: true });
    writeFileSync(path.join(root, "site/modules/server.ts"), source);
  }
  return root;
}

test("migration checks load only the installed site list, never an uninstalled module", async () => {
  const root = fixture("export const SERVER_MODULES = [];");
  mkdirSync(path.join(root, "modules/uninstalled"), { recursive: true });
  writeFileSync(path.join(root, "modules/uninstalled/server.ts"), "throw new Error('Uninstalled module was loaded');");
  assert.equal((await migrationChecks(root, files)).size, 0);
  assert.equal((await migrationChecks(fixture(), files)).size, 0);
});

test("site migration checks bind to complete filenames without depending on business table names", async () => {
  const root = fixture(`export const SERVER_MODULES = [{ name: 'example', migrationChecks: [{
    migration: '9080_guarded_drop.sql', verify: async () => {}
  }] }];`);
  const checks = await migrationChecks(root, files);
  assert.deepEqual([...checks.keys()], ["9080_guarded_drop.sql"]);
  assert.equal(typeof checks.get("9080_guarded_drop.sql")?.verify, "function");
});

test("duplicate, unknown and unguardable module migration checks fail during planning", async () => {
  const root = fixture();
  const check = { migration: "9080_guarded_drop.sql", verify: async () => {} };
  await assert.rejects(migrationChecks(root, files, [check, check]), /duplicate migration check/);
  await assert.rejects(migrationChecks(root, files, [{ ...check, migration: "9081_missing.sql" }]), /unknown file/);
  await assert.rejects(migrationChecks(root, new Map([[check.migration, { kind: "transaction" }]]), [check]), /guarded drop-column or drop-table/);
});
