import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { threadRepairPlan, type ThreadRepairSnapshot } from "../backend/thread-repair.ts";
import type { SourcePostRow } from "../actions.ts";
after(closeDb);
const at = "2026-10-28T02:00:00.000Z", author = "Official";
const raw = (id: string, patch: Record<string, unknown> = {}) => ({ id, text: `Post ${id}`, createdAt: at,
  author: { userName: author, name: author }, isReply: false, ...patch });
const saved = (id: string, patch: Partial<SourcePostRow> = {}): SourcePostRow => ({ id, author, published_at: at,
  url: `https://x.com/${author}/status/${id}`, text: `Post ${id}`, quoted_post: null, reply_to: null,
  context_only: false, filtered_out: false, title: null, summary: null, source_receipt_id: 35, model_receipt_id: 37,
  processing_status: "processed", review_reason: null, created_at: at, updated_at: at, ...patch });
function fixture(): ThreadRepairSnapshot {
  const b = raw("102", { isReply: true, inReplyToId: "101", inReplyToUsername: null });
  return { monitorId: "codex", authors: [author],
    receipts: [{ id: 35, service: "twitterapi_io", purpose: "monitor.scan", status: "completed",
      response: { tweets: [raw("101"), raw("104"), raw("103", { quoted_tweet: b })] } }],
    posts: [saved("101"), saved("104"), saved("103", { quoted_post: { id: "102", author, relation: "quote", text: "Post 102", publishedAt: at, url: `https://x.com/${author}/status/102` }, processing_status: "needs_attention", review_reason: "Missing context", model_receipt_id: 39 })],
    events: [{ id: "existing-event", type: "direct_reset", title: null, summary: null, scope: null, withdrawn: false, created_at: at, updated_at: at }],
    actions: [{ id: "existing-action", event_id: "existing-event", sequence: 1, action: "announce", invalidates_event: false,
      title: { en: "Announced" }, summary: null, time: null, sources: [{ postId: "101" }], created_at: at, updated_at: at }],
  };
}
const options = { receiptIds: [35], targetPostIds: ["102", "103"] };
test("restore the missing self reply from a saved quote and requeue only the selected review post", () => {
  const snapshot = fixture(), before = structuredClone(snapshot), plan = threadRepairPlan(snapshot, options);
  assert.deepEqual(plan.ambiguities, []);
  assert.deepEqual(plan.changes.insert, [{ postId: "102", author, sourceReceiptId: 35, contextOnly: false,
    replyTo: { postId: "101", author: null }, quoteId: null }]);
  assert.deepEqual(plan.changes.requeue, ["103"]);
  assert.deepEqual(plan.relatedPostIds, ["101", "102", "103"]);
  assert.deepEqual(plan.eventIds, ["existing-event"]);
  assert.deepEqual(plan.actionIds, ["existing-action"]);
  assert.deepEqual(snapshot, before, "preview must not mutate stored evidence or processed posts");
});
test("a completed target is preserved, not silently scheduled for another paid answer", () => {
  const snapshot = fixture();
  const plan = threadRepairPlan(snapshot, { receiptIds: [35], targetPostIds: ["101"] });
  assert.deepEqual(plan.changes.requeue, []);
  assert.deepEqual(plan.changes.preserved, ["101"]);
});
test("conflicting originals and receipt ownership prevent application", () => {
  const changed = fixture(); changed.posts[0]!.text = "Different source";
  assert.match(threadRepairPlan(changed, options).ambiguities.join(";"), /conflicts/);
  const wrong = fixture(); wrong.receipts[0]!.purpose = "reset_monitor.claude.scan";
  assert.match(threadRepairPlan(wrong, options).ambiguities.join(";"), /not an accepted collection/);
});
test("new source and relevant fact changes invalidate a reviewed fingerprint, unrelated records do not", () => {
  const first = fixture(), original = threadRepairPlan(first, options).fingerprint;
  const changed = fixture(); changed.posts[0]!.updated_at = "2026-10-29T02:00:00Z";
  assert.notEqual(threadRepairPlan(changed, options).fingerprint, original);
  const unrelated = fixture(); unrelated.posts[1]!.updated_at = "2026-10-29T02:00:00Z";
  assert.equal(threadRepairPlan(unrelated, options).fingerprint, original);
  const action = fixture(); action.actions[0]!.time = "2026-10-28";
  assert.notEqual(threadRepairPlan(action, options).fingerprint, original);
});
test("an unconfigured author cannot be restored as an official target", () => {
  const snapshot = fixture(); snapshot.authors = ["OtherOfficial"];
  assert.match(threadRepairPlan(snapshot, options).ambiguities.join(";"), /not authored by a configured/);
});
test("missing explicit parent evidence is reported rather than guessed or fetched by the repair planner", () => {
  const snapshot = fixture(); snapshot.posts = snapshot.posts.filter(post => post.id !== "101");
  snapshot.receipts[0]!.response!.tweets = snapshot.receipts[0]!.response!.tweets!.filter(value => (value as { id: string }).id !== "101");
  assert.match(threadRepairPlan(snapshot, options).ambiguities.join(";"), /Source 101 is absent/);
});
test("target order does not duplicate quote restoration", () => {
  const plan = threadRepairPlan(fixture(), { receiptIds: [35], targetPostIds: ["103", "102"] });
  assert.deepEqual(plan.ambiguities, []);
  assert.deepEqual(plan.changes.insert.map(post => post.postId), ["102"]);
  assert.deepEqual(plan.relatedPostIds, ["101", "102", "103"]);
});
test("invalid parent time and cycles are explicit preview ambiguities", () => {
  const newer = fixture(); newer.posts[0]!.published_at = "2026-10-28T03:00:00Z";
  newer.receipts[0]!.response!.tweets = newer.receipts[0]!.response!.tweets!.filter(value => (value as { id: string }).id !== "101");
  assert.match(threadRepairPlan(newer, options).ambiguities.join(";"), /newer than child/);
  const cyclic = fixture(); cyclic.posts[0]!.reply_to = { postId: "102", author };
  const source = cyclic.receipts[0]!.response!.tweets!.find(value => (value as { id: string }).id === "101") as Record<string, unknown>;
  source.isReply = true; source.inReplyToId = "102"; source.inReplyToUsername = author;
  assert.match(threadRepairPlan(cyclic, options).ambiguities.join(";"), /Cyclic reply/);
});
