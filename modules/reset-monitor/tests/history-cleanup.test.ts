import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { cleanupMonitorHistory, monitorHistoryPlan, monitorHistorySnapshot } from "../backend/history-cleanup.ts";

beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`; await sql`DELETE FROM monitor_events`; await sql`DELETE FROM monitor_posts`; await sql`DELETE FROM monitor_state`;
  for (const [monitor, id, raw] of [
    ["codex", "100", { tweet: { in_reply_to_status_id_str: "101" }, contextPending: true, processingMode: "automatic_incremental" }],
    ["codex", "101", { context: [{ id: "102" }] }], ["codex", "102", {}], ["codex", "103", {}], ["grok", "100", {}],
  ] as const) await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url,raw,processed_at) VALUES(${monitor},${id},'official',now(),'Saved evidence',${`https://x.com/official/status/${id}`},${sql.json(raw as never)},now())`;
  await sql`INSERT INTO monitor_events(monitor_id,id,type,status,title,withdrawn,created_at,updated_at) VALUES('codex','event','direct_reset','confirmed','Preserved withdrawn event',true,now(),now())`;
  await sql`INSERT INTO monitor_event_posts(monitor_id,event_id,post_id,stage,action,text,original_text) VALUES('codex','event','100','confirmed','confirm','Evidence','Evidence')`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES
    ('codex','cursor:socialdata','{"checkpointVersion":2,"scannedThrough":"2026-10-19T01:00:00Z","source":"operator"}'::jsonb),
    ('codex','initial:socialdata','{"cursor":"retired"}'::jsonb),
    ('codex','public_v2:pending:event','{"status":"needs_review"}'::jsonb),
    ('codex','public_v2:pending:missing','{"status":"pending"}'::jsonb)`;
});
after(closeDb);

test("preview preserves withdrawn events and transitive evidence, and isolates identical IDs across monitors", async () => {
  const before = await monitorHistorySnapshot(["codex", "grok"]);
  const plan = monitorHistoryPlan(before);
  assert.deepEqual(plan.deletedPosts, [{ monitor_id: "codex", id: "103" }, { monitor_id: "grok", id: "100" }]);
  assert.deepEqual(await monitorHistorySnapshot(["codex", "grok"]), before, "preview must not write");
  await cleanupMonitorHistory(["codex", "grok"], plan.fingerprint);
  const after = await monitorHistorySnapshot(["codex", "grok"]);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.links, before.links);
  assert.deepEqual(after.posts.map(p => p.id), ["100", "101", "102"]);
  assert.equal((after.posts[0]!.raw as any).contextPending, undefined);
  assert.equal(after.states.find(s => s.key === "cursor:socialdata")!.value.scannedThrough, "2026-10-19T01:00:00Z");
  assert.ok(after.states.some(s => s.key === "public_v2:pending:event"));
  assert.ok(!after.states.some(s => s.key.startsWith("initial:") || s.key.endsWith(":missing")));
});

test("a fact edit after preview rejects cleanup before any deletion", async () => {
  const plan = monitorHistoryPlan(await monitorHistorySnapshot(["codex"]));
  await sql`UPDATE monitor_events SET title='A new manual decision' WHERE monitor_id='codex' AND id='event'`;
  await assert.rejects(cleanupMonitorHistory(["codex"], plan.fingerprint), /History changed/);
  assert.equal((await sql`SELECT count(*)::int n FROM monitor_posts WHERE monitor_id='codex'`)[0]!.n, 4);
});
