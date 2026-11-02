import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { languages, type ActionInput } from "../actions.ts";
import { inferenceBoundary, inferredConfirmation } from "../backend/confirmation.ts";
import { editorialRecordVersion, editorialVersion } from "../backend/event-editorial.ts";
import { planInferredTimeRepair, planInferredTimeStates } from "../scripts/repair-inferred-time.ts";
import type { BusinessTime } from "../public-v2.ts";

const text = Object.fromEntries(languages.map(language => [language, "Synthetic fact"]));
const at = "2026-10-10T00:00:00Z";
function fixture(plan: BusinessTime): ActionInput {
  const input: ActionInput = {
    events: [{ id: "event", type: "reset_credit", title: text, summary: null, scope: null, withdrawn: false, created_at: at, updated_at: at }],
    posts: [{ id: "source", author: "official", published_at: at, url: "https://example.test/source", text: "Private original body must not leave storage",
      quoted_post: null, reply_to: null, filtered_out: false, title: text, summary: null, source_receipt_id: null, model_receipt_id: null,
      processing_status: "processed", review_reason: null, created_at: at, updated_at: at }],
    actions: [{ id: "announce", event_id: "event", action: "announce", invalidates_event: false, sequence: 1, title: text, summary: null,
      time: plan, sources: [{ postId: "source" }], created_at: at, updated_at: at }],
  };
  const confirmation = inferredConfirmation(input.events[0]!, input, inferenceBoundary(plan) + 1_000)!;
  input.actions.push({ ...confirmation, time: plan });
  return input;
}

test("inferred-time repair selects only proved generated confirmations and preserves precise boundaries", () => {
  const cases: Array<[BusinessTime, string]> = [
    [{ kind: "instant", at: "2026-11-02T05:42:26.123456789Z" }, "2026-11-02T05:42:26.123456789Z"],
    [{ kind: "range", from: at, through: "2026-11-02T05:42:26.123456789Z" }, "2026-11-02T05:42:26.123456789Z"],
    [{ kind: "deadline", at: "2026-11-02T05:42:26.123456789Z" }, "2026-11-02T05:42:26.123456789Z"],
    [{ kind: "date", date: "2026-11-02", timeZone: "America/Los_Angeles" }, "2026-11-02T10:00:00Z"],
  ];
  for (const [time, expected] of cases) {
    const input = fixture(time), before = structuredClone(input), result = planInferredTimeRepair(input);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.after.actions[1]!.time, { kind: "instant", at: expected });
    assert.equal(result.changes.length, time.kind === "instant" ? 0 : 1);
    assert.deepEqual(result.after.actions[0], input.actions[0], "The original announcement is immutable");
    assert.deepEqual(input, before, "Planning must not mutate the input");
    assert.equal(result.after.posts[0]!.text, null);
    assert.equal(result.after.posts[0]!.quoted_post, null);
    assert.deepEqual(result.after.actions.map(row => [row.id, row.created_at, row.sources]), input.actions.map(row => [row.id, row.created_at, row.sources]));
    assert.equal(planInferredTimeRepair(result.after).changes.length, 0);
  }
});

test("repair reconstructs each historical plan instead of borrowing a later announcement", () => {
  const input = fixture({ kind: "range", from: at, through: "2026-10-11T00:00:00Z" });
  input.posts.push({ ...input.posts[0]!, id: "later-source", published_at: "2026-10-12T00:00:00Z" });
  const plan: BusinessTime = { kind: "deadline", at: "2026-10-13T00:00:00Z" };
  input.actions.push({ ...input.actions[0]!, id: "later-announce", sequence: 3, time: plan, sources: [{ postId: "later-source" }] });
  const later = inferredConfirmation(input.events[0]!, input, inferenceBoundary(plan) + 1_000)!;
  input.actions.push({ ...later, time: plan });
  const result = planInferredTimeRepair(input);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.changes.map(change => change.after.at), ["2026-10-11T00:00:00Z", "2026-10-13T00:00:00Z"]);
});

test("historical scalar IDs require exact encoding or original-null defaults evidence", () => {
  const time: BusinessTime = { kind: "date", date: "2026-10-10", timeZone: "Asia/Shanghai" };
  const input = fixture(time);
  const id = (value: string | null) => `inferred-${sha256(stableJson({ event: "event", plan: sha256(stableJson([{ id: "announce", action: "announce", time: value }])) }))}`;
  input.actions[1]!.id = id(time.date);
  assert.equal(planInferredTimeRepair(input).changes[0]!.idProof, "scalar-plan");
  input.actions[1]!.id = id(null);
  assert.equal(planInferredTimeRepair(input).problems.length, 1);
  const evidence = [{ actionId: "announce", eventId: "event", sequence: 1, originalTime: null, sources: ["source"], publishedAt: new Date(at).toISOString() }];
  const result = planInferredTimeRepair(input, [], [], [], evidence);
  assert.deepEqual(result.problems, []);
  assert.equal(result.changes[0]!.idProof, "scalar-defaults");
  assert.equal(planInferredTimeRepair(result.after, [], [], [], evidence).changes.length, 0);
  for (const patch of [{ publishedAt: "2026-10-09T00:00:00.000Z" }, { sources: ["other-source"] }, { sequence: 2 }])
    assert.equal(planInferredTimeRepair(input, [], [], [], [{ ...evidence[0]!, ...patch }]).problems.length, 1);
});

