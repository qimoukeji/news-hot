const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const postgres = require('postgres');
const { audit } = require('../audit.cjs');

const sourceUrl = process.env.TEST_DATABASE_URL;
const restoredUrl = process.env.TEST_RESTORED_DATABASE_URL;
for (const value of [sourceUrl, restoredUrl]) {
  if (!value || !new URL(value).pathname.endsWith('_test')) throw Error('Isolated _test databases are required');
}
const sql = postgres(sourceUrl, { max: 1, onnotice: () => {} });
test.after(async () => { await sql.end({ timeout: 5 }); });

test('PostgreSQL 18 empty tables are included, and full dump restore matches content and sequences', async () => {
  const source = await audit(sourceUrl);
  const empty = source.tables.find(row => row.table === 'empty_table');
  assert.ok(empty);
  assert.equal(empty.count, '0');
  assert.equal(empty.contentHash, 'd41d8cd98f00b204e9800998ecf8427e');
  assert.deepEqual(await audit(restoredUrl), source);
  assert.deepEqual(source.sequences, [{ schema: 'public', sequence: 'fixture_seq', lastValue: '41', isCalled: false }]);
});

test('identical data produces the same audit after physical row order changes', async () => {
  const before = await audit(sourceUrl);
  await sql.begin(async tx => {
    await tx`CREATE TEMP TABLE reordered AS SELECT * FROM fixture_rows ORDER BY id DESC`;
    await tx`DELETE FROM fixture_rows`;
    await tx`INSERT INTO fixture_rows SELECT * FROM reordered ORDER BY id DESC`;
  });
  assert.deepEqual(await audit(sourceUrl), before);
});

test('changing one value is detected even though table and row counts are unchanged', async () => {
  const before = await audit(sourceUrl);
  try {
    await sql`UPDATE fixture_rows SET body = 'changed cell' WHERE id = 1`;
    const after = await audit(sourceUrl);
    assert.notDeepEqual(after, before);
    const oldRow = before.tables.find(row => row.table === 'fixture_rows');
    const newRow = after.tables.find(row => row.table === 'fixture_rows');
    assert.equal(newRow.count, oldRow.count);
    assert.notEqual(newRow.contentHash, oldRow.contentHash);
  } finally { await sql`UPDATE fixture_rows SET body = 'first value' WHERE id = 1`; }
});

test('sequence value and is_called are both audited independently of table contents', async () => {
  const before = await audit(sourceUrl);
  try {
    await sql`SELECT nextval('fixture_seq')`;
    const called = await audit(sourceUrl);
    assert.deepEqual(called.tables, before.tables);
    assert.equal(called.sequences[0].lastValue, '41');
    assert.equal(called.sequences[0].isCalled, true);
    assert.notDeepEqual(called, before);
    await sql`SELECT setval('fixture_seq', 42, false)`;
    const moved = await audit(sourceUrl);
    assert.equal(moved.sequences[0].lastValue, '42');
    assert.equal(moved.sequences[0].isCalled, false);
    assert.notDeepEqual(moved, before);
  } finally { await sql`SELECT setval('fixture_seq', 41, false)`; }
});

test('compare CLI accepts a restored audit and rejects differing data', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'newshot-audit-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source.json');
  const restored = path.join(temp, 'restored.json');
  fs.writeFileSync(source, JSON.stringify(await audit(sourceUrl)));
  const result = await audit(restoredUrl);
  fs.writeFileSync(restored, JSON.stringify(result));
  const run = () => spawnSync(process.execPath, [path.join(__dirname, '../audit.cjs'), 'compare', source, restored], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  result.tables[0].contentHash = '0'.repeat(32);
  fs.writeFileSync(restored, JSON.stringify(result));
  assert.equal(run().status, 1);
});

test('capture connection failure never prints credentials or connection URLs', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../audit.cjs'), 'capture'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATABASE_URL: 'postgres://audit_secret_check:never-emit-password@127.0.0.1:1/audit_test' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Read-only audit failed:/);
  assert.doesNotMatch(result.stdout + result.stderr, /audit_secret_check|never-emit-password|postgres:\/\//);
});

test('local feedback and uploaded contact references are audited; external Feishu images are excluded', async () => {
  await sql`CREATE TABLE feedback (id integer, screenshot_key text)`;
  await sql`CREATE TABLE settings (key text, value jsonb)`;
  try {
    await sql`INSERT INTO feedback VALUES (1, 'local:feedback-one.png'), (2, 'img_v3_external_feishu_key'), (3, NULL), (4, 'local:feedback-one.png')`;
    await sql`INSERT INTO settings VALUES ('contact_qr', '{"wechatQr": "/contact/qr-wechat-12345678.png", "feishuQr": null}'::jsonb)`;
    const captured = await audit(sourceUrl);
    assert.deepEqual(captured.attachmentRefs, ['feedback-screenshots/feedback-one.png', 'uploads/qr-wechat-12345678.png']);
  } finally {
    await sql`DROP TABLE feedback`;
    await sql`DROP TABLE settings`;
  }
});
