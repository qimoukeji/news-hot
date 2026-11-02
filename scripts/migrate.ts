// Applies engine and module SQL by file name. New online DDL is bounded; concurrent indexes and
// constraint validation run separately so earlier DDL cannot hold a strong lock during a table scan.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import type { ModuleMigrationCheck, ServerModule } from "@aihot/backend/modules";
import { FIRST_ONLINE_MIGRATION, migrationPlan, type MigrationPlan } from "./migration-safety.ts";

/** Read only the site's installed modules; an uninstalled module is never imported for its migrations. */
export async function migrationChecks(root: string, files: ReadonlyMap<string, MigrationPlan>, supplied?: readonly ModuleMigrationCheck[]) {
  const site = path.join(root, "site/modules/server.ts");
  const checks: readonly ModuleMigrationCheck[] = supplied ?? (existsSync(site)
    ? ((await import(pathToFileURL(site).href)).SERVER_MODULES as readonly ServerModule[]).flatMap(module => module.migrationChecks ?? [])
    : []);
  const byName = new Map<string, ModuleMigrationCheck>();
  for (const check of checks) {
    if (byName.has(check.migration)) throw new Error(`duplicate migration check: ${check.migration}`);
    const plan = files.get(check.migration);
    if (!plan) throw new Error(`migration check references unknown file: ${check.migration}`);
    if (plan.kind !== "drop-column" && plan.kind !== "drop-table") throw new Error(`migration check requires a guarded drop-column or drop-table: ${check.migration}`);
    byName.set(check.migration, check);
  }
  return byName;
}