test("a historical structured plan ID containing an ordinary amendment requires separate review", () => {
  const input = fixture({ kind: "instant", at: "2026-10-15T12:00:00Z" });
  const confirmation = input.actions.pop()!;
  input.posts.push({ ...input.posts[0]!, id: "amend-source", published_at: "2026-10-11T00:00:00Z" });
  input.actions.push({ ...input.actions[0]!, id: "ordinary-amend", action: "amend", sequence: 2,
    time: { kind: "instant", at: "2026-10-11T10:00:00Z" }, sources: [{ postId: "amend-source" }] });
  const oldRevisions = input.actions.map(action => ({ id: action.id, action: action.action, time: action.time }));
  const oldId = `inferred-${sha256(stableJson({ event: "event", plan: sha256(stableJson(oldRevisions)) }))}`;
  input.actions.push({ ...confirmation, id: oldId, sequence: 3, time: input.actions[1]!.time, created_at: "2026-10-11T10:01:00Z" });
  const before = structuredClone(input), result = planInferredTimeRepair(input);
  assert.deepEqual(result.problems, [{ actionId: oldId, reason: "Generated confirmation ID does not match its original plan" }]);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.after.actions, input.actions, "an unproved historical identity never authorizes rewriting its saved facts");
  assert.deepEqual(input, before);
});

test("manual confirmations and generated confirmations later upgraded by official sources remain untouched", () => {
  const input = fixture({ kind: "date", date: "2026-11-02", timeZone: "Asia/Shanghai" });
  input.actions[1]!.sources = [{ postId: "source" }];
  input.actions.push({ ...input.actions[1]!, id: "manual-confirm", sequence: 3, sources: [] });
  const result = planInferredTimeRepair(input);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.after.actions, input.actions);
});

test("unproved IDs, changed times and confirmations before their due boundary block automatic repair", () => {
  const source = fixture({ kind: "range", from: at, through: "2026-11-02T05:42:26Z" });
  for (const mutate of [
    (input: ActionInput) => { input.actions[1]!.id = "inferred-unproved"; },
    (input: ActionInput) => { input.actions[1]!.time = { kind: "instant", at }; },
    (input: ActionInput) => { input.actions[1]!.created_at = at; },
    (input: ActionInput) => { input.actions[0]!.sources = []; },
  ]) {
    const input = structuredClone(source); mutate(input);
    const result = planInferredTimeRepair(input);
    assert.equal(result.problems.length, 1);
    assert.deepEqual(result.changes, []);
  }
});

test("only outstanding deliveries belonging to changed events are selected for cancellation", () => {
  const input = fixture({ kind: "date", date: "2026-11-02", timeZone: "Asia/Shanghai" });
  const result = planInferredTimeRepair(input, [], [], [
    { id: "pending", eventId: "event", status: "pending", updatedAt: at },
    { id: "sending", eventId: "event", status: "sending", updatedAt: at },
    { id: "failed", eventId: "event", status: "failed", updatedAt: at },
    { id: "unrelated", eventId: "other", status: "pending", updatedAt: at },
  ]);
  assert.deepEqual(result.cancelledDeliveryIds, ["failed", "pending", "sending"]);
});

test("matching editorial bindings and failed translation identities advance without reviving stale state", () => {
  const input = fixture({ kind: "date", date: "2026-11-02", timeZone: "Asia/Shanghai" });
  const after = planInferredTimeRepair(input).after;
  after.actions[1]!.updated_at = "2026-11-03T00:00:00Z";
  after.events[0]!.updated_at = "2026-11-03T00:00:00Z";
  const states = [
    { key: "public_v2:overview:event", value: { status: "ready", version: editorialVersion(input.events[0]!, input), recordVersion: editorialRecordVersion(input.events[0]!) } },
    { key: `public_v2:translation:action:${input.actions[1]!.id}`, value: { status: "failed", version: sha256(stableJson(input.actions[1])), receiptId: 123 } },
    { key: "public_v2:translation:event:event", value: { status: "needs_review", version: sha256(stableJson(input.events[0])), receiptId: 124 } },
  ];
  const updates = planInferredTimeStates(input, after, states);
  assert.equal(updates.length, 3);
  assert.equal(updates[0]!.value.version, editorialVersion(after.events[0]!, after));
  assert.equal(updates[1]!.value.status, "failed");
  assert.equal(updates[1]!.value.receiptId, 123);
  assert.equal(updates[1]!.value.version, sha256(stableJson(after.actions[1])));
  assert.equal(updates[2]!.value.version, sha256(stableJson(after.events[0])));
  const stale = structuredClone(states);
  stale[0]!.value.recordVersion = "stale-record";
  stale[1]!.value.version = "stale-action";
  stale[2]!.value.version = "stale-event";
  assert.deepEqual(planInferredTimeStates(input, after, stale), []);
  const failure = [{ key: "public_v2:overview:event", value: { status: "failed", version: editorialVersion(input.events[0]!, input), receiptId: 125 } }];
  const updatedFailure = planInferredTimeStates(input, after, failure)[0]!;
  assert.equal(updatedFailure.value.status, "failed");
  assert.equal(updatedFailure.value.receiptId, 125);
  assert.equal(updatedFailure.value.version, editorialVersion(after.events[0]!, after));
});
