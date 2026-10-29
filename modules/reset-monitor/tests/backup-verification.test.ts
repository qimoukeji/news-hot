import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { verifyActionBackup } from "../backend/backup.ts";
import { sha256 } from "@aihot/backend/lib/ids";

after(closeDb);
const dump = (file: string, extra: string[] = []) => execFileSync("pg_dump", ["--format=custom", "--file", file, ...extra, process.env.DATABASE_URL!],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
async function verifierDatabases() {
  const [current] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  return sql`SELECT datname FROM pg_database WHERE datname LIKE ${`backup_verify_${sha256(current!.name).slice(0, 12)}_%`} ORDER BY datname`;
}

test("backup verification rejects data-only and schema-only archives before maintenance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "monitor-backup-check-"));
  const before = [...await verifierDatabases()];
  try {
    for (const [option, missing] of [["--data-only", /missing TABLE:/], ["--schema-only", /missing TABLE DATA:/]] as const) {
      const file = path.join(dir, `${option.slice(2)}.dump`);
      dump(file, [option]);
      await assert.rejects(verifyActionBackup(file), missing);
    }
    assert.deepEqual([...await verifierDatabases()], before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a complete archive must restore its schema dependencies and temporary databases are always removed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "monitor-backup-restore-"));
  const file = path.join(dir, "complete.dump"), before = [...await verifierDatabases()];
  try {
    await sql`CREATE SCHEMA backup_restore_rule`;
    await sql`CREATE FUNCTION backup_restore_rule.allowed(integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'`;
    await sql`CREATE TABLE backup_restore_check (id integer CHECK (backup_restore_rule.allowed(id)))`;
    await sql`INSERT INTO backup_restore_check VALUES (-1)`;
    dump(file, ["--exclude-schema=backup_restore_rule"]);
    await assert.rejects(verifyActionBackup(file), /Backup verification failed/);
    assert.deepEqual([...await verifierDatabases()], before);
    assert.deepEqual([...await sql`SELECT id FROM backup_restore_check`], [{ id: -1 }]);
    dump(file);
    await verifyActionBackup(file);
    assert.deepEqual([...await verifierDatabases()], before);
  } finally {
    await sql`DROP TABLE IF EXISTS backup_restore_check`;
    await sql`DROP FUNCTION IF EXISTS backup_restore_rule.allowed(integer)`;
    await sql`DROP SCHEMA IF EXISTS backup_restore_rule`;
    await rm(dir, { recursive: true, force: true });
  }
});
