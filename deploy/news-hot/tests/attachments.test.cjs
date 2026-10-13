const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { attachmentFiles } = require('../audit.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newshot-attachments-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const brand = path.join(root, 'brand');
  fs.mkdirSync(data);
  fs.mkdirSync(brand);
  function write(name, contents) {
    const file = path.join(data, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return { root, data, brand, write };
}

test('empty attachment storage is valid when no database references require files', t => {
  const f = fixture(t);
  assert.deepEqual(attachmentFiles(f.data, { attachmentRefs: [] }), { format: 1, files: [] });
});

test('all stored files have content hashes and a changed byte changes the manifest', t => {
  const f = fixture(t);
  f.write('uploads/qr.png', 'qr image bytes');
  f.write('feedback-screenshots/screenshot.png', 'feedback image bytes');
  const report = { attachmentRefs: ['uploads/qr.png', 'feedback-screenshots/screenshot.png'] };
  const before = attachmentFiles(f.data, report);
  const qr = before.files.find(row => row.path === 'uploads/qr.png');
  assert.equal(qr.bytes, Buffer.byteLength('qr image bytes'));
  assert.equal(qr.sha256, crypto.createHash('sha256').update('qr image bytes').digest('hex'));
  f.write('uploads/qr.png', 'qr image Bytes');
  const after = attachmentFiles(f.data, report);
  assert.equal(after.files.find(row => row.path === 'uploads/qr.png').bytes, qr.bytes);
  assert.notDeepEqual(after, before);
});

test('missing locally referenced screenshots and contact files are rejected', t => {
  const f = fixture(t);
  for (const reference of ['uploads/missing.png', 'feedback-screenshots/missing.png']) {
    assert.throws(() => attachmentFiles(f.data, { attachmentRefs: [reference] }), /Missing referenced attachment/);
  }
});

test('database references cannot escape the two attachment directories', t => {
  const f = fixture(t);
  for (const reference of ['uploads/../secret', 'feedback-screenshots/../../secret', '/uploads/file.png', 'other/file.png']) {
    assert.throws(() => attachmentFiles(f.data, { attachmentRefs: [reference] }, f.brand), /Invalid referenced attachment/);
  }
});

test('existing and dangling attachment symlinks are rejected', t => {
  const f = fixture(t);
  f.write('uploads/normal.png', 'bytes');
  for (const target of [path.join(f.data, 'uploads/normal.png'), path.join(f.root, 'missing')]) {
    const link = path.join(f.data, 'uploads/link.png');
    fs.symlinkSync(target, link);
    assert.throws(() => attachmentFiles(f.data, { attachmentRefs: [] }), /links are not allowed/);
    fs.unlinkSync(link);
  }
});

test('packaged contact images are allowed; package symlinks and screenshot fallback are rejected', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.brand, 'packaged.png'), 'packaged bytes');
  assert.deepEqual(attachmentFiles(f.data, { attachmentRefs: ['uploads/packaged.png'] }, f.brand), { format: 1, files: [] });
  assert.throws(() => attachmentFiles(f.data, { attachmentRefs: ['feedback-screenshots/packaged.png'] }, f.brand), /Missing referenced attachment/);
  fs.symlinkSync(path.join(f.brand, 'packaged.png'), path.join(f.brand, 'linked.png'));
  assert.throws(() => attachmentFiles(f.data, { attachmentRefs: ['uploads/linked.png'] }, f.brand), /Missing referenced attachment/);
});

test('files CLI emits a manifest and sanitizes errors for missing attachments', t => {
  const f = fixture(t);
  const report = path.join(f.root, 'audit.json');
  fs.writeFileSync(report, JSON.stringify({ attachmentRefs: [] }));
  const run = () => spawnSync(process.execPath, [path.join(__dirname, '../audit.cjs'), 'files', f.data, report], { encoding: 'utf8' });
  const success = run();
  assert.equal(success.status, 0);
  assert.deepEqual(JSON.parse(success.stdout), { format: 1, files: [] });
  fs.writeFileSync(report, JSON.stringify({ attachmentRefs: ['uploads/sensitive-name.png'] }));
  const failure = run();
  assert.equal(failure.status, 1);
  assert.equal(failure.stderr.trim(), 'Attachment verification failed');
  assert.equal(failure.stdout, '');
});
