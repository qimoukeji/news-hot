// Upgrade a representative Codex database and verify monitor-local keys and foreign keys.
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import postgres from "postgres";
import { runMigrations } from "../scripts/migrate.ts";

const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const root = mkdtempSync(path.join(tmpdir(), "reset-migration-"));
const directory = path.join(root, "modules/reset-monitor/migrations");
mkdirSync(directory, { recursive: true });
after(async () => { await db.end(); rmSync(root, { recursive: true, force: true }); });

// Use separate table names and ledger names so the test can run on a fully migrated template.
function stage(source: string, start: number, limit = Infinity) {
  const files = readdirSync(source).filter((file) => file.endsWith(".sql")).sort().slice(0, limit);
  for (const [offset, file] of files.entries()) {
    writeFileSync(path.join(directory, `${start + offset}_${file.slice(5)}`), readFileSync(path.join(source, file), "utf8").replace(/\bmonitor_(?!id\b)/g, "migration_monitor_"));
  }
  return files.length;
}

async function snapshot() {
  const output: Record<string, unknown> = {};
  for (const table of ["posts", "events", "event_posts", "state"]) {
    output[table] = (await db`SELECT * FROM ${db(`migration_monitor_${table}`)}`).map(({ monitor_id: _monitor, ...row }) => row);
  }
  return output;
}

