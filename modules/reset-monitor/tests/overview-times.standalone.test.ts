import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { projectPublicV2 } from "../backend/public-v2.ts";
import { actionDraftSchema, type ActionInput, type ActionRow } from "../actions.ts";
import { eventUpdateSchema, platformOverviewSchema } from "../public-v2.ts";
import { fixture, addAction } from "./action-fixture.ts";

const now = Date.parse("2026-10-26T10:00:00Z");
const empty = (): ActionInput => ({ events: [], posts: [], actions: [] });
function event(input: ActionInput, id: string, time: string, type: ActionInput["events"][number]["type"] = "direct_reset", action: ActionRow["action"] = "confirm") {
  const part = fixture(type);
  Object.assign(part.events[0]!, { id, created_at: time.split("/")[0] });
  Object.assign(part.posts[0]!, { id: `${id}-post`, published_at: time.split("/")[0] });
  Object.assign(part.actions[0]!, { id: `${id}-action`, event_id: id, action, time, sources: [{ postId: `${id}-post` }] });
  input.events.push(...part.events); input.posts.push(...part.posts); input.actions.push(...part.actions);
  return part.actions[0]!;
}
const read = (input: ActionInput, at = now) => projectPublicV2(input, codex, at);

test("empty and single-confirmation histories have no interval or prediction", () => {
  const input = empty();
  assert.equal(read(input).resetTime, null);
  assert.equal(read(input).announcedResetTime, null);
  event(input, "only", "2026-10-20T00:00:00Z", "bonus_credit");
  const result = read(input);
  assert.equal(result.resetTime, "2026-10-20T00:00:00Z");
  assert.equal(result.statistics.typicalInterval, null);
  assert.equal(result.predictedResetTime, null);
});

test("all kinds share confirmation intervals and prediction uses the same median", () => {
  const input = empty();
  event(input, "reset", "2026-10-01T00:00:00Z");
  event(input, "card", "2026-10-05T00:00:00Z", "reset_credit");
  event(input, "bonus", "2026-10-11T00:00:00Z", "bonus_credit");
  const result = read(input, Date.parse("2026-10-15T00:00:00Z"));
  assert.deepEqual(result.statistics.typicalInterval, { value: 5, unit: "day", sampleCount: 2 });
  assert.equal(result.resetTime, "2026-10-11T00:00:00Z");
  assert.equal(result.predictedResetTime, "2026-10-16T00:00:00.000Z");
  assert.deepEqual([result.statistics.resetsLast30Days, result.statistics.cardsLast30Days, result.statistics.bonusesLast30Days], [1, 1, 1]);
});

test("a new future announcement preserves the latest persisted confirmation without inferring on read", () => {
  const input = empty();
  event(input, "confirmed", "2026-10-10T00:00:00Z", "bonus_credit");
  event(input, "old-plan", "2026-10-20T00:00:00Z", "reset_credit", "announce");
  event(input, "new-plan", "2026-10-28T00:00:00Z", "direct_reset", "announce");
  const result = read(input);
  assert.equal(result.announcedResetTime, "2026-10-28T00:00:00Z");
  assert.equal(result.resetTime, "2026-10-10T00:00:00Z");
  const { events: _events, generatedAt: _generated, schemaVersion: _schema, ...overview } = result;
  assert.equal(platformOverviewSchema.safeParse(overview).success, true);
});

test("confirmation replaces its plan and does not borrow scheduled time", () => {
  const input = fixture();
  input.actions[0]!.action = "announce";
  input.actions[0]!.time = "2026-10-28T00:00:00Z";
  addAction(input, "confirmation", "confirm", "2026-10-25T08:00:00Z");
  assert.equal(read(input).announcedResetTime, null);
  assert.equal(read(input).resetTime, "2026-10-25T08:00:00.000Z");
});

test("progress and ordinary amendments cannot move confirmation anchors or 30-day counts", () => {
  const input = fixture();
  input.actions[0]!.time = "2026-09-01T00:00:00Z";
  addAction(input, "amend", "amend", "2026-10-25T00:00:00Z", { time: "2026-10-24T00:00:00Z" });
  addAction(input, "progress", "progress", "2026-10-26T00:00:00Z");
  assert.equal(read(input).resetTime, "2026-09-01T00:00:00Z");
  assert.equal(read(input).events[0]!.time, "2026-09-01T00:00:00Z");
  assert.equal(read(input).statistics.resetsLast30Days, 0);
});

test("overview takes the current explicitly amended plan", () => {
  const input = fixture();
  input.actions[0]!.action = "announce";
  input.actions[0]!.time = "2026-10-28";
  addAction(input, "amend", "amend", "2026-10-25T00:00:00Z", { time: "2026-10-29" });
  assert.equal(read(input).events[0]!.time, "2026-10-29");
  assert.equal(read(input).announcedResetTime, "2026-10-29");
});

