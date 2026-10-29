import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor, monitorId } from "../backend/context.ts";
import { loadActionInput, sourcePost, writePostActions } from "../backend/action-store.ts";
import { listMonitorEntries } from "../backend/admin.ts";
import { properName } from "../backend/public-v2.ts";

after(closeDb);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
});
async function post(id: string, at: string, status = "processed") {
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,text,processing_status,review_reason)
    VALUES(${monitorId()},${id},'SourceAuthor',${at},${`https://example.test/${id}`},${sql.json(properName(id))},${`Private original ${id}`},${status},${status === "failed" ? "需要核验来源" : null})`;
}
const fact = (eventId: string, action: "confirm" | "amend" = "confirm") => ({ eventId, action, title: properName(action), summary: properName("Source fact"), time: null });

for (const definition of [codex, claude, grok]) test(`${definition.monitorId} combined entries group all facts and sources before filtering and pagination`, async () => {
  for (const def of [codex, claude, grok]) await inMonitor(def, async () => {
    await post("first", "2026-10-01T12:00:00Z");
    await post("late-source", "2026-10-20T12:00:00Z", "failed");
    await post("unlinked", "2026-10-15T12:00:00Z", "needs_attention");
    await post("unrelated", "2026-10-02T12:00:00Z");
    await sql.begin(async db => {
      const p = (await sourcePost("first", db))!;
      await writePostActions(db, p, [fact("event"), fact("event", "amend")], { events: [{ id: "event", type: "direct_reset", title: properName(def.product) }] });
      await writePostActions(db, p, [fact("second-event")], { events: [{ id: "second-event", type: "reset_credit" }] });
      const action = (await loadActionInput(db)).actions.find(a => a.event_id === "event" && a.action === "confirm")!;
      await writePostActions(db, (await sourcePost("late-source", db))!, [{ ...fact("event"), id: action.id }]);
    });
  });
  await inMonitor(definition, async () => {
    const list = await listMonitorEntries();
    assert.equal(list.total, 4, "linked posts only appear under their events");
    assert.deepEqual(list.rows.map(row => row.kind === "event" ? row.event.id : row.post.id), ["event", "unlinked", "unrelated", "second-event"]);
    const first = list.rows[0]!; assert.equal(first.kind, "event"); if (first.kind !== "event") return;
    assert.equal(first.latestAt, "2026-10-20T12:00:00.000Z", "late duplicate sources update group ordering");
    assert.equal(first.event.title!.en, definition.product, "same IDs in other monitors stay isolated");
    assert.equal(first.event.timeline.length, 2);
    const confirmation = first.event.timeline.find(a => a.action === "confirm")!;
    assert.equal(confirmation.publishedAt, "2026-10-01T12:00:00.000Z", "action time remains its earliest source");
    assert.deepEqual(confirmation.sources.map(s => s.id), ["first", "late-source"]);
    assert.equal(confirmation.sources[1]!.processingStatus, "failed");
    assert.equal(confirmation.sources[1]!.reviewReason, "需要核验来源");
    assert.equal(JSON.stringify(list).includes("Private original"), false);
    assert.equal((await listMonitorEntries({ filter: "failed" })).total, 1);
    assert.equal((await listMonitorEntries({ kind: "posts" })).total, 2);
    assert.equal((await listMonitorEntries({ kind: "events" })).total, 2);
    assert.equal((await listMonitorEntries({ filter: "needs_attention", kind: "posts" })).total, 1);
    assert.equal((await listMonitorEntries({ q: "Private original late-source" })).total, 1);
    const typed = await listMonitorEntries({ type: "reset_credit", status: "completed", visibility: "public" });
    assert.equal(typed.total, 1); assert.equal(typed.rows[0]!.kind, "event");
    const before = await loadActionInput(); await listMonitorEntries(); assert.deepEqual(await loadActionInput(), before);
    for (const opts of [{ kind: "bad" }, { filter: "bad" }, { type: "bad" }, { status: "bad" }, { visibility: "bad" }]) await assert.rejects(listMonitorEntries(opts));
  });
});

test("a combined page counts whole groups and preserves untranslated facts and events without initial actions", async () => inMonitor(codex, async () => {
  await post("first", "2026-10-01T12:00:00Z");
  await sql.begin(async db => writePostActions(db, (await sourcePost("first", db))!, [fact("event")], { events: [{ id: "event", type: "direct_reset", title: { zh: "待译事件" } }] }));
  await sql`UPDATE monitor_event_actions SET title='{"zh":"待译事实"}'::jsonb WHERE monitor_id='codex'`;
  await sql`INSERT INTO monitor_event_records(monitor_id,id,type,created_at) VALUES('codex','empty','direct_reset','2026-10-01T11:00:00Z')`;
  for (let i = 0; i < 12; i++) await post(`unlinked-${i}`, `2026-10-${String(i + 2).padStart(2, "0")}T12:00:00Z`);
  const first = await listMonitorEntries(), second = await listMonitorEntries({ page: 2 });
  assert.equal(first.total, 14); assert.equal(first.totalPages, 2); assert.equal(first.rows.length, 10); assert.equal(second.rows.length, 4);
  const ids = [...first.rows, ...second.rows].map(r => r.kind === "event" ? r.event.id : r.post.id);
  assert.equal(new Set(ids).size, 14);
  const untranslated = (await listMonitorEntries({ q: "待译事实" })).rows[0]!;
  assert.equal(untranslated.kind, "event");
  if (untranslated.kind === "event") assert.deepEqual(untranslated.event.timeline[0]!.title, { zh: "待译事实" });
  const empty = (await listMonitorEntries({ visibility: "unpublished" })).rows[0]!;
  assert.equal(empty.kind, "event"); if (empty.kind === "event") { assert.equal(empty.event.status, null); assert.deepEqual(empty.event.timeline, []); }
}));
