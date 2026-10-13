// Read-only database content audit, used before export and after restoring to an isolated database.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function attachmentFiles(dataDir, report, brandDir) {
  const files = [];
  function walk(relative) {
    const full = path.join(dataDir, relative);
    let stat;
    try { stat = fs.lstatSync(full); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw Error('Attachment links are not allowed');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) walk(relative + '/' + name);
    } else if (stat.isFile()) {
      files.push({ path: relative, bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
    } else throw Error('Unexpected attachment file type');
  }
  for (const dir of ['uploads', 'feedback-screenshots']) walk(dir);
  const names = new Set(files.map(file => file.path));
  for (const reference of report.attachmentRefs || []) {
    if (!/^(uploads|feedback-screenshots)\/[\w.-]+$/.test(reference)) throw Error('Invalid referenced attachment');
    if (!names.has(reference)) {
      const packaged = brandDir && reference.startsWith('uploads/') && path.join(brandDir, reference.slice(8));
      if (!packaged || !fs.existsSync(packaged) || !fs.lstatSync(packaged).isFile()) throw Error('Missing referenced attachment');
    }
  }
  return { format: 1, files };
}
async function audit(url) {
  const postgres = require('postgres');
  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    return await sql.begin('isolation level repeatable read read only', async tx => {
      await tx`SET LOCAL TIME ZONE 'UTC'`;
      const [{ version }] = await tx`SELECT current_setting('server_version_num')::int AS version`;
      if (Math.floor(version / 10000) !== 18) throw Error('Expected PostgreSQL 18');
      const tables = await tx`SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema COLLATE "C", table_name COLLATE "C"`;
      const rows = [];
      for (const table of tables) {
        const [value] = await tx`SELECT count(*)::text AS count, md5(coalesce(string_agg(md5(row_to_json(t)::text), '' ORDER BY md5(row_to_json(t)::text) COLLATE "C"), '')) AS content_hash FROM ${tx(table.table_schema + '.' + table.table_name)} t`;
        rows.push({ schema: table.table_schema, table: table.table_name, count: value.count, contentHash: value.content_hash });
      }
      const sequenceNames = await tx`SELECT sequence_schema, sequence_name FROM information_schema.sequences ORDER BY sequence_schema COLLATE "C", sequence_name COLLATE "C"`;
      const sequences = [];
      for (const sequence of sequenceNames) {
        const [value] = await tx`SELECT last_value::text AS last_value, is_called FROM ${tx(sequence.sequence_schema + '.' + sequence.sequence_name)}`;
        sequences.push({ schema: sequence.sequence_schema, sequence: sequence.sequence_name, lastValue: value.last_value, isCalled: value.is_called });
      }
      const attachmentRefs = [];
      if (tables.some(t => t.table_schema === 'public' && t.table_name === 'feedback')) {
        for (const row of await tx`SELECT screenshot_key FROM feedback WHERE screenshot_key LIKE 'local:%'`) attachmentRefs.push('feedback-screenshots/' + row.screenshot_key.slice(6));
      }
      if (tables.some(t => t.table_schema === 'public' && t.table_name === 'settings')) {
        for (const row of await tx`SELECT value FROM settings WHERE key = 'contact_qr'`) {
          for (const value of Object.values(row.value || {})) {
            if (typeof value === 'string' && value.startsWith('/contact/')) attachmentRefs.push('uploads/' + value.slice(9));
          }
        }
      }
      return { format: 1, postgresMajor: 18, tables: rows, sequences, attachmentRefs: [...new Set(attachmentRefs)].sort() };
    });
  } finally { await sql.end({ timeout: 5 }); }
}
module.exports = { audit, attachmentFiles };
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'compare') {
    if (JSON.stringify(JSON.parse(fs.readFileSync(args[0], 'utf8'))) !== JSON.stringify(JSON.parse(fs.readFileSync(args[1], 'utf8')))) {
      console.error('Restored database differs from source audit'); process.exitCode = 1;
    } else console.log('Audit manifests match');
  } else if (command === 'files') {
    try { console.log(JSON.stringify(attachmentFiles(args[0], JSON.parse(fs.readFileSync(args[1] === '-' ? 0 : args[1], 'utf8')), args[2]), null, 2)); }
    catch (_) { console.error('Attachment verification failed'); process.exitCode = 1; }
  } else if (command === 'capture') {
    audit(process.env.DATABASE_URL).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
      // Never print connection URLs or driver detail containing credentials.
      console.error('Read-only audit failed: ' + (error.code || error.name)); process.exitCode = 1;
    });
  } else { console.error('Expected capture, files or compare'); process.exitCode = 2; }
}
