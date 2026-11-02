import { bt } from "./business-time-fixture.ts";
import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { projectPublicV2 } from "../backend/public-v2.ts";
import { actionDraftSchema, type ActionInput, type ActionRow } from "../actions.ts";
import { eventUpdateSchema, platformOverviewSchema } from "../public-v2.ts";
import { fixture, addAction } from "./action-fixture.ts";
import { inferredConfirmation } from "../backend/confirmation.ts";

const now = Date.parse("2026-10-26T10:00:00Z");
const empty = (): ActionInput => ({ events: [], posts: [], actions: [] });
function event(input: ActionInput, id: string, time: string, type: ActionInput["events"][number]["type"] = "direct_reset", action: ActionRow["action"] = "confirm") {
  const part = fixture(type);
  Object.assign(part.events[0]!, { id, created_at: time.split("/")[0] });
  Object.assign(part.posts[0]!, { id: `${id}-post`, published_at: time.split("/")[0] });
  Object.assign(part.actions[0]!, { id: `${id}-action`, event_id: id, action, time: bt(time), sources: [{ postId: `${id}-post` }] });
  input.events.push(...part.events); input.posts.push(...part.posts); input.actions.push(...part.actions);
  return part.actions[0]!;
}
const read = (input: ActionInput, at = now) => projectPublicV2(input, codex, at);

test("empty and single-confirmation histories have no interval or prediction", () => {
  const input = empty();
  assert.deepEqual(read(input).resetTime, null);
  assert.deepEqual(read(input).announcedResetTime, null);
  event(input, "only", "2026-10-20T00:00:00Z", "bonus_credit");
  const result = read(input);
  assert.deepEqual(result.resetTime, "2026-10-20T00:00:00Z");
  assert.equal(result.statistics.typicalInterval, null);
  assert.deepEqual(result.predictedResetTime, null);
});

test("a same-post next-round unknown plan wins over the completed round and older dated plans", () => {
  const input = empty();
  const older = event(input, "older", "2026-12-01T00:00:00Z", "reset_credit", "announce");
  input.posts.find(post => post.id === "older-post")!.published_at = "2026-10-01T00:00:00Z";
  event(input, "a-completed", "2026-11-01T00:43:20Z", "reset_credit");
  event(input, "z-next", "2026-11-01T00:43:20Z", "reset_credit", "announce").time = null;
  const result = read(input);
  assert.equal(result.hasAnnouncement, true);
  assert.equal(result.announcedResetTime, null);
  assert.equal(result.events.find(event => event.id === "z-next")!.time, null);
  assert.equal(result.resetTime, "2026-11-01T00:43:20Z");
  assert.equal(older.time!.kind, "instant");
  addAction(input, "done-next", "confirm", "2026-11-01T23:27:20Z", { event_id: "z-next" });
  const completed = read(input);
  assert.equal(completed.hasAnnouncement, false);
  assert.equal(completed.announcedResetTime, null);
});

test("all kinds share confirmation intervals and prediction uses the same median", () => {
  const input = empty();
  event(input, "reset", "2026-10-01T00:00:00Z");
  event(input, "card", "2026-10-05T00:00:00Z", "reset_credit");
  event(input, "bonus", "2026-10-11T00:00:00Z", "bonus_credit");
  const result = read(input, Date.parse("2026-10-15T00:00:00Z"));
  assert.deepEqual(result.statistics.typicalInterval, { value: 5, unit: "day", sampleCount: 2 });
  assert.deepEqual(result.resetTime, "2026-10-11T00:00:00Z");
  assert.deepEqual(result.predictedResetTime, "2026-10-16T00:00:00Z");
  assert.deepEqual([result.statistics.resetsLast30Days, result.statistics.cardsLast30Days, result.statistics.bonusesLast30Days], [1, 1, 1]);
});

