// Exercise migration failures against PostgreSQL: bounded locks, atomic bookkeeping, and invalid indexes.
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import postgres from "postgres";
import { runMigrations } from "../scripts/migrate.ts";

const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const other = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const roots: string[] = [];
after(async () => { await db.end(); await other.end(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "migrations-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

test("fresh installations contain current monitor tables without retired tables", async () => {
  for (const name of ["monitor_event_posts", "monitor_posts", "monitor_events"]) {
    assert.equal((await db`SELECT to_regclass(${name}) AS name`)[0].name, null, name);
  }
  for (const name of ["monitor_source_posts", "monitor_event_records", "monitor_event_actions"]) {
    assert.equal((await db`SELECT to_regclass(${name})::text AS name`)[0].name, name);
  }
});

test("retired table cleanup preserves current records and audit and resumes idempotently", async () => {
  await db`CREATE TABLE monitor_posts (id text PRIMARY KEY)`;
  await db`CREATE TABLE monitor_events (id text PRIMARY KEY)`;
  await db`CREATE TABLE monitor_event_posts (post_id text REFERENCES monitor_posts(id), event_id text REFERENCES monitor_events(id))`;
  const id = "migration-cleanup-sentinel";
  await db`INSERT INTO monitor_event_records (monitor_id,id,type,title,created_at)
    VALUES ('codex',${id},'direct_reset','{"zh":"保留事件"}', '2026-10-29T00:00:00Z')`;
  await db`INSERT INTO monitor_source_posts (monitor_id,id,author,published_at,url,title,processing_status)
    VALUES ('codex',${id},'example','2026-10-29T00:00:00Z','https://example.test/post','{"zh":"保留帖子"}','processed')`;
  await db`INSERT INTO monitor_event_actions (monitor_id,id,event_id,sequence,action,title,sources)
    VALUES ('codex',${id},${id},1,'confirm','{"zh":"保留动作"}',${db.json([{ postId: id }])})`;
  await db`INSERT INTO audit_log (actor,action,subject,reason) VALUES ('test','cleanup-check',${id},'保留审计')`;
  const snapshot = async () => ({
    events: [...await db`SELECT * FROM monitor_event_records WHERE id = ${id}`],
    posts: [...await db`SELECT * FROM monitor_source_posts WHERE id = ${id}`],
    actions: [...await db`SELECT * FROM monitor_event_actions WHERE id = ${id}`],
    audit: [...await db`SELECT * FROM audit_log WHERE subject = ${id}`],
  });
  const before = await snapshot();
  const files = [
    "0143_monitor_drop_legacy_event_posts.sql",
    "0144_monitor_drop_legacy_posts.sql",
    "0145_monitor_drop_legacy_events.sql",
  ];
  const root = fixture(Object.fromEntries(files.map((file, index) => [
    `modules/example/migrations/999${index}_cleanup.sql`,
    readFileSync(new URL(`../modules/reset-monitor/migrations/${file}`, import.meta.url), "utf8"),
  ])));
  assert.equal(await runMigrations(db, root), 3);
  assert.equal(await runMigrations(db, root), 0);
  for (const name of ["monitor_event_posts", "monitor_posts", "monitor_events"]) {
    assert.equal((await db`SELECT to_regclass(${name}) AS name`)[0].name, null);
  }
  assert.deepEqual(await snapshot(), before);
});

test("unsafe later files and duplicate module names fail before any change", async () => {
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9000_first.sql": "CREATE TABLE migration_never_created (id int);",
    "modules/example/migrations/9001_unsafe.sql": "UPDATE articles SET title = 'bad';",
  })), /9001_unsafe/);
  assert.equal((await db`SELECT to_regclass('migration_never_created') AS name`)[0].name, null);
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9000_duplicate.sql": "CREATE TABLE migration_never_created (id int);",
    "modules/example/migrations/9000_duplicate.sql": "CREATE TABLE another_never_created (id int);",
  })), /two migrations/);
});

