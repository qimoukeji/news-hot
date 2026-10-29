import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, addAction } from "./action-fixture.ts";
import { inferredConfirmation, inferenceBoundary } from "../backend/confirmation.ts";
import { reduceEvent, type ActionInput } from "../actions.ts";
import { projectPublicV2 } from "../backend/public-v2.ts";
import { eventUpdateSchema, resetEventSchema } from "../public-v2.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
const now = Date.parse("2026-10-27T08:00:00Z"), plan = "2026-10-26T08:00:00Z";
function announced(time: string | null = plan) {
  const input = fixture(); Object.assign(input.actions[0]!, { action: "announce", time }); return input;
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
  Object.assign(action, { sources: [{ postId: input.posts[0]!.id }], time: "2026-10-27T06:00:00Z" });
  snapshot = read(); assert.equal(snapshot.events[0]!.updates.find(item => item.id === action.id)!.sources.length, 1);
  assert.equal(snapshot.resetTime, "2026-10-27T06:00:00Z"); assert.equal(input.actions.length, 2);
});

test("instant, Beijing-date and interval plans generate exactly at their boundaries", () => {
  for (const time of [plan, "2026-10-26", "2026-10-26T08:00:00Z/2026-10-27T08:00:00Z"]) {
    const input = announced(time), boundary = inferenceBoundary(time);
    assert.equal(inferredConfirmation(input.events[0]!, input, boundary - 1), null);
    const action = inferredConfirmation(input.events[0]!, input, boundary)!;
    assert.equal(action.time, time); assert.deepEqual(action.sources, []);
    input.actions.push(action); assert.equal(inferredConfirmation(input.events[0]!, input, boundary + 60_000), null);
  }
  assert.equal(inferenceBoundary("2026-10-26"), Date.parse("2026-10-26T16:00:00Z"));
});

test("missing plan, postponed progress, review conflicts and withdrawal cannot generate confirmations", () => {
  const input = announced(null); assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  input.actions[0]!.time = plan; input.posts[0]!.processing_status = "needs_attention";
  assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  input.posts[0]!.processing_status = "processed"; addAction(input, "delayed", "progress", plan);
  assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  addAction(input, "rescheduled", "announce", plan, { time: "2026-10-28" });
  assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  input.events[0]!.withdrawn = true; assert.equal(inferredConfirmation(input.events[0]!, input, inferenceBoundary("2026-10-28")), null);
});

test("new plans and cancellation invalidate prior unsourced confirmations without deleting history", () => {
  const input = announced(); const first = inferredConfirmation(input.events[0]!, input, now)!; input.actions.push(first);
  addAction(input, "new-plan", "announce", "2026-10-27T00:00:00Z", { time: "2026-10-28" });
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "announced");
  assert.equal(inferredConfirmation(input.events[0]!, input, now), null);
  const second = inferredConfirmation(input.events[0]!, input, inferenceBoundary("2026-10-28"))!;
  assert.notEqual(second.id, first.id); input.actions.push(second);
  addAction(input, "cancel", "amend", "2026-10-29T00:00:00Z", { invalidates_event: true });
  assert.equal(reduceEvent(input.events[0]!, input)!.status, "cancelled");
  assert.equal(projectPublicV2(input, codex, now).events[0]!.updates.filter(update => !update.sources.length).length, 2);
});

test("dates and intervals preserve precision without introducing interval samples", () => {
  for (const time of ["2026-10-26", "2026-10-26T08:00:00Z/2026-10-27T08:00:00Z"]) {
    const input = announced(time); input.actions.push(inferredConfirmation(input.events[0]!, input, now)!);
    const snapshot = projectPublicV2(input, codex, now); assert.equal(snapshot.resetTime, time); assert.equal(snapshot.statistics.typicalInterval, null);
  }
});

test("the v2 schema allows empty sources only for confirmation and rejects removed metadata", () => {
  const input = announced(); input.actions.push(inferredConfirmation(input.events[0]!, input, now)!);
  const event = projectPublicV2(input, codex, now).events[0]!, update = event.updates[0]!;
  assert.equal(eventUpdateSchema.safeParse(update).success, true);
  for (const action of ["announce", "progress", "amend", "restore"]) assert.equal(eventUpdateSchema.safeParse({ ...update, action }).success, false);
  assert.equal(resetEventSchema.safeParse({ ...event, confirmation: null }).success, false);
});