test("invalidating revisions retain history but exclude every kind from times and statistics", () => {
  for (const type of ["direct_reset", "reset_credit", "bonus_credit"] as const) {
    const input = fixture(type);
    addAction(input, "cancelled", "amend", "2026-10-25T00:00:00Z", { invalidates_event: true });
    const result = read(input);
    assert.equal(result.events[0]!.status, "cancelled");
    assert.equal(result.events[0]!.updates[0]!.invalidatesEvent, true);
    assert.equal(result.resetTime, null); assert.equal(result.announcedResetTime, null);
    assert.equal(result.predictedResetTime, null); assert.equal(result.statistics.typicalInterval, null);
    assert.deepEqual([result.statistics.resetsLast30Days, result.statistics.cardsLast30Days, result.statistics.bonusesLast30Days], [0, 0, 0]);
    input.actions[1]!.invalidates_event = false;
    assert.equal(read(input).events[0]!.status, "completed");
    assert.ok(read(input).resetTime);
    input.actions[1]!.invalidates_event = true;
    input.actions[1]!.sources = [];
    assert.equal(read(input).events[0]!.status, "completed");
  }
});

test("cancelled latest events do not hide valid older plans or confirmations", () => {
  const input = empty();
  event(input, "confirmed", "2026-10-10T00:00:00Z");
  event(input, "valid-plan", "2026-10-28", "reset_credit", "announce");
  const cancelled = event(input, "cancelled", "2026-10-29", "bonus_credit", "announce");
  input.actions.push({ ...cancelled, id: "invalidation", action: "amend", invalidates_event: true, sequence: 2, time: "2026-10-30" });
  assert.equal(read(input).announcedResetTime, "2026-10-28");
  assert.equal(read(input).resetTime, "2026-10-10T00:00:00Z");
});

test("new announcements and confirmations cannot resume a cancelled event", () => {
  const input = fixture("bonus_credit");
  addAction(input, "cancel", "amend", "2026-10-11T00:00:00Z", { invalidates_event: true });
  addAction(input, "stale", "confirm", "2026-10-12T00:00:00Z");
  assert.equal(read(input).resetTime, null);
  addAction(input, "new-plan", "announce", "2026-10-13T00:00:00Z", { time: "2026-10-28" });
  assert.equal(read(input).announcedResetTime, null);
  assert.equal(read(input).resetTime, null);
  addAction(input, "fresh", "confirm", "2026-10-25T00:00:00Z");
  assert.equal(read(input).resetTime, null);
});

test("median ignores duplicates, dates, ranges, future and older-than-90-day confirmations", () => {
  const input = empty();
  event(input, "old", "2026-07-28T09:59:59Z");
  event(input, "first", "2026-10-01T00:00:00Z");
  event(input, "same", "2026-10-01T00:00:00Z", "bonus_credit");
  event(input, "second", "2026-10-05T00:00:00Z", "reset_credit");
  event(input, "date", "2026-10-06");
  event(input, "range", "2026-10-07T00:00:00Z/2026-10-07T01:00:00Z");
  event(input, "future", "2026-10-28T00:00:00Z");
  assert.deepEqual(read(input).statistics.typicalInterval, { value: 4, unit: "day", sampleCount: 1 });
  const stale = read(input, Date.parse("2027-10-26T00:00:00Z"));
  assert.equal(stale.statistics.typicalInterval, null);
  assert.equal(stale.predictedResetTime, null);
});

test("prediction stays on its Beijing day then rolls to today at midnight", () => {
  const input = empty();
  event(input, "first", "2026-10-24T00:00:00Z");
  event(input, "second", "2026-10-25T00:00:00Z", "bonus_credit");
  for (const [at, expected] of [
    ["2026-10-25T10:00:00Z", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26T10:00:00Z", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26T15:59:59Z", "2026-10-26T00:00:00.000Z"],
    ["2026-10-26T16:00:00Z", "2026-10-27"],
    ["2026-10-27T16:00:00Z", "2026-10-28"],
  ]) assert.equal(read(input, Date.parse(at!)).predictedResetTime, expected);
});

test("prediction preserves date and interval precision of the latest confirmation", () => {
  const input = empty();
  event(input, "first", "2026-10-20T00:00:00Z");
  event(input, "second", "2026-10-22T00:00:00Z", "reset_credit");
  const last = event(input, "last", "2026-10-25", "bonus_credit");
  assert.equal(read(input).predictedResetTime, "2026-10-27");
  last.time = "2026-10-25T00:00:00Z/2026-10-25T01:00:00Z";
  assert.equal(read(input).predictedResetTime, "2026-10-27T00:00:00.000Z/2026-10-27T01:00:00.000Z");
});

test("only amendments invalidate events and retired actions are rejected", () => {
  const update = read(fixture()).events[0]!.updates[0]!;
  assert.equal(eventUpdateSchema.safeParse({ ...update, invalidatesEvent: true }).success, false);
  assert.equal(actionDraftSchema.safeParse({ eventId: "event", action: "confirm", title: { en: "Confirmed" }, summary: null, time: null, invalidatesEvent: true }).success, false);
  for (const action of ["cancel", "close", "expire", "reopen"]) assert.equal(eventUpdateSchema.safeParse({ ...update, action }).success, false);
});
