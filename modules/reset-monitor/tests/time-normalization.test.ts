import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { applyOfflineRecognition, applyRecognitionGroup } from "../backend/assemble.ts";
import { storeCollectedPost, sourcePost, loadActionInput, writePostActions } from "../backend/action-store.ts";
import { inferredConfirmation } from "../backend/confirmation.ts";
import { reduceEvent } from "../actions.ts";
import { properName } from "../backend/public-v2.ts";
import type { ActionRecognitionBody } from "../backend/recognize.ts";

const author = codex.authors[0]!.handle;
const at = "2026-11-11T12:00:00.000Z";
function response(text: string, timeExcerpt: string | null): ActionRecognitionBody {
  return { relevant: true, needsReview: false, title: properName("Reset planned"), summary: null, actions: [{
    eventId: null, localEventKey: "new", existingActionId: null, kind: "direct_reset", kindExplicit: true,
    action: "announce", invalidatesEvent: false, real: true, role: "action", excerpt: text,
    title: properName("Reset planned"), summary: null, timeExcerpt, scope: { type: "unknown", note: null }, scopeExcerpt: null,
  }] };
}
async function post(text: string) {
  const id = randomUUID();
  await storeCollectedPost({ id, author, publishedAt: at, text, url: `https://x.com/${author}/status/${id}`, receiptId: null });
  return (await sourcePost(id))!;
}
async function receiptFor(postId: string) {
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,response)
    VALUES(${randomUUID()},'synthetic','monitor.recognize',${`x:${postId}`},'received','{}'::jsonb) RETURNING id`;
  return receipt!.id;
}
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`; await sql`DELETE FROM monitor_state`; await sql`DELETE FROM receipts`;
});
after(closeDb);

for (const paid of [false, true]) test(`invalid time retains its existing event, action and review reason (${paid ? "paid" : "offline"})`, async () => inMonitor(codex, async () => {
  const firstText = "We will reset usage on November 12.", first = await post(firstText);
  await applyOfflineRecognition(first.id, response(firstText, "November 12"), first.version);
  const initial = await loadActionInput(), event = initial.events[0]!;
  const text = "The usage reset will happen on 2026-02-30.", saved = await post(text), body = response(text, "2026-02-30");
  Object.assign(body.actions[0]!, { eventId: event.id, localEventKey: null });
  let receiptId: number | undefined;
  if (paid) {
    receiptId = await receiptFor(saved.id);
    const baseline = await loadActionInput();
    await applyRecognitionGroup([baseline.posts.find(post => post.id === saved.id)!], [], baseline, {
      posts: [{ postId: saved.id, ...body, reviewReason: null }], failedPostIds: [],
      receiptId, model: "synthetic", promptVersion: "synthetic", reused: false,
    });
  } else await applyOfflineRecognition(saved.id, body, saved.version);
  const input = await loadActionInput(), linked = input.actions.find(action => action.sources.some(source => source.postId === saved.id))!;
  assert.equal(input.events.length, 1);
  assert.equal(input.actions.length, 2);
  assert.equal(linked.event_id, event.id);
  assert.deepEqual(linked.time, { kind: "instant", at: "2026-11-11T18:00:00Z" });
  assert.equal((await sourcePost(saved.id))!.processing_status, "needs_attention");
  assert.match((await sourcePost(saved.id))!.review_reason!, /时间/);
  assert.equal(inferredConfirmation(event, input, Date.parse("2026-11-15T00:00:00Z")), null);
  if (receiptId) assert.equal((await sql`SELECT status FROM receipts WHERE id=${receiptId}`)[0]!.status, "completed");
  await applyOfflineRecognition(saved.id, body, saved.version);
  assert.deepEqual((await loadActionInput()).actions, input.actions, "retry does not duplicate or recalculate the saved fallback");
}));