test("a populated drop target stops the entire pending batch without deleting data", async () => {
  await db`CREATE TABLE migration_retired_data (id int)`;
  await db`INSERT INTO migration_retired_data VALUES (1)`;
  const root = fixture({
    "database/migrations/9050_before_drop.sql": "CREATE TABLE migration_before_drop (id int);",
    "database/migrations/9051_drop_data.sql": "DROP TABLE IF EXISTS public.migration_retired_data;",
  });
  await assert.rejects(runMigrations(db, root), /9051_drop_data.*nonempty table/s);
  assert.deepEqual([...await db`SELECT id FROM migration_retired_data`], [{ id: 1 }]);
  assert.equal((await db`SELECT to_regclass('migration_before_drop') AS name`)[0].name, null);
  assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name IN ('9050_before_drop.sql','9051_drop_data.sql')`).length, 0);
  await db`DELETE FROM migration_retired_data`;
  assert.equal(await runMigrations(db, root), 2);
  assert.equal(await runMigrations(db, root), 0);
});

test("a row inserted after drop preflight is protected by the execution-time check", async () => {
  await db`CREATE TABLE migration_drop_gate (id int)`;
  await db`CREATE TABLE migration_drop_race (id int)`;
  const root = fixture({
    "database/migrations/9052_drop_gate.sql": "ALTER TABLE migration_drop_gate ADD COLUMN flag text;",
    "database/migrations/9053_drop_race.sql": "DROP TABLE IF EXISTS migration_drop_race;",
  });
  let running!: Promise<number>;
  await other.begin(async tx => {
    await tx`LOCK TABLE migration_drop_gate IN ACCESS SHARE MODE`;
    running = runMigrations(db, root);
    // Observe the runner waiting on the earlier DDL, after its drop preflight has completed.
    for (let attempt = 0; ; attempt++) {
      await tx`SELECT pg_stat_clear_snapshot()`;
      const [waiting] = await tx`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'ALTER TABLE migration_drop_gate%'`;
      if (waiting) break;
      if (attempt > 100) throw new Error("Migration did not reach the gate");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await tx`INSERT INTO migration_drop_race VALUES (2)`;
  });
  await assert.rejects(running, /9053_drop_race.*nonempty table/s);
  assert.deepEqual([...await db`SELECT id FROM migration_drop_race`], [{ id: 2 }]);
  assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name='9053_drop_race.sql'`).length, 0);
});

test("drop protection keeps whitespace inside quoted table names", async () => {
  await db`CREATE TABLE "migration . retired" (id int)`;
  await db`CREATE TABLE "migration.retired" (id int)`;
  await db`INSERT INTO "migration . retired" VALUES (3)`;
  const root = fixture({ "database/migrations/9054_quoted_drop.sql": 'DROP TABLE IF EXISTS public . "migration . retired";' });
  await assert.rejects(runMigrations(db, root), /nonempty table/);
  assert.deepEqual([...await db`SELECT id FROM "migration . retired"`], [{ id: 3 }]);
  assert.equal((await db`SELECT to_regclass('public."migration.retired"') AS name`)[0].name, '"migration.retired"');
});

test("an interrupted historical multi-statement transaction never commits its schema or ledger entry", async () => {
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/0051_atomic.sql": "CREATE TABLE migration_rolled_back (id int); ALTER TABLE migration_missing ADD COLUMN flag text;",
  })), /0051_atomic/);
  assert.equal((await db`SELECT to_regclass('migration_rolled_back') AS name`)[0].name, null);
  assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name = '0051_atomic.sql'`).length, 0);
});

test("a busy table aborts the migration promptly and leaves the serving schema alone", async () => {
  await db`CREATE TABLE migration_locked (id int)`;
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const blocker = other.begin(async (tx) => {
    await tx`LOCK TABLE migration_locked IN ACCESS SHARE MODE`;
    acquired();
    await hold;
  });
  await ready;
  const start = Date.now();
  try {
    await assert.rejects(runMigrations(db, fixture({
      "database/migrations/9003_lock.sql": "ALTER TABLE migration_locked ADD COLUMN flag text;",
    })), /9003_lock.*lock timeout/s);
    assert.ok(Date.now() - start < 4000, "DDL must not queue behind a long read for the HTTP timeout");
  } finally { release(); await blocker; }
  assert.equal((await db`SELECT 1 FROM information_schema.columns WHERE table_name = 'migration_locked' AND column_name = 'flag'`).length, 0);
  assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name = '9003_lock.sql'`).length, 0);
});