export async function runMigrations(sql: postgres.Sql, root: string, options: { through?: string; checks?: readonly ModuleMigrationCheck[] } = {}): Promise<number> {
  const sqlFiles = (dir: string) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")).map((name) => ({ name, file: path.join(dir, name) })) : [];
  const modules = path.join(root, "modules");
  const migrations = [
    ...sqlFiles(path.join(root, "database/migrations")),
    ...(existsSync(modules) ? readdirSync(modules).flatMap((name) => sqlFiles(path.join(modules, name, "migrations"))) : []),
  ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const [i, migration] of migrations.entries()) {
    if (migrations[i + 1]?.name === migration.name) throw new Error(`two migrations are named ${migration.name}: ${migration.file} and ${migrations[i + 1].file}`);
  }
  // Validate the complete set before making any change; old files remain installable as history.
  const allPrepared = migrations.map((migration) => {
    const text = readFileSync(migration.file, "utf8");
    let plan: MigrationPlan = { kind: "transaction" };
    try { if (Number(migration.name.slice(0, 4)) >= FIRST_ONLINE_MIGRATION) plan = migrationPlan(text); }
    catch (error) { throw new Error(`${migration.name}: ${(error as Error).message}`, { cause: error }); }
    return { ...migration, text, plan };
  });
  if (options.through && !allPrepared.some(migration => migration.name === options.through)) throw new Error(`unknown migration cutoff: ${options.through}`);
  const prepared = allPrepared.filter(migration => !options.through || migration.name <= options.through);
  const checks = await migrationChecks(root, new Map(allPrepared.map(migration => [migration.name, migration.plan])), options.checks);
  const session = await sql.reserve();
  try {
    await session`SET lock_timeout = '1s'`;
    await session`SET statement_timeout = '10s'`;
    await session`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied = new Set((await session<{ name: string }[]>`SELECT name FROM schema_migrations`).map((row) => row.name));
    const assertEmpty = async (table: string) => {
      const [relation] = await session`SELECT to_regclass(${table}) AS id`;
      if (!relation.id) return false;
      const [row] = await session.unsafe(`SELECT EXISTS (SELECT 1 FROM ${table} LIMIT 1) AS populated`);
      if (row.populated) throw new Error(`refusing to drop nonempty table ${table}; restore a verified current-schema backup into an empty database or handle existing data separately`);
      return true;
    };
    for (const { name, plan } of prepared) {
      if (!applied.has(name) && plan.kind === "drop-table") {
        try { await assertEmpty(plan.table); }
        catch (error) { throw new Error(`migration ${name} preflight failed: ${(error as Error).message}`, { cause: error }); }
      }
      const check = checks.get(name);
      if (!applied.has(name) && check) {
        try { await check.verify(session); }
        catch (error) { throw new Error(`migration ${name} preflight failed: ${(error as Error).message}`, { cause: error }); }
      }
    }
    let count = 0;
    for (const { name, text, plan } of prepared) {
      if (applied.has(name)) continue;
      const start = Date.now();
      try {
        const metadataOnly = plan.kind === "transaction" || plan.kind === "primary-key" || plan.kind === "drop-table" || plan.kind === "drop-column";
        await session`SELECT set_config('lock_timeout', ${metadataOnly ? "1s" : "30s"}, false)`;
        await session`SELECT set_config('statement_timeout', ${metadataOnly ? "10s" : "30min"}, false)`;
        if (plan.kind === "index") {
          // A concurrent build's internal transactions cannot be wrapped in our transaction. Its
          // retry must not trust IF NOT EXISTS: an interrupted build leaves an invalid index of that name.
          const indexName = plan.index.startsWith('"') ? plan.index.slice(1, -1).replaceAll('""', '"') : plan.index.toLowerCase();
          await session.unsafe(text);
          const [index] = await session<{ indisvalid: boolean; same_table: boolean }[]>`
            SELECT i.indisvalid, i.indrelid = to_regclass(${plan.table}) AS same_table
            FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE c.relname = ${indexName}
              AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = to_regclass(${plan.table}))`;
          if (!index?.indisvalid) throw new Error(`index ${plan.index} is missing or invalid; inspect it and DROP INDEX CONCURRENTLY before retrying`);
          if (!index.same_table) throw new Error(`index ${plan.index} belongs to a different table`);
          await session`INSERT INTO schema_migrations (name) VALUES (${name})`;
        } else {
          await session`BEGIN`;
          try {
            let execute = true;
            const check = checks.get(name);
            if (check && (plan.kind === "drop-column" || plan.kind === "drop-table")) {
              const [relation] = await session`SELECT to_regclass(${plan.table}) AS id`;
              if (relation.id) await session.unsafe(`LOCK TABLE ${plan.table} IN ACCESS EXCLUSIVE MODE`);
              await check.verify(session);
            }
            if (plan.kind === "drop-table") {
              const [relation] = await session`SELECT to_regclass(${plan.table}) AS id`;
              execute = Boolean(relation.id);
              if (relation.id) {
                await session.unsafe(`LOCK TABLE ${plan.table} IN ACCESS EXCLUSIVE MODE`);
                await assertEmpty(plan.table);
              }
            }
            if (plan.kind === "primary-key") {
              // Hold the same lock as ALTER TABLE before inspecting the catalog: no concurrent DDL
              // may drop NOT NULL or replace the index between this check and its attachment.
              await session.unsafe(`LOCK TABLE ${plan.table} IN ACCESS EXCLUSIVE MODE`);
              const indexName = plan.index.startsWith('"') ? plan.index.slice(1, -1).replaceAll('""', '"') : plan.index.toLowerCase();
              const [index] = await session<{ ready: boolean; same_table: boolean; suitable: boolean; columns_not_null: boolean }[]>`
                SELECT i.indisvalid AND i.indisready AND i.indislive AS ready,
                  i.indrelid = to_regclass(${plan.table}) AS same_table,
                  i.indisunique AND i.indimmediate AND NOT i.indisprimary
                    AND i.indpred IS NULL AND i.indexprs IS NULL
                    AND i.indnkeyatts = i.indnatts AND am.amname = 'btree'
                    AND t.relkind = 'r'
                    AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid AND con.contype IN ('p', 'u', 'x'))
                    AND NOT EXISTS (SELECT 1 FROM unnest(i.indoption::smallint[]) option WHERE option <> 0)
                    AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) op
                      JOIN pg_opclass opc ON opc.oid = op WHERE NOT opc.opcdefault)
                    AND NOT EXISTS (SELECT 1 FROM unnest(i.indkey::smallint[], i.indcollation::oid[]) AS k(attnum, source_collation)
                      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                      WHERE k.source_collation <> a.attcollation) AS suitable,
                  NOT EXISTS (SELECT 1 FROM unnest(i.indkey::smallint[]) k
                    LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k
                    WHERE k <= 0 OR a.attnum IS NULL OR a.attisdropped OR NOT a.attnotnull) AS columns_not_null
                FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  JOIN pg_class t ON t.oid = i.indrelid JOIN pg_am am ON am.oid = c.relam
                WHERE c.relname = ${indexName}
                  AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = to_regclass(${plan.table}))`;
              if (!index?.ready) throw new Error(`primary key index ${plan.index} is missing or invalid`);
              if (!index.same_table) throw new Error(`primary key index ${plan.index} belongs to a different table`);
              if (!index.suitable) throw new Error(`primary key index ${plan.index} must be an unattached unique btree index with plain columns and default ordering`);
              if (!index.columns_not_null) throw new Error(`primary key index ${plan.index} has nullable columns; refusing an implicit NOT NULL table scan`);
            }
            if (execute) await session.unsafe(text);
            await session`INSERT INTO schema_migrations (name) VALUES (${name})`;
            await session`COMMIT`;
          } catch (error) {
            await session`ROLLBACK`;
            throw error;
          }
        }
      } catch (error) {
        throw new Error(`migration ${name} failed after ${Date.now() - start}ms: ${(error as Error).message}`, { cause: error });
      }
      console.log(`applied ${name} (${Date.now() - start}ms, ${plan.kind})`);
      count++;
    }
    console.log(count === 0 ? "database is up to date" : `${count} migration(s) applied`);
    return count;
  } finally {
    try { await session`RESET lock_timeout`; await session`RESET statement_timeout`; }
    finally { session.release(); }
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { through: { type: "string" } } });
  const { REPO_ROOT } = await import("@aihot/backend/config");
  const { closeDb, sql } = await import("@aihot/backend/db");
  try { await runMigrations(sql, REPO_ROOT, { through: values.through }); }
  finally { await closeDb(); }
}