test("shared monitor migration preserves Codex evidence, manual review and state, and isolates new monitors", async () => {
  const repo = path.resolve(import.meta.dirname, "..");
  stage(path.join(repo, "modules/codex-reset/migrations"), 9100);
  assert.equal(await runMigrations(db, root), 7);
  await db`INSERT INTO migration_monitor_posts (id, author, published_at, text, url, context, raw, translation, recognition, receipt_id, activity, processed_at)
    VALUES ('same-post', 'tibo', '2026-10-01T10:00:00Z', 'Reset today', 'https://x.com/tibo/status/same-post',
      '[{"id":"context"}]', '{"original":true}', '今日重置', '{"events":[{"type":"direct_reset"}]}', 42,
      '{"manual":{"reviewed":true}}', '2026-10-01T11:00:00Z')`;
  await db`INSERT INTO migration_monitor_events (id, type, status, title, schedule, estimate, confirmed_at, occurred_on, confirmation_basis, created_at, updated_at)
    VALUES ('same-event', 'direct_reset', 'confirmed', 'Codex 重置', '{"raw":"today"}', '{"source":"manual"}',
      '2026-10-01T10:00:00Z', '2026-10-01', 'receipt_review', '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z')`;
  await db`INSERT INTO migration_monitor_event_posts (event_id, post_id, stage, action, text, original_text)
    VALUES ('same-event', 'same-post', 'confirmed', 'confirm', '人工复核', 'Reset today')`;
  await db`INSERT INTO migration_monitor_state (key, value) VALUES
    ('checkpoint', '{"lastSuccess":"2026-10-01T10:00:00Z"}'),
    ('manual-audit', '[{"action":"confirm","eventId":"same-event"}]'),
    ('notified', '{"same-event:confirmed":true}')`;
  const before = await snapshot();
  const shared = path.join(repo, "modules/reset-monitor/migrations");
  const first = stage(shared, 9107, 12);
  assert.equal(await runMigrations(db, root), first);
  const foreignIndexes = await db`SELECT conname,conindid::text AS index_oid FROM pg_constraint
    WHERE conname IN ('migration_monitor_event_posts_event_monitor_fkey','migration_monitor_event_posts_post_monitor_fkey') ORDER BY conname`;
  assert.equal(foreignIndexes.length, 2, "validated composite foreign keys must exist before dropping old keys");
  assert.equal((await db`SELECT 1 FROM pg_constraint WHERE conrelid='migration_monitor_event_posts'::regclass AND contype='f'`).length, 4);
  const added = stage(shared, 9107, 24);
  assert.equal(await runMigrations(db, root), added - first);
  assert.deepEqual(await db`SELECT conname,conindid::text AS index_oid FROM pg_constraint
    WHERE conname IN ('migration_monitor_event_posts_event_monitor_fkey','migration_monitor_event_posts_post_monitor_fkey') ORDER BY conname`, foreignIndexes,
    "USING INDEX retains the referenced index OIDs when replacing primary keys");
  assert.deepEqual(await snapshot(), before);
  for (const table of ["posts", "events", "event_posts", "state"]) {
    assert.deepEqual((await db`SELECT DISTINCT monitor_id FROM ${db(`migration_monitor_${table}`)}`).map((row) => row.monitor_id), ["codex"]);
  }
  const keys = await db`SELECT c.relname, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid WHERE c.relname LIKE 'migration_monitor_%' AND con.contype = 'p' ORDER BY c.relname`;
  assert.deepEqual(keys.map((key) => [key.relname, key.definition]), [
    ["migration_monitor_event_posts", "PRIMARY KEY (monitor_id, event_id, post_id)"],
    ["migration_monitor_events", "PRIMARY KEY (monitor_id, id)"],
    ["migration_monitor_posts", "PRIMARY KEY (monitor_id, id)"],
    ["migration_monitor_state", "PRIMARY KEY (monitor_id, key)"],
  ]);
  assert.equal((await db`SELECT 1 FROM pg_constraint WHERE conrelid = 'migration_monitor_event_posts'::regclass AND contype = 'f' AND convalidated`).length, 2);
  await db`INSERT INTO migration_monitor_events (monitor_id, id, type, status, title, created_at, updated_at)
    VALUES ('claude', 'same-event', 'direct_reset', 'announced', 'Claude 重置', now(), now())`;
  await assert.rejects(db`INSERT INTO migration_monitor_event_posts (monitor_id, event_id, post_id, stage, text, original_text)
    VALUES ('claude', 'same-event', 'same-post', 'announced', 'Claude', 'Claude')`, /foreign key/);
  await db`INSERT INTO migration_monitor_posts (monitor_id, id, author, published_at, text, url)
    VALUES ('claude', 'same-post', 'ClaudeDevs', now(), 'Reset', 'https://x.com/ClaudeDevs/status/same-post')`;
  await db`INSERT INTO migration_monitor_event_posts (monitor_id, event_id, post_id, stage, text, original_text)
    VALUES ('claude', 'same-event', 'same-post', 'announced', 'Claude', 'Claude')`;
  await db`INSERT INTO migration_monitor_state (monitor_id, key, value) VALUES ('claude', 'checkpoint', '{"independent":true}')`;
  await db`INSERT INTO migration_monitor_posts (monitor_id, id, author, published_at, text, url)
    VALUES ('other', 'only-other', 'Other', now(), 'Reset', 'https://example.invalid')`;
  await assert.rejects(db`INSERT INTO migration_monitor_event_posts (monitor_id, event_id, post_id, stage, text, original_text)
    VALUES ('other', 'same-event', 'only-other', 'announced', 'Other', 'Other')`, /foreign key/);
  await assert.rejects(db`INSERT INTO migration_monitor_state (monitor_id, key, value) VALUES ('claude', 'checkpoint', '{}')`, /duplicate key/);
  await db`DELETE FROM migration_monitor_events WHERE monitor_id = 'claude' AND id = 'same-event'`;
  assert.equal((await db`SELECT 1 FROM migration_monitor_event_posts WHERE monitor_id = 'claude'`).length, 0);
  assert.equal((await db`SELECT 1 FROM migration_monitor_event_posts WHERE monitor_id = 'codex'`).length, 1);
  assert.equal((await db`SELECT value FROM migration_monitor_state WHERE monitor_id = 'codex' AND key = 'notified'`)[0].value["same-event:confirmed"], true);

  const beforeBonus = await snapshot();
  stage(shared, 9107, 25);
  assert.equal(await runMigrations(db, root), 1);
  const constraints = async () => (await db`SELECT conname, convalidated FROM pg_constraint
    WHERE conrelid = 'migration_monitor_events'::regclass AND conname IN ('migration_monitor_events_type_check', 'migration_monitor_events_event_type_check')
    ORDER BY conname`).map(({ conname, convalidated }) => ({ conname, convalidated }));
  assert.deepEqual(await constraints(), [
    { conname: "migration_monitor_events_event_type_check", convalidated: false },
    { conname: "migration_monitor_events_type_check", convalidated: true },
  ]);
  const insertBonus = () => db`INSERT INTO migration_monitor_events (monitor_id, id, type, status, title, presentation, created_at, updated_at)
    VALUES ('claude', 'bonus-event', 'bonus_credit', 'announced', '一次性奖励额度',
      '{"bonusCredit":{"amount":null,"eligibility":"Pro or Max plan on Sept 23","claimMethod":"/claim-credit","claimDeadline":{"source":"Oct 7 at 11:59pm PT","at":null},"expiresAt":{"source":"Nov 4","at":null}}}', now(), now())`;
  await assert.rejects(insertBonus(), /migration_monitor_events_type_check/);
  stage(shared, 9107, 26);
  assert.equal(await runMigrations(db, root), 1);
  assert.ok((await constraints()).every((constraint) => constraint.convalidated), "new check is validated before old check is removed");
  await assert.rejects(insertBonus(), /migration_monitor_events_type_check/);
  const allSharedMigrations = stage(shared, 9107);
  assert.equal(await runMigrations(db, root), allSharedMigrations - 26);
  assert.deepEqual(await constraints(), [{ conname: "migration_monitor_events_event_type_check", convalidated: true }]);
  assert.deepEqual(await snapshot(), beforeBonus, "type expansion preserves evidence, manual audit, checkpoint and notification state");
  await insertBonus();
  const [bonus] = await db`SELECT presentation FROM migration_monitor_events WHERE monitor_id = 'claude' AND id = 'bonus-event'`;
  assert.equal(bonus.presentation.bonusCredit.claimMethod, "/claim-credit");
  await assert.rejects(db`INSERT INTO migration_monitor_events (monitor_id, id, type, status, title, created_at, updated_at)
    VALUES ('claude', 'invalid-event', 'unknown_credit', 'announced', '非法类型', now(), now())`, /migration_monitor_events_event_type_check/);
  assert.equal(await runMigrations(db, root), 0);
});

test("a fresh full migration accepts all shared event types and keeps rejecting unknown types", async () => {
  const [constraint] = await db`SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'monitor_events'::regclass AND conname = 'monitor_events_event_type_check'`;
  assert.equal(constraint.convalidated, true);
  assert.match(constraint.definition, /bonus_credit/);
  assert.equal((await db`SELECT 1 FROM pg_constraint WHERE conrelid = 'monitor_events'::regclass AND conname = 'monitor_events_type_check'`).length, 0);
  for (const type of ["direct_reset", "reset_credit", "bonus_credit"]) {
    await db`INSERT INTO monitor_events (monitor_id, id, type, status, title, created_at, updated_at)
      VALUES ('migration-fixture', ${type}, ${type}, 'announced', '迁移验证', now(), now())`;
  }
  assert.equal((await db`SELECT 1 FROM monitor_events WHERE monitor_id = 'migration-fixture'`).length, 3);
  await assert.rejects(db`INSERT INTO monitor_events (monitor_id, id, type, status, title, created_at, updated_at)
    VALUES ('migration-fixture', 'invalid', 'unknown_credit', 'announced', '非法类型', now(), now())`, /monitor_events_event_type_check/);
});