test("concurrent module indexes apply and resume safely when only bookkeeping was interrupted", async () => {
  await db`CREATE TABLE migration_indexed (id int)`;
  await db`INSERT INTO migration_indexed VALUES (1), (2)`;
  await db`CREATE INDEX CONCURRENTLY migration_idx ON migration_indexed (id)`;
  const root = fixture({
    "modules/example/migrations/9004_index.sql": "CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_idx ON migration_indexed (id);",
    "database/migrations/9005_column.sql": "ALTER TABLE migration_indexed ADD COLUMN flag boolean NOT NULL DEFAULT false;",
  });
  assert.equal(await runMigrations(db, root), 2);
  assert.equal(await runMigrations(db, root), 0);
  assert.equal((await db`SELECT indisvalid FROM pg_index WHERE indexrelid = 'migration_idx'::regclass`)[0].indisvalid, true);
  assert.equal((await db`SELECT flag FROM migration_indexed LIMIT 1`)[0].flag, false);
});

test("IF NOT EXISTS must not turn an invalid or wrong-table index into a successful migration", async () => {
  await db`CREATE TABLE migration_invalid (id int)`;
  await db`INSERT INTO migration_invalid VALUES (1), (1)`;
  await assert.rejects(db`CREATE UNIQUE INDEX CONCURRENTLY migration_invalid_idx ON migration_invalid (id)`);
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9006_invalid.sql": "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS migration_invalid_idx ON migration_invalid (id);",
  })), /invalid.*DROP INDEX CONCURRENTLY/s);
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9007_wrong_table.sql": "CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_idx ON migration_invalid (id);",
  })), /different table/);
  assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name IN ('9006_invalid.sql', '9007_wrong_table.sql')`).length, 0);
});

test("primary keys attach prebuilt indexes atomically without changing columns", async () => {
  await db`CREATE TABLE migration_attach (monitor_id text NOT NULL, id text NOT NULL)`;
  await db`INSERT INTO migration_attach VALUES ('codex', 'same'), ('claude', 'same')`;
  await db`CREATE UNIQUE INDEX CONCURRENTLY migration_attach_idx ON migration_attach (monitor_id, id)`;
  const root = fixture({
    "database/migrations/9010_primary_key.sql": "ALTER TABLE migration_attach ADD CONSTRAINT migration_attach_pkey PRIMARY KEY USING INDEX migration_attach_idx;",
  });
  assert.equal(await runMigrations(db, root), 1);
  assert.equal(await runMigrations(db, root), 0);
  const [key] = await db`SELECT conindid::regclass::text AS name FROM pg_constraint WHERE conrelid = 'migration_attach'::regclass AND contype = 'p'`;
  assert.equal(key.name, "migration_attach_pkey");
  await assert.rejects(db`INSERT INTO migration_attach VALUES ('codex', 'same')`, /duplicate key/);
});

test("primary key attachment refuses nullable, unsuitable and wrong-table indexes before DDL", async () => {
  const cases = [
    { name: "nullable", columns: "id text", index: "CREATE UNIQUE INDEX migration_nullable_idx ON migration_nullable (id)", error: /nullable columns/ },
    { name: "nonunique", columns: "id text NOT NULL", index: "CREATE INDEX migration_nonunique_idx ON migration_nonunique (id)", error: /unattached unique btree/ },
    { name: "partial", columns: "id text NOT NULL", index: "CREATE UNIQUE INDEX migration_partial_idx ON migration_partial (id) WHERE id <> ''", error: /unattached unique btree/ },
    { name: "expression", columns: "id text NOT NULL", index: "CREATE UNIQUE INDEX migration_expression_idx ON migration_expression (lower(id))", error: /unattached unique btree/ },
    { name: "descending", columns: "id text NOT NULL", index: "CREATE UNIQUE INDEX migration_descending_idx ON migration_descending (id DESC)", error: /unattached unique btree/ },
    { name: "included", columns: "id text NOT NULL, body text NOT NULL", index: "CREATE UNIQUE INDEX migration_included_idx ON migration_included (id) INCLUDE (body)", error: /unattached unique btree/ },
    { name: "opclass", columns: "id text NOT NULL", index: "CREATE UNIQUE INDEX migration_opclass_idx ON migration_opclass (id text_pattern_ops)", error: /unattached unique btree/ },
  ];
  for (const [number, candidate] of cases.entries()) {
    await db.unsafe(`CREATE TABLE migration_${candidate.name} (${candidate.columns})`);
    await db.unsafe(candidate.index);
    const file = `902${number}_refuse_${candidate.name}.sql`;
    await assert.rejects(runMigrations(db, fixture({
      [`database/migrations/${file}`]: `ALTER TABLE migration_${candidate.name} ADD CONSTRAINT migration_${candidate.name}_pkey PRIMARY KEY USING INDEX migration_${candidate.name}_idx;`,
    })), candidate.error);
    assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name = ${file}`).length, 0);
    assert.equal((await db`SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(${`migration_${candidate.name}`}) AND contype = 'p'`).length, 0);
  }
  assert.equal((await db`SELECT attnotnull FROM pg_attribute WHERE attrelid = 'migration_nullable'::regclass AND attname = 'id'`)[0].attnotnull, false);
  await db`CREATE TABLE migration_wrong_owner (id text NOT NULL)`;
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9028_wrong_owner.sql": "ALTER TABLE migration_wrong_owner ADD CONSTRAINT migration_wrong_owner_pkey PRIMARY KEY USING INDEX migration_attach_pkey;",
  })), /different table/);
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9029_missing_index.sql": "ALTER TABLE migration_wrong_owner ADD CONSTRAINT migration_wrong_owner_pkey PRIMARY KEY USING INDEX migration_missing_idx;",
  })), /missing or invalid/);
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9030_invalid_key.sql": "ALTER TABLE migration_invalid ADD CONSTRAINT migration_invalid_pkey PRIMARY KEY USING INDEX migration_invalid_idx;",
  })), /missing or invalid/);
  await assert.rejects(runMigrations(db, fixture({
    "database/migrations/9031_attached_key.sql": "ALTER TABLE migration_attach ADD CONSTRAINT migration_attach_second_pkey PRIMARY KEY USING INDEX migration_attach_pkey;",
  })), /unattached unique btree/);
});

test("primary key preflight holds a bounded table lock before inspecting catalog metadata", async () => {
  await db`CREATE TABLE migration_key_locked (id int NOT NULL)`;
  await db`CREATE UNIQUE INDEX migration_key_locked_idx ON migration_key_locked (id)`;
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const blocker = other.begin(async (tx) => {
    await tx`LOCK TABLE migration_key_locked IN ACCESS SHARE MODE`;
    acquired();
    await hold;
  });
  await ready;
  const start = Date.now();
  try {
    await assert.rejects(runMigrations(db, fixture({
      "database/migrations/9032_key_lock.sql": "ALTER TABLE migration_key_locked ADD CONSTRAINT migration_key_locked_pkey PRIMARY KEY USING INDEX migration_key_locked_idx;",
    })), /9032_key_lock.*lock timeout/s);
    assert.ok(Date.now() - start < 4000);
  } finally { release(); await blocker; }
  assert.equal((await db`SELECT 1 FROM pg_constraint WHERE conrelid = 'migration_key_locked'::regclass AND contype = 'p'`).length, 0);
  assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name = '9032_key_lock.sql'`).length, 0);
});
