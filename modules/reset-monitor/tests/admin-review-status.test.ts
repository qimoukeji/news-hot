import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { inMonitor } from "../backend/context.ts";
import { listMonitorPosts } from "../backend/admin.ts";
import { resetPage } from "../backend/read.ts";
import { watermarksKey } from "../config.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";

after(closeDb);
for (const definition of [codex, claude, grok]) {
  test(`${definition.monitorId}: only a completed manual decision closes review in lists and health`, async () => {
    const at = new Date();
    for (const [id, manualReview] of [
      ["held", { completed: false, reason: "上下文不足，保留复核" }],
      ["completed", { completed: true, reason: "已核实原文" }],
      ["incomplete-marker", { reason: "尚无完成结论" }],
    ] as const) {
      await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,processed_at,recognition)
        VALUES (${definition.monitorId},${id},${definition.authors[0]!.handle},${at},'Reset announcement','https://example.org/post',${at},
          ${sql.json({ relevant: true, needsReview: true, propositions: [], manualReview })})`;
    }
    await sql`INSERT INTO monitor_state (monitor_id,key,value) VALUES (${definition.monitorId},${inMonitor(definition, watermarksKey)},
      ${sql.json({ lastVerifiedAt: at.toISOString() })})`;
    await inMonitor(definition, async () => {
      const review = await listMonitorPosts({ filter: "review" });
      assert.equal(review.total, 2);
      assert.deepEqual(review.rows.map(row => row.id).sort(), ["held", "incomplete-marker"]);
      assert.ok(review.rows.every(row => row.needs_review));
      const all = await listMonitorPosts({ filter: "all" });
      const completed = all.rows.find(row => row.id === "completed")!;
      assert.equal(completed.manual_review!.completed, true);
      assert.equal(completed.needs_review, false);
      assert.equal((await resetPage()).monitor!.reviewCount, 2);
    });
    const [original] = await sql`SELECT recognition FROM monitor_posts WHERE monitor_id=${definition.monitorId} AND id='completed'`;
    assert.equal(original!.recognition.needsReview, true, "public/admin projection preserves the raw model result");
  });
}