test("official, administrator and inferred confirmations jointly contribute across all event kinds", () => {
  const input = empty();
  event(input, "official", "2026-10-01T00:00:00Z");
  const manual = event(input, "manual", "2026-10-05T00:00:00Z", "reset_credit");
  manual.sources = [];
  event(input, "inferred", "2026-10-09T00:00:00Z/2026-10-11T00:00:00Z", "bonus_credit", "announce");
  const inferred = inferredConfirmation(input.events.find(event => event.id === "inferred")!, input, now)!;
  input.actions.push(inferred);
  const result = read(input);
  assert.deepEqual(result.statistics.typicalInterval, { value: 5, unit: "day", sampleCount: 2 });
  assert.equal(result.resetTime, "2026-10-11T00:00:00Z");
  assert.equal(result.predictedResetTime, "2026-10-16T00:00:00Z");
  assert.deepEqual([result.statistics.resetsLast30Days, result.statistics.cardsLast30Days, result.statistics.bonusesLast30Days], [1, 1, 1]);
});

test("overview instant strings preserve nanoseconds in both the confirmation and prediction", () => {
  const input = empty();
  event(input, "first", "2026-10-01T00:00:00.123456789Z");
  event(input, "latest", "2026-10-03T00:00:00.123456789Z", "reset_credit");
  const result = read(input);
  assert.equal(result.resetTime, "2026-10-03T00:00:00.123456789Z");
  assert.equal(result.predictedResetTime, "2026-10-05T00:00:00.123456789Z");
});

test("a new future announcement preserves the latest persisted confirmation without inferring on read", () => {
  const input = empty();
  event(input, "confirmed", "2026-10-10T00:00:00Z", "bonus_credit");
  event(input, "old-plan", "2026-10-20T00:00:00Z", "reset_credit", "announce");
  event(input, "new-plan", "2026-10-28T00:00:00Z", "direct_reset", "announce");
  const result = read(input);
  assert.deepEqual(result.announcedResetTime, bt("2026-10-28T00:00:00Z"));
  assert.deepEqual(result.resetTime, "2026-10-10T00:00:00Z");
  const { events: _events, generatedAt: _generated, schemaVersion: _schema, ...overview } = result;
  assert.equal(platformOverviewSchema.safeParse(overview).success, true);
});

test("confirmation replaces its plan and does not borrow scheduled time", () => {
  const input = fixture();
  input.actions[0]!.action = "announce";
  input.actions[0]!.time = bt("2026-10-28T00:00:00Z");
  addAction(input, "confirmation", "confirm", "2026-10-25T08:00:00Z");
  assert.deepEqual(read(input).announcedResetTime, null);
  assert.deepEqual(read(input).resetTime, "2026-10-25T08:00:00.000Z");
});

test("progress and ordinary amendments cannot move confirmation anchors or 30-day counts", () => {
  const input = fixture();
  input.actions[0]!.time = bt("2026-09-01T00:00:00Z");
  addAction(input, "amend", "amend", "2026-10-25T00:00:00Z", { time: bt("2026-10-24T00:00:00Z") });
  addAction(input, "progress", "progress", "2026-10-26T00:00:00Z");
  assert.deepEqual(read(input).resetTime, "2026-09-01T00:00:00Z");
  assert.deepEqual(read(input).events[0]!.time, bt("2026-09-01T00:00:00Z"));
  assert.equal(read(input).statistics.resetsLast30Days, 0);
});

test("overview takes the current explicitly rescheduled announcement", () => {
  const input = fixture();
  input.actions[0]!.action = "announce";
  input.actions[0]!.time = bt("2026-10-28");
  addAction(input, "rescheduled", "announce", "2026-10-25T00:00:00Z", { time: bt("2026-10-29") });
  assert.deepEqual(read(input).events[0]!.time, bt("2026-10-29"));
  assert.deepEqual(read(input).announcedResetTime, bt("2026-10-29"));
});

