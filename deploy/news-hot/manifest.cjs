// Also runs with the server's Node 12; application code still requires Node 24.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const files = ['source.tar.gz', 'app-image.tar.gz', 'db-image.tar.gz'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function assert(ok, message) { if (!ok) throw new Error(message); }
function migrations(root) {
  const dirs = [path.join(root, 'database/migrations')];
  const modules = path.join(root, 'modules');
  if (fs.existsSync(modules)) for (const name of fs.readdirSync(modules)) dirs.push(path.join(modules, name, 'migrations'));
  const result = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.sql'))) {
      result.push({ name, path: path.relative(root, path.join(dir, name)).split(path.sep).join('/'), sha256: hash(fs.readFileSync(path.join(dir, name))) });
    }
  }
  result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  assert(new Set(result.map(row => row.name)).size === result.length, 'Duplicate migration filenames');
  return result;
}
function create(sha, bundle, root, appId, dbId) {
  assert(shaPattern.test(sha), 'Expected a full commit SHA');
  assert(/^sha256:[a-f0-9]{64}$/.test(appId) && /^sha256:[a-f0-9]{64}$/.test(dbId), 'Expected image content IDs');
  const manifest = { format: 1, sha, appImage: 'news-hot:' + sha, appId, dbImage: 'postgres:18-alpine', dbId,
    files: files.map(name => ({ name, sha256: hash(fs.readFileSync(path.join(bundle, name))) })), migrations: migrations(root) };
  fs.writeFileSync(path.join(bundle, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
function validate(manifest, sha) {
  assert(manifest.format === 1 && shaPattern.test(sha) && manifest.sha === sha, 'Release identity mismatch');
  assert(manifest.appImage === 'news-hot:' + sha && manifest.dbImage === 'postgres:18-alpine', 'Unexpected image tag');
  assert(/^sha256:[a-f0-9]{64}$/.test(manifest.appId) && /^sha256:[a-f0-9]{64}$/.test(manifest.dbId), 'Invalid image ID');
  assert(Array.isArray(manifest.files) && JSON.stringify(manifest.files.map(row => row.name)) === JSON.stringify(files), 'Unexpected bundle files');
  for (const row of manifest.files) assert(digestPattern.test(row.sha256), 'Invalid bundle checksum');
  assert(Array.isArray(manifest.migrations), 'Missing migrations');
  const names = new Set();
  for (const row of manifest.migrations) {
    assert(/^[a-zA-Z0-9_.-]+\.sql$/.test(row.name) && !names.has(row.name), 'Invalid or duplicate migration filename');
    assert(/^(database\/migrations|modules\/[a-zA-Z0-9_-]+\/migrations)\/[a-zA-Z0-9_.-]+\.sql$/.test(row.path), 'Invalid migration path');
    assert(path.posix.basename(row.path) === row.name && digestPattern.test(row.sha256), 'Invalid migration checksum');
    names.add(row.name);
  }
}
function verify(sha, bundle, root) {
  const manifest = readJson(path.join(bundle, 'release.json'));
  validate(manifest, sha);
  for (const row of manifest.files) assert(hash(fs.readFileSync(path.join(bundle, row.name))) === row.sha256, 'Checksum failed: ' + row.name);
  if (root) assert(JSON.stringify(migrations(root)) === JSON.stringify(manifest.migrations), 'Extracted migration content differs from manifest');
  return manifest;
}
function plan(candidate, previous, applied, currentSha) {
  validate(candidate, candidate.sha);
  if (previous) {
    validate(previous, previous.sha);
    assert(previous.sha === currentSha, 'Published release identity mismatch');
    for (const old of previous.migrations) {
      const now = candidate.migrations.find(row => row.name === old.name);
      assert(now && now.path === old.path && now.sha256 === old.sha256, 'Published migration changed or removed: ' + old.name);
    }
  }
  const names = new Set(candidate.migrations.map(row => row.name));
  assert(applied.every(name => names.has(name)), 'Database contains migrations absent from candidate');
  const appliedNames = Array.from(new Set(applied)).sort();
  const pending = candidate.migrations.filter(row => !appliedNames.includes(row.name));
  const state = { sha: candidate.sha, currentSha, manifestHash: hash(JSON.stringify(candidate)), applied: appliedNames, pending };
  return Object.assign(state, { approvalDigest: hash(JSON.stringify(state)), needsMigration: pending.length > 0 });
}
module.exports = { hash, migrations, create, validate, verify, plan };
if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'create') create(...args);
    else if (command === 'verify') verify(...args);
    else if (command === 'plan') {
      const [candidate, previous, ledger, currentSha] = args;
      console.log(JSON.stringify(plan(readJson(candidate), previous === '-' ? null : readJson(previous), fs.readFileSync(ledger, 'utf8').trim().split(/\r?\n/).filter(Boolean), currentSha)));
    } else if (command === 'get') {
      const [file, key] = args;
      const value = readJson(file)[key];
      assert(typeof value === 'string' || typeof value === 'boolean', 'Expected a scalar manifest field');
      console.log(value);
    } else if (command === 'pending-sql') {
      const [file, root] = args;
      for (const row of readJson(file).pending) {
        console.log('### ' + row.name + '\n\n```sql\n' + fs.readFileSync(path.join(root, row.path), 'utf8') + '\n```\n');
      }
    } else throw new Error('Unknown manifest command');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