test("an exact schedule supplied by a later post in the same recognition group refines the original action", async () => inMonitor(codex, async () => {
  const original = "We will reset usage on November 12.", detail = "The usage reset is scheduled for November 12 at 20:00 UTC.";
  const first = await post(original), second = await post(detail);
  const initial = response(original, "November 12"), followup = response(detail, "November 12 at 20:00 UTC");
  followup.actions[0]!.existingActionId = `source:${first.id}`;
  const baseline = await loadActionInput();
  await applyRecognitionGroup([first.id, second.id].map(id => baseline.posts.find(post => post.id === id)!), [], baseline, {
    posts: [{ postId: first.id, ...initial, reviewReason: null }, { postId: second.id, ...followup, reviewReason: null }],
    receiptId: await receiptFor(first.id), model: "synthetic", promptVersion: "synthetic", reused: false,
  });
  const input = await loadActionInput();
  assert.equal(input.events.length, 1); assert.equal(input.actions.length, 1);
  assert.deepEqual(input.actions[0]!.time, { kind: "instant", at: "2026-11-12T20:00:00Z" });
  assert.deepEqual(new Set(input.actions[0]!.sources.map(source => source.postId)), new Set([first.id, second.id]));
  assert.ok(input.posts.every(post => post.processing_status === "processed"));
}));

test("a later exact time refines the same announcement and invalidates its old automatic confirmation", async () => inMonitor(codex, async () => {
  const text = "We will reset usage on November 12.", first = await post(text);
  const firstResponse = response(text, "November 12");
  firstResponse.actions[0]!.summary = properName("Preserved announcement facts");
  await applyOfflineRecognition(first.id, firstResponse, first.version);
  const initial = await loadActionInput(), announcement = initial.actions[0]!, event = initial.events[0]!;
  const automatic = inferredConfirmation(event, initial, Date.parse("2026-11-12T18:00:00Z"))!;
  assert.ok(automatic);
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,summary,time,sources,created_at,updated_at)
    VALUES('codex',${automatic.id},${event.id},2,'confirm',${sql.json(automatic.title)},${sql.json(automatic.summary!)},${sql.json(automatic.time)},'[]'::jsonb,${automatic.created_at},${automatic.updated_at})`;
  const followupText = "The usage reset is scheduled for November 12 at 20:00 UTC.", followup = await post(followupText);
  const answer = response(followupText, "November 12 at 20:00 UTC");
  Object.assign(answer.actions[0]!, { eventId: event.id, localEventKey: null, existingActionId: announcement.id });
  await applyOfflineRecognition(followup.id, answer, followup.version);
  const input = await loadActionInput(), refined = input.actions.find(action => action.id === announcement.id)!;
  assert.equal(input.events.length, 1); assert.equal(input.actions.length, 2);
  assert.equal(refined.sequence, announcement.sequence);
  assert.deepEqual(refined.summary, announcement.summary);
  assert.deepEqual(refined.time, { kind: "instant", at: "2026-11-12T20:00:00Z" });
  assert.deepEqual(new Set(refined.sources.map(source => source.postId)), new Set([first.id, followup.id]));
  assert.equal(reduceEvent(event, input)!.status, "announced");
  assert.equal((await sourcePost(followup.id))!.processing_status, "processed");
  const dateOnly = "We will reset usage on November 12 UTC+05:00.";
  const restatement = await post(dateOnly), repeat = response(dateOnly, "November 12 UTC+05:00");
  Object.assign(repeat.actions[0]!, { eventId: event.id, localEventKey: null, existingActionId: announcement.id });
  await applyOfflineRecognition(restatement.id, repeat, restatement.version);
  assert.deepEqual((await loadActionInput()).actions.find(action => action.id === announcement.id)!.time, refined.time,
    "a date-only reminder cannot overwrite the explicit clock");
}));

test("a sourced confirmation uses its publication and ordinary supplements retain its accepted time", async () => inMonitor(codex, async () => {
  const text = "We reset usage yesterday.", saved = await post(text), body = response(text, "yesterday");
  body.actions[0]!.action = "confirm";
  await applyOfflineRecognition(saved.id, body, saved.version);
  const input = await loadActionInput(), accepted = input.actions[0]!;
  assert.deepEqual(accepted.time, { kind: "instant", at });
  const repeat = await post(text);
  await sql.begin(tx => writePostActions(tx, repeat, [{ id: accepted.id, eventId: accepted.event_id,
    action: "confirm", title: accepted.title, summary: accepted.summary, time: accepted.time }]));
  assert.deepEqual((await loadActionInput()).actions[0]!.time, accepted.time);
}));
