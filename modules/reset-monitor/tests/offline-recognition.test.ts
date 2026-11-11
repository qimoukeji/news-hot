import { bt } from "./business-time-fixture.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { applyOfflineRecognition, applyRecognition } from "../backend/assemble.ts";
import { storeCollectedPost, sourcePost, loadActionInput } from "../backend/action-store.ts";
import { recognitionPrompt, type ActionRecognitionBody } from "../backend/recognize.ts";
import { publicV2Snapshot } from "../backend/public-v2.ts";

const localized = (text: string) => ({ en: text, zh: text, "zh-Hant": text, ja: text, ko: text, ru: text, es: text });
const at = "2026-10-23T12:00:00.000Z";
function response(excerpt = "We reset usage for everyone."): ActionRecognitionBody {
  return { relevant: true, needsReview: false, title: localized("Quota update"), summary: null,
    actions: [{ eventId: null, localEventKey: "new-1", existingActionId: null, kind: "direct_reset", kindExplicit: true,
      action: "confirm", invalidatesEvent: false, real: true, role: "action", excerpt, title: localized("Usage reset"), summary: null,
      timeExcerpt: null,
      scope: { type: "unknown", note: null }, scopeExcerpt: null }] };
}
async function post(text = "We reset usage for everyone.", replyTo: { postId: string | null; author: string | null } | null = null) {
  const id = randomUUID();
  await storeCollectedPost({ id, author: codex.authors[0]!.handle, publishedAt: at, url: `https://x.com/thsottiaux/status/${id}`,
    text, replyTo, receiptId: null });
  return (await sourcePost(id))!;
}

beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts`;
});
after(closeDb);

test("offline acceptance stores real source facts with no paid receipts and is resumable", async () => inMonitor(codex, async () => {
  const saved = await post();
  await applyOfflineRecognition(saved.id, response(), saved.version);
  const input = await loadActionInput(), snapshot = await publicV2Snapshot();
  assert.equal(input.posts[0]!.source_receipt_id, null);
  assert.equal(input.posts[0]!.model_receipt_id, null);
  assert.equal(input.posts[0]!.processing_status, "processed");
  assert.equal(input.events.length, 1);
  assert.equal(input.actions.length, 1);
  assert.equal(snapshot.events[0]!.status, "completed");
  assert.deepEqual(snapshot.events[0]!.time, bt(at));
  assert.equal((await sql`SELECT 1 FROM receipts`).length, 0);
  await applyOfflineRecognition(saved.id, response(), saved.version);
  assert.equal((await loadActionInput()).actions.length, 1);
  assert.equal((await sql`SELECT 1 FROM monitor_state WHERE key LIKE '%cursor%' OR key LIKE '%watermarks%'`).length, 0);
}));

test("offline and paid acceptance share identical action, scope and time checks", async () => inMonitor(codex, async () => {
  const free = await post();
  await applyOfflineRecognition(free.id, response(), free.version);
  const paid = await post();
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,response)
    VALUES(${randomUUID()},'synthetic',${`${codex.names.purposePrefix}.recognize`},${`x:${paid.id}`},'received','{}'::jsonb) RETURNING id`;
  await applyRecognition(paid.id, { ...response(), receiptId: receipt!.id, model: "synthetic", promptVersion: "synthetic" }, paid.version);
  const snapshot = await publicV2Snapshot();
  assert.equal(snapshot.events.length, 2);
  const facts = snapshot.events.map(event => ({ type: event.type, status: event.status, time: event.time, scope: event.scope,
    actions: event.updates.map(action => ({ action: action.action, title: action.title, summary: action.summary })) }));
  assert.deepEqual(facts[0], facts[1]);
  assert.equal((await sql`SELECT status FROM receipts`)[0]!.status, "completed");
}));

