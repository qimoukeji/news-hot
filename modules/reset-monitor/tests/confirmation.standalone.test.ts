import { bt } from "./business-time-fixture.ts";
import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, addAction } from "./action-fixture.ts";
import { announcementBasis, inferredConfirmation, inferredConfirmationTime, inferenceBoundary } from "../backend/confirmation.ts";
import { defaultActionTime, reduceEvent, type ActionInput } from "../actions.ts";
import { projectPublicV2 } from "../backend/public-v2.ts";
import { eventUpdateSchema, resetEventSchema } from "../public-v2.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
const now = Date.parse("2026-10-27T08:00:00Z"), plan = "2026-10-26T08:00:00Z";
function announced(time: string | null = plan) {
  const input = fixture(); Object.assign(input.actions[0]!, { action: "announce", time: bt(time) }); return input;
}
for (const definition of [codex, claude, grok]) for (const type of ["direct_reset", "reset_credit", "bonus_credit"] as const) test(`${definition.monitorId}/${type}: persisted empty-source confirmations complete the shared public timeline once`, () => {
  const input = announced(); input.events[0]!.type = type;
  const original = structuredClone(input);
  assert.equal(projectPublicV2(input, definition, now).events[0]!.status, "announced", "reads do not manufacture actions");
  assert.deepEqual(input, original);
  const action = inferredConfirmation(input.events[0]!, input, now)!; input.actions.push(action);
  assert.equal(action.summary!.zh, "预告时间已到，实际重置状态以账户显示为准");
  assert.equal(action.title.zh, "已到预告时间");
  const read = () => projectPublicV2(input, definition, now);
  let snapshot = read(); assert.equal(snapshot.events[0]!.status, "completed");
  assert.equal(snapshot.events[0]!.updates[0]!.id, action.id); assert.deepEqual(snapshot.events[0]!.updates[0]!.sources, []);
  assert.deepEqual(snapshot.events[0]!.updates[0]!.summary, action.summary);
  assert.equal("confirmation" in snapshot.events[0]!, false); assert.equal("resetConfirmation" in snapshot, false);
  assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  const counts = snapshot.statistics; assert.equal(counts.resetsLast30Days! + counts.cardsLast30Days! + counts.bonusesLast30Days!, 1);
  const official = reduceEvent(input.events[0]!, { ...input, actions: input.actions.filter(item => item.sources.length) });
  assert.equal(official!.status, "announced");
  Object.assign(action, { sources: [{ postId: input.posts[0]!.id }], time: bt("2026-10-27T06:00:00Z") });
  snapshot = read(); assert.equal(snapshot.events[0]!.updates.find(item => item.id === action.id)!.sources.length, 1);
  assert.deepEqual(snapshot.resetTime, "2026-10-27T06:00:00Z"); assert.equal(input.actions.length, 2);
});

test("instant, Beijing-date and interval plans generate exactly at their boundaries", () => {
  for (const time of [plan, "2026-10-26", "2026-10-26T08:00:00Z/2026-10-27T08:00:00Z"]) {
    const input = announced(time), boundary = inferenceBoundary(bt(time));
    assert.equal(inferredConfirmation(input.events[0]!, input, boundary - 1), null);
    const action = inferredConfirmation(input.events[0]!, input, boundary)!;
    assert.deepEqual(action.time, inferredConfirmationTime(bt(time))); assert.deepEqual(action.sources, []);
    input.actions.push(action); assert.equal(inferredConfirmation(input.events[0]!, input, boundary + 60_000), null);
  }
  assert.equal(inferenceBoundary(bt("2026-10-26")), Date.parse("2026-10-26T10:00:00Z"));
});

test("unknown plans, progress, review conflicts and withdrawal block automatic completion", () => {
  const input = announced(null);
  assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  input.actions[0]!.time = bt(plan); input.posts[0]!.processing_status = "needs_attention";
  assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  input.posts[0]!.processing_status = "processed"; addAction(input, "delayed", "progress", plan);
  assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  addAction(input, "rescheduled", "announce", plan, { time: bt("2026-10-28") });
  assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  input.events[0]!.withdrawn = true; assert.equal(inferredConfirmation(input.events[0]!, input, inferenceBoundary(bt("2026-10-28"))), null);
});