test("invalidating revisions retain history but exclude every kind from times and statistics", () => {
  for (const type of ["direct_reset", "reset_credit", "bonus_credit"] as const) {
    const input = fixture(type);
    addAction(input, "cancelled", "amend", "2026-10-25T00:00:00Z", { invalidates_event: true });
    const result = read(input);
    assert.equal(result.events[0]!.status, "cancelled");
    assert.equal(result.events[0]!.updates[0]!.invalidatesEvent, true);
    assert.deepEqual(result.resetTime, null); assert.deepEqual(result.announcedResetTime, null);
    assert.deepEqual(result.predictedResetTime, null); assert.equal(result.statistics.typicalInterval, null);
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
  input.actions.push({ ...cancelled, id: "invalidation", action: "amend", invalidates_event: true, sequence: 2, time: bt("2026-10-30") });
  assert.deepEqual(read(input).announcedResetTime, bt("2026-10-28"));
  assert.deepEqual(read(input).resetTime, "2026-10-10T00:00:00Z");
});

test("new announcements and confirmations cannot resume a cancelled event", () => {
  const input = fixture("bonus_credit");
  addAction(input, "cancel", "amend", "2026-10-11T00:00:00Z", { invalidates_event: true });
  addAction(input, "stale", "confirm", "2026-10-12T00:00:00Z");
  assert.deepEqual(read(input).resetTime, null);
  addAction(input, "new-plan", "announce", "2026-10-13T00:00:00Z", { time: bt("2026-10-28") });
  assert.deepEqual(read(input).announcedResetTime, null);
  assert.deepEqual(read(input).resetTime, null);
  addAction(input, "fresh", "confirm", "2026-10-25T00:00:00Z");
  assert.deepEqual(read(input).resetTime, null);
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
  assert.deepEqual(stale.predictedResetTime, null);
});

test("prediction remains the same point after expiry and Beijing midnight", () => {
  const input = empty();
  event(input, "first", "2026-10-24T00:00:00Z");
  event(input, "second", "2026-10-25T00:00:00Z", "bonus_credit");
  for (const [at, expected] of [
    ["2026-10-25T10:00:00Z", "2026-10-26T00:00:00Z"],
    ["2026-10-26T10:00:00Z", "2026-10-26T00:00:00Z"],
    ["2026-10-26T15:59:59Z", "2026-10-26T00:00:00Z"],
    ["2026-10-26T16:00:00Z", "2026-10-26T00:00:00Z"],
    ["2026-10-27T16:00:00Z", "2026-10-26T00:00:00Z"],
  ]) assert.deepEqual(read(input, Date.parse(at!)).predictedResetTime, expected!);
});

test("the latest non-instant confirmation makes overview instants unavailable without falling back", () => {
  const input = empty();
  event(input, "first", "2026-10-20T00:00:00Z");
  event(input, "second", "2026-10-22T00:00:00Z", "reset_credit");
  const last = event(input, "last", "2026-10-25", "bonus_credit");
  assert.equal(read(input).resetTime, null);
  assert.equal(read(input).predictedResetTime, null);
  assert.deepEqual(read(input).events[0]!.time, bt("2026-10-25"));
  last.time = bt("2026-10-25T00:00:00Z/2026-10-25T01:00:00Z");
  assert.equal(read(input).resetTime, null);
  assert.equal(read(input).predictedResetTime, null);
  assert.deepEqual(read(input).statistics.typicalInterval, { value: 2, unit: "day", sampleCount: 1 });
});

test("only amendments invalidate events and retired actions are rejected", () => {
  const update = read(fixture()).events[0]!.updates[0]!;
  assert.equal(eventUpdateSchema.safeParse({ ...update, invalidatesEvent: true }).success, false);
  assert.equal(actionDraftSchema.safeParse({ eventId: "event", action: "confirm", title: { en: "Confirmed" }, summary: null, time: null, invalidatesEvent: true }).success, false);
  for (const action of ["cancel", "close", "expire", "reopen"]) assert.equal(eventUpdateSchema.safeParse({ ...update, action }).success, false);
});
