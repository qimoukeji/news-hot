import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { inMonitor } from "../backend/context.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { markIncompleteSource } from "../backend/source-completeness.ts";
import { listMonitorPosts } from "../backend/admin.ts";
import { resetPage } from "../backend/read.ts";

beforeEach(async () => {
  process.env.CLAUDE_RESET_PROVIDER = "socialdata";
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
});
after(closeDb);

test("incomplete articles are held with original results, an audit and monitor isolation", async () => {
  const original = { relevant: false, needsReview: false, propositions: [], modelResult: { relevant: false, immutable: true } };
  for (const monitor of ["codex", "claude"]) {
    await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,recognition,processed_at)
      VALUES (${monitor},'article',${monitor === "claude" ? "ClaudeDevs" : "thsottiaux"},now(),
      'http://x.com/i/article/2077886850262503424','https://x.com/i/status/123',${sql.json(original)},now())`;
  }
  await sql`INSERT INTO monitor_state (monitor_id,key,value) VALUES ('claude','watermarks:socialdata',${sql.json({ lastVerifiedAt: new Date().toISOString() })})`;
  const [attemptsBefore] = await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
  const [codexBefore] = await sql`SELECT * FROM monitor_posts WHERE monitor_id='codex'`;
  await inMonitor(claude, async () => {
    assert.equal(await markIncompleteSource("article", "source-reviewer"), true);
    assert.equal(await markIncompleteSource("article", "source-reviewer"), false);
    const [post] = await sql`SELECT * FROM monitor_posts WHERE monitor_id='claude'`;
    assert.equal(post.recognition.needsReview, true);
    assert.deepEqual(post.recognition.originalRecognition, original);
    assert.deepEqual(post.recognition.modelResult, original.modelResult);
    assert.match(post.recognition.sourceIssue, /正文未保存/);
    assert.equal(post.activity, null);
    assert.ok(post.processed_at);
    assert.deepEqual(post.recognition.notify, []);
    const review = await listMonitorPosts({ filter: "review" });
    assert.equal(review.total, 1);
    assert.match(review.rows[0]!.source_issue!, /正文未保存/);
    assert.equal((await resetPage()).monitor!.status, "attention");
  });
  const [codexAfter] = await sql`SELECT * FROM monitor_posts WHERE monitor_id='codex'`;
  assert.deepEqual(codexAfter, codexBefore);
  const [attemptsAfter] = await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
  assert.deepEqual(attemptsAfter, attemptsBefore);
  const audits = await sql`SELECT * FROM audit_log WHERE actor='source-reviewer'`;
  assert.equal(audits.length, 1);
});

test("an explicit completed manual decision is preserved", async () => {
  const recognition = { relevant: false, needsReview: false, propositions: [], manualReview: { completed: true, reason: "已人工阅读文章" } };
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,recognition,processed_at)
    VALUES ('claude','reviewed','ClaudeDevs',now(),'https://x.com/i/article/123','https://x.com/i/status/123',${sql.json(recognition)},now())`;
  assert.equal(await inMonitor(claude, () => markIncompleteSource("reviewed")), false);
  const [post] = await sql`SELECT recognition FROM monitor_posts WHERE monitor_id='claude' AND id='reviewed'`;
  assert.deepEqual(post.recognition, recognition);
});