test("offline fabricated excerpts remain visible for review", async () => inMonitor(codex, async () => {
  const saved = await post("We will reset usage tomorrow.");
  await applyOfflineRecognition(saved.id, response(), saved.version);
  const row = await sourcePost(saved.id);
  assert.equal(row!.processing_status, "needs_attention");
  assert.match(row!.review_reason!, /本帖明确依据/);
  assert.equal(row!.model_receipt_id, null);
  assert.equal((await loadActionInput()).events.length, 0);
}));

test("plural resets explicitly propagated can confirm, while a future reset remains review", async () => inMonitor(codex, async () => {
  const completed = await post("Resets all propagated. Have a fantastic weekend.");
  await applyOfflineRecognition(completed.id, response("Resets all propagated."), completed.version);
  assert.equal((await sourcePost(completed.id))!.processing_status, "processed");
  assert.equal((await publicV2Snapshot()).events[0]!.status, "completed");
  const future = await post("Resets will land tomorrow.");
  await applyOfflineRecognition(future.id, response("Resets will land tomorrow."), future.version);
  assert.equal((await sourcePost(future.id))!.processing_status, "needs_attention");
  assert.equal((await loadActionInput()).events.length, 1);
}));

test("a quoted post cannot establish the outer action's audience", async () => inMonitor(codex, async () => {
  const grant = "We have added one banked reset to every account.", borrowed = "Only affected subscribers are eligible.";
  const saved = await post(grant);
  await sql`UPDATE monitor_source_posts SET quoted_post=${sql.json({ id: "quoted-scope", author: "another_author", relation: "quote",
    text: borrowed, publishedAt: at, url: "https://x.com/another_author/status/quoted-scope" })},updated_at=clock_timestamp()
    WHERE monitor_id=${codex.monitorId} AND id=${saved.id}`;
  const answer = response(grant), action = answer.actions[0]!;
  action.kind = "reset_credit";
  action.scope = { type: "selected_users", note: localized("Affected subscribers") };
  action.scopeExcerpt = borrowed;
  await applyOfflineRecognition(saved.id, answer, (await sourcePost(saved.id))!.version);
  assert.equal((await sourcePost(saved.id))!.processing_status, "needs_attention");
  assert.match((await sourcePost(saved.id))!.review_reason!, /范围不在本帖中/);
  assert.equal((await loadActionInput()).events.length, 0);
}));

test("offline bare reply without saved parent cannot establish a reset", async () => inMonitor(codex, async () => {
  const saved = await post("Done.", { postId: "missing-parent", author: "another_author" });
  const answer = response("Done.");
  answer.actions[0]!.role = "answer";
  answer.actions[0]!.kindExplicit = false;
  await applyOfflineRecognition(saved.id, answer, saved.version);
  assert.equal((await sourcePost(saved.id))!.processing_status, "needs_attention");
  assert.equal((await loadActionInput()).actions.length, 0);
}));

test("offline input rejects extra receipt metadata and preserves stale post edits", async () => inMonitor(codex, async () => {
  const saved = await post();
  await assert.rejects(applyOfflineRecognition(saved.id, { ...response(), receiptId: 123 }, saved.version));
  assert.equal((await sourcePost(saved.id))!.processing_status, "pending");
  await sql`UPDATE monitor_source_posts SET text='An edited source',updated_at=clock_timestamp() WHERE monitor_id=${codex.monitorId} AND id=${saved.id}`;
  await applyOfflineRecognition(saved.id, response(), saved.version);
  assert.equal((await loadActionInput()).actions.length, 0);
  assert.equal((await sourcePost(saved.id))!.text, "An edited source");
}));

test("offline instructions contain the bound product rules and strict formal contract", () => inMonitor(codex, () => {
  const prompt = recognitionPrompt();
  assert.match(prompt, /Every action must quote a literal excerpt from the CURRENT post/);
  assert.match(prompt, /invalidatesEvent/);
  assert.match(prompt, /Codex/i);
  assert.match(prompt, /"localEventKey"/);
}));
