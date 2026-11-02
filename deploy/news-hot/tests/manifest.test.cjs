const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { create, migrations, verify, plan } = require('../manifest.cjs');

const oldSha = '1'.repeat(40);
const newSha = '2'.repeat(40);
const appId = 'sha256:' + 'a'.repeat(64);
const dbId = 'sha256:' + 'b'.repeat(64);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newshot-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(bundle);
  for (const name of ['source.tar.gz', 'app-image.tar.gz', 'db-image.tar.gz']) fs.writeFileSync(path.join(bundle, name), name);
  function sql(name, text = 'SELECT 1;', module) {
    const dir = path.join(source, module ? `modules/${module}/migrations` : 'database/migrations');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  sql('0001_base.sql');
  return { source, bundle, sql, manifest: sha => create(sha, bundle, source, appId, dbId) };
}

test('verify rejects each modified artifact and modified extracted SQL', t => {
  const f = fixture(t);
  f.manifest(newSha);
  assert.equal(verify(newSha, f.bundle, f.source).sha, newSha);
  for (const name of ['source.tar.gz', 'app-image.tar.gz', 'db-image.tar.gz']) {
    const file = path.join(f.bundle, name);
    const original = fs.readFileSync(file);
    fs.appendFileSync(file, 'tamper');
    assert.throws(() => verify(newSha, f.bundle, f.source), /Checksum failed/);
    fs.writeFileSync(file, original);
  }
  f.sql('0001_base.sql', 'SELECT 2;');
  assert.throws(() => verify(newSha, f.bundle, f.source), /Extracted migration content/);
});

test('duplicate migration filenames across core and modules are rejected', t => {
  const f = fixture(t);
  f.sql('0001_base.sql', 'SELECT 2;', 'extra');
  assert.throws(() => migrations(f.source), /Duplicate migration filenames/);
});

test('a published migration cannot be edited, removed, or moved', t => {
  const f = fixture(t);
  const previous = f.manifest(oldSha);
  f.sql('0001_base.sql', 'SELECT 2;');
  assert.throws(() => plan(f.manifest(newSha), previous, ['0001_base.sql'], oldSha), /Published migration changed or removed/);
  fs.rmSync(path.join(f.source, 'database/migrations/0001_base.sql'));
  assert.throws(() => plan(f.manifest(newSha), previous, [], oldSha), /Published migration changed or removed/);
  f.sql('0001_base.sql', 'SELECT 1;', 'extra');
  assert.throws(() => plan(f.manifest(newSha), previous, ['0001_base.sql'], oldSha), /Published migration changed or removed/);
});

test('same numbered migrations remain distinct and are ordered by full filename', t => {
  const f = fixture(t);
  const previous = f.manifest(oldSha);
  f.sql('0002_b.sql', 'SELECT 2;', 'extra');
  f.sql('0002_a.sql', 'SELECT 3;');
  const candidate = f.manifest(newSha);
  const result = plan(candidate, previous, ['0001_base.sql', '0002_a.sql'], oldSha);
  assert.deepEqual(candidate.migrations.map(row => row.name), ['0001_base.sql', '0002_a.sql', '0002_b.sql']);
  assert.deepEqual(result.pending.map(row => row.name), ['0002_b.sql']);
  assert.equal(result.needsMigration, true);
});

test('database ledger entries absent from candidate fail closed', t => {
  const f = fixture(t);
  const previous = f.manifest(oldSha);
  assert.throws(() => plan(f.manifest(newSha), previous, ['0001_base.sql', '9999_unknown.sql'], oldSha), /Database contains migrations absent/);
});

test('approval binds commit, current release, migration SQL, and applied ledger', t => {
  const f = fixture(t);
  const previous = f.manifest(oldSha);
  f.sql('0002_next.sql');
  const candidate = f.manifest(newSha);
  const original = plan(candidate, previous, ['0001_base.sql'], oldSha);
  assert.equal(original.approvalDigest, plan(candidate, previous, ['0001_base.sql', '0001_base.sql'], oldSha).approvalDigest);
  assert.notEqual(original.approvalDigest, plan(candidate, previous, ['0001_base.sql', '0002_next.sql'], oldSha).approvalDigest);
  assert.notEqual(original.approvalDigest, plan(f.manifest('3'.repeat(40)), previous, ['0001_base.sql'], oldSha).approvalDigest);
  const otherCurrent = { ...previous, sha: '4'.repeat(40), appImage: 'news-hot:' + '4'.repeat(40) };
  assert.notEqual(original.approvalDigest, plan(candidate, otherCurrent, ['0001_base.sql'], otherCurrent.sha).approvalDigest);
  f.sql('0002_next.sql', 'SELECT 4;');
  assert.notEqual(original.approvalDigest, plan(f.manifest(newSha), previous, ['0001_base.sql'], oldSha).approvalDigest);
});

test('business time conversion is planned only before the exact scalar-column drop', t => {
  const f = fixture(t);
  const previous = f.manifest(oldSha);
  const cutoff = '0146_monitor_actions_business_time.sql';
  const drop = '0152_monitor_actions_drop_scalar_time.sql';
  f.sql(cutoff, 'SELECT 1;', 'reset-monitor');
  f.sql(drop, 'SELECT 2;', 'reset-monitor');
  f.sql('0153_monitor_actions_rename_business_time.sql', 'SELECT 3;', 'reset-monitor');
  const candidate = f.manifest(newSha);
  assert.equal(plan(candidate, previous, [], oldSha).needsBusinessTimeUpgrade, true);
  const partial = plan(candidate, previous, ['0001_base.sql', cutoff], oldSha);
  assert.equal(partial.needsBusinessTimeUpgrade, true);
  const converted = plan(candidate, previous, ['0001_base.sql', cutoff, drop], oldSha);
  assert.equal(converted.needsBusinessTimeUpgrade, false);
  assert.notEqual(partial.approvalDigest, converted.approvalDigest);
});

test('business time conversion requires its cutoff and ignores other modules with similar names', t => {
  const f = fixture(t);
  const previous = f.manifest(oldSha);
  f.sql('0152_monitor_actions_drop_scalar_time.sql', 'SELECT 1;', 'other');
  assert.equal(plan(f.manifest(newSha), previous, ['0001_base.sql'], oldSha).needsBusinessTimeUpgrade, false);
  fs.rmSync(path.join(f.source, 'modules/other/migrations/0152_monitor_actions_drop_scalar_time.sql'));
  f.sql('0152_monitor_actions_drop_scalar_time.sql', 'SELECT 1;', 'reset-monitor');
  assert.throws(() => plan(f.manifest(newSha), previous, ['0001_base.sql'], oldSha), /requires the 0146 cutoff/);
});