for (const time of [null, "2026-10-15T12:00:00Z", "2026-10-15", "2026-10-15T10:00:00Z/2026-10-15T12:00:00Z"] as const)
  test(`ordinary amendments preserve the ${time ?? "unknown"} announcement plan`, () => {
    const input = announced(time), before = reduceEvent(input.events[0]!, input)!, basis = announcementBasis(input.events[0]!, input)!;
    const publishedAt = "2026-10-11T17:00:00Z";
    addAction(input, "eligibility-correction", "amend", publishedAt, { time: defaultActionTime("amend", publishedAt) });
    const after = reduceEvent(input.events[0]!, input)!;
    assert.equal(after.status, "announced"); assert.deepEqual(after.time, before.time); assert.deepEqual(after.announcedTime, before.announcedTime);
    assert.equal(announcementBasis(input.events[0]!, input)!.version, basis.version, "a factual correction does not create a new plan identity");
    assert.equal(inferredConfirmation(input.events[0]!, input, Date.parse("2026-10-11T18:00:00Z")), null);
    const snapshot = projectPublicV2(input, codex, Date.parse(publishedAt));
    const update = snapshot.events[0]!.updates.find(update => update.action === "amend")!;
    assert.deepEqual(update.time, bt("2026-10-12T10:00:00.000Z")); assert.equal(update.publishedAt, new Date(publishedAt).toISOString());
    assert.deepEqual(snapshot.announcedResetTime, before.announcedTime);
    if (time === null) assert.equal(inferredConfirmation(input.events[0]!, input, Date.parse("2027-01-01T00:00:00Z")), null);
    else assert.deepEqual(inferredConfirmation(input.events[0]!, input, inferenceBoundary(bt(time)))!.time, inferredConfirmationTime(bt(time)));
  });

test("an amendment's explicit business time cannot reschedule a promise or resume a paused plan", () => {
  const input = announced("2026-10-15T12:00:00Z");
  addAction(input, "scope-correction", "amend", "2026-10-11T12:00:00Z", { time: bt("2026-10-11T09:00:00Z") });
  assert.deepEqual(reduceEvent(input.events[0]!, input)!.announcedTime, bt("2026-10-15T12:00:00Z"));
  addAction(input, "postponed", "progress", "2026-10-12T00:00:00Z");
  addAction(input, "another-correction", "amend", "2026-10-13T00:00:00Z", { time: bt("2026-10-13T10:00:00Z") });
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "in_progress");
  assert.equal(inferredConfirmation(input.events[0]!, input, Date.parse("2027-01-01T00:00:00Z")), null);
});

test("ordinary amendments do not invalidate an accepted source-free confirmation", () => {
  const input = announced(), confirmation = inferredConfirmation(input.events[0]!, input, now)!;
  input.actions.push(confirmation);
  addAction(input, "wording-correction", "amend", "2026-11-02T17:00:00Z", { time: defaultActionTime("amend", "2026-11-02T17:00:00Z") });
  const result = reduceEvent(input.events[0]!, input)!;
  assert.equal(result.status, "completed"); assert.equal(result.confirmationId, confirmation.id); assert.deepEqual(result.confirmedTime, confirmation.time);
  assert.equal(inferredConfirmation(input.events[0]!, input, Date.parse("2027-01-01T00:00:00Z")), null);
});

test("new plans and cancellation invalidate prior unsourced confirmations without deleting history", () => {
  const input = announced(); const first = inferredConfirmation(input.events[0]!, input, now)!; input.actions.push(first);
  addAction(input, "new-plan", "announce", "2026-10-27T00:00:00Z", { time: bt("2026-10-28") });
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "announced");
  assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  const second = inferredConfirmation(input.events[0]!, input, inferenceBoundary(bt("2026-10-28")))!;
  assert.notEqual(second.id, first.id); input.actions.push(second);
  addAction(input, "cancel", "amend", "2026-10-29T00:00:00Z", { invalidates_event: true });
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "cancelled");
  assert.equal(projectPublicV2(input, codex, now).events[0]!.updates.filter(update => !update.sources.length).length, 2);
});

test("dates and intervals confirm at a point while their original announcements remain intact", () => {
  for (const time of ["2026-10-26", "2026-10-26T08:00:00Z/2026-10-27T08:00:00Z"]) {
    const input = announced(time); input.actions.push(inferredConfirmation(input.events[0]!, input, now)!);
    const snapshot = projectPublicV2(input, codex, now);
    assert.equal(snapshot.resetTime, inferredConfirmationTime(bt(time)).at);
    assert.deepEqual(snapshot.events[0]!.time, inferredConfirmationTime(bt(time)));
    assert.deepEqual(snapshot.events[0]!.updates.find(update => update.action === "announce")!.time, bt(time));
    assert.equal(snapshot.statistics.typicalInterval, null);
  }
});

test("the v2 schema allows empty sources only for confirmation and rejects removed metadata", () => {
  const input = announced(); input.actions.push(inferredConfirmation(input.events[0]!, input, now)!);
  const event = projectPublicV2(input, codex, now).events[0]!, update = event.updates[0]!;
  assert.equal(eventUpdateSchema.safeParse(update).success, true);
  for (const action of ["announce", "progress", "amend", "restore"]) assert.equal(eventUpdateSchema.safeParse({ ...update, action }).success, false);
  assert.equal(resetEventSchema.safeParse({ ...event, confirmation: null }).success, false);
});
