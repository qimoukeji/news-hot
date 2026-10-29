import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { sql, closeDb } from "@aihot/backend/db";
import { inMonitor } from "../backend/context.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { previewThreadRepair, applyThreadRepair } from "../backend/thread-repair.ts";
const priorPath = process.env.PATH;
const clients = path.resolve(".data/local-preview/reset-monitor-postgres/clients");
if (existsSync(path.join(clients, process.platform === "win32" ? "pg_dump.exe" : "pg_dump"))) process.env.PATH = `${clients}${path.delimiter}${priorPath ?? ""}`;
const backupFiles: string[] = [];
after(async () => { process.env.PATH = priorPath; await closeDb(); for (const file of backupFiles) { await unlink(file); await rmdir(path.dirname(file)); } });
const author = "thsottiaux", at = "2026-10-28T02:00:00Z";
const raw = (id: string, patch: Record<string, unknown> = {}) => ({ id, text: `Synthetic source ${id}`, createdAt: at,
  author: { userName: author, name: "Official" }, ...patch });
async function fixture() {
  await sql`DELETE FROM monitor_webhook_deliveries`; await sql`DELETE FROM monitor_webhook_notifications`;
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM audit_log`; await sql`DELETE FROM receipt_attempts`; await sql`DELETE FROM receipts`;
  const quote = raw("102", { isReply: true, inReplyToId: "101", inReplyToUsername: null });
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,request,response,attempts)
    VALUES('synthetic-thread-repair','twitterapi_io','monitor.scan','x:thsottiaux','completed','{}'::jsonb,${sql.json({ tweets: [raw("101"), raw("104"), raw("103", { quoted_tweet: quote })] })},1) RETURNING id`;
  for (const [id, status] of [["101", "processed"], ["103", "needs_attention"], ["104", "processed"]] as const) await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text,processing_status,review_reason,source_receipt_id)
    VALUES('codex',${id},${author},${at},${`https://x.com/${author}/status/${id}`},${`Synthetic source ${id}`},${status},${status === "needs_attention" ? "Missing context" : null},${receipt!.id})`;
  await sql`INSERT INTO monitor_event_records(monitor_id,id,type,scope,created_at) VALUES('codex','existing-event','direct_reset',NULL,${at})`;
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,sources,created_at)
    VALUES('codex','existing-action','existing-event',1,'announce','{"en":"Synthetic announcement"}'::jsonb,'[{"postId":"101"}]'::jsonb,${at})`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex','cursor:twitterapi_io','{"checkpointVersion":2,"scannedThrough":"2026-10-28T09:39:54.126Z"}'::jsonb)`;
  return { receiptIds: [Number(receipt!.id)], targetPostIds: ["102", "103"] };
}
async function backup() {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-repair-backup-")), file = path.join(directory, "complete.dump");
  execFileSync("pg_dump", ["--format=custom", "--file", file, process.env.DATABASE_URL!], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  backupFiles.push(file);
  return file;
}
test("reviewed repair restores only the missing source and requeues review without paid calls or checkpoint changes", async () => inMonitor(codex, async () => {
  const options = await fixture(), preview = await previewThreadRepair(options), dump = await backup();
  assert.deepEqual(preview.ambiguities, []);
  const [checkpoint] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='cursor:twitterapi_io'`;
  const original = await sql`SELECT id,processing_status,updated_at FROM monitor_source_posts WHERE id IN ('101','104') ORDER BY id`;
  const events = await sql`SELECT * FROM monitor_event_records`, actions = await sql`SELECT * FROM monitor_event_actions`;
  const result = await applyThreadRepair(options, preview.fingerprint, dump);
  assert.equal(result.paidCalls, 0); assert.equal(result.checkpointChanged, false);
  const posts = await sql`SELECT id,processing_status,reply_to,source_receipt_id,context_only FROM monitor_source_posts ORDER BY id`;
  assert.deepEqual(posts.map(post => [post.id, post.processing_status]), [["101", "processed"], ["102", "pending"], ["103", "pending"], ["104", "processed"]]);
  assert.deepEqual(posts[1]!.reply_to, { postId: "101", author: null });
  assert.equal(Number(posts[1]!.source_receipt_id), options.receiptIds[0]);
  assert.equal(posts[1]!.context_only, false);
  assert.deepEqual(await sql`SELECT id,processing_status,updated_at FROM monitor_source_posts WHERE id IN ('101','104') ORDER BY id`, original);
  assert.deepEqual(await sql`SELECT * FROM monitor_event_records`, events); assert.deepEqual(await sql`SELECT * FROM monitor_event_actions`, actions);
  assert.deepEqual((await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='cursor:twitterapi_io'`)[0]!.value, checkpoint!.value);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0]!.n, 0);
  const markers = await sql`SELECT key,value FROM monitor_state WHERE key LIKE 'recognition:historical:%' ORDER BY key`;
  assert.deepEqual(markers.map(row => row.key), ["recognition:historical:102", "recognition:historical:103"]);
  assert.ok(markers.every(row => row.value.suppressNotifications));
  const audit = await sql`SELECT before,after FROM audit_log WHERE action='reset_monitor.thread.repair'`;
  assert.equal(audit.length, 1); assert.ok(!JSON.stringify(audit).includes("Synthetic source"));
}));
test("a changed target invalidates the preview before any repair write", async () => inMonitor(codex, async () => {
  const options = await fixture(), preview = await previewThreadRepair(options), dump = await backup();
  await sql`UPDATE monitor_source_posts SET review_reason='Manual update',updated_at=clock_timestamp() WHERE monitor_id='codex' AND id='103'`;
  await assert.rejects(applyThreadRepair(options, preview.fingerprint, dump), /changed/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_source_posts WHERE id='102'`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='reset_monitor.thread.repair'`)[0]!.n, 0);
}));
