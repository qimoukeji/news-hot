import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./action-fixture.ts";
import { historicalDefault, legacyEventTime, planTimeCutover, timeCutoverFingerprint, type LegacyTime, type LegacyTimeInput } from "../scripts/time-cutover.ts";

function legacy(time: LegacyTime, action: LegacyTimeInput["actions"][number]["action"] = "announce"): LegacyTimeInput {
  const input = fixture();
  return { ...input, posts: input.posts.map(post => ({ ...post, published_at: "2026-10-10T22:01:00Z" })),
    actions: input.actions.map(row => ({ ...row, action, time })) };
}
const instant = (at: string) => ({ kind: "instant", at });

test("historical announcements use UTC 18:00 for dates and missing time, independent of execution clock", () => {
  for (const time of [null, { kind: "unknown" } as const, "2026-10-10", { kind: "date", date: "2026-10-10", timeZone: "America/Los_Angeles" } as const]) {
    const input = legacy(time), before = structuredClone(input), plan = planTimeCutover(input);
    assert.deepEqual(plan.after.actions[0]!.time, instant("2026-10-10T18:00:00Z"));
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.changes[0]!.reviewPostIds, []);
    assert.deepEqual(input, before);
    assert.deepEqual(planTimeCutover(plan.after).changes, []);
  }
  assert.deepEqual(planTimeCutover(legacy("2026-10-12")).after.actions[0]!.time, instant("2026-10-12T18:00:00Z"));
});

test("date-only ranges use publication or UTC 08:00 for the start and UTC 18:00 for the end", () => {
  for (const from of ["2026-10-09", "2026-10-10", "2026-10-11"]) {
    const time = planTimeCutover(legacy({ kind: "range", from, through: "2026-10-12" })).after.actions[0]!.time;
    assert.deepEqual(time, { kind: "range", from: from <= "2026-10-10" ? "2026-10-10T22:01:00Z" : "2026-10-11T08:00:00Z", through: "2026-10-12T18:00:00Z" });
  }
  const input = legacy({ kind: "range", from: "2026-10-11T11:12:13.123456789+08:00", through: "2026-10-12" });
  assert.deepEqual(planTimeCutover(input).after.actions[0]!.time,
    { kind: "range", from: "2026-10-11T03:12:13.123456789Z", through: "2026-10-12T18:00:00Z" });
  assert.deepEqual(planTimeCutover(legacy({ kind: "range", from: "2026-10-11", through: "2026-10-12T08:12:13.000001Z" })).after.actions[0]!.time,
    { kind: "range", from: "2026-10-11T08:00:00Z", through: "2026-10-12T08:12:13.000001Z" });
});

test("legacy scalars and deadlines retain precise instants and explicit endpoint semantics", () => {
  assert.deepEqual(planTimeCutover(legacy("2026-10-11T11:12:13.123456789+08:00")).after.actions[0]!.time, instant("2026-10-11T03:12:13.123456789Z"));
  assert.deepEqual(planTimeCutover(legacy("2026-10-11/2026-10-12")).after.actions[0]!.time,
    { kind: "range", from: "2026-10-11T08:00:00Z", through: "2026-10-12T18:00:00Z" });
  assert.deepEqual(planTimeCutover(legacy({ kind: "deadline", at: "2026-10-12" })).after.actions[0]!.time,
    { kind: "deadline", at: "2026-10-12T18:00:00Z" });
  assert.deepEqual(planTimeCutover(legacy({ kind: "deadline", at: "2026-10-12T08:12:13.000001Z" })).changes, []);
});

test("official confirmations always use the earliest real source publication, including when the old time is invalid", () => {
  for (const old of [null, "2026-10-12", { kind: "instant", at: "broken" } as const, { kind: "deadline", at: "2026-10-12T18:00:00Z" } as const]) {
    const input = legacy(old, "confirm");
    input.posts.push({ ...input.posts[0]!, id: "earlier", published_at: "2026-10-09T08:12:13.123456789Z" });
    input.actions[0]!.sources.push({ postId: "earlier" });
    const plan = planTimeCutover(input);
    assert.deepEqual(plan.after.actions[0]!.time, instant("2026-10-09T08:12:13.123456789Z"));
    assert.deepEqual(plan.changes[0]!.reviewPostIds, []);
  }
});

test("equivalent UTC confirmation spellings do not create review work but offset timestamps are normalized", () => {
  const stored = { kind: "instant", at: "2026-10-10T22:01:00.000Z" } as const;
  const same = planTimeCutover(legacy(stored, "confirm"));
  assert.deepEqual(same.changes, []);
  assert.deepEqual(same.after.actions[0]!.time, stored);
  const offset = planTimeCutover(legacy({ kind: "instant", at: "2026-10-11T06:01:00+08:00" }, "confirm"));
  assert.deepEqual(offset.changes[0]!.after, instant("2026-10-10T22:01:00Z"));
});

test("saved source-free precise confirmations are immutable under historical 10:00 and current 18:00 cutoffs", () => {
  for (const at of ["2026-11-02T10:00:00Z", "2026-11-02T18:00:00Z", "2026-11-02T10:00:00.123456789Z"]) {
    for (const id of ["administrator-confirmation", "inferred-historical-plan"]) {
      const input = legacy({ kind: "instant", at }, "confirm");
      Object.assign(input.actions[0]!, { id, sources: [], created_at: at });
      const plan = planTimeCutover(input);
      assert.deepEqual(plan.problems, []);
      assert.deepEqual(plan.changes, []);
      assert.deepEqual(plan.after.actions[0], input.actions[0]);
    }
  }
});

test("non-instant source-free confirmations become a single boundary and missing source-free times block apply", () => {
  const input = legacy({ kind: "range", from: "2026-10-11T08:00:00Z", through: "2026-10-12T18:00:00Z" }, "confirm");
  input.actions[0]!.sources = [];
  assert.deepEqual(planTimeCutover(input).after.actions[0]!.time, instant("2026-10-12T18:00:00Z"));
  for (const time of [null, { kind: "instant", at: "bad" } as const]) {
    input.actions[0]!.time = time;
    assert.equal(planTimeCutover(input).problems.length, 1);
  }
});

test("progress and amendments retain explicit times but use their respective defaults for missing and date-only values", () => {
  for (const time of [null, "2026-10-12", { kind: "date", date: "2026-10-12" } as const]) {
    assert.deepEqual(planTimeCutover(legacy(time, "progress")).after.actions[0]!.time, instant("2026-10-10T22:01:00Z"));
    assert.deepEqual(planTimeCutover(legacy(time, "amend")).after.actions[0]!.time, instant("2026-10-11T10:00:00Z"));
  }
  assert.deepEqual(historicalDefault("amend", "2026-10-10T10:00:00Z"), instant("2026-10-10T10:00:00Z"));
  for (const action of ["amend", "progress"] as const) {
    const input = legacy({ kind: "instant", at: "2026-10-09T08:12:13.123456789Z" }, action);
    assert.deepEqual(planTimeCutover(input).changes, []);
  }
});

test("invalid calendars, zones, malformed timestamps and inverted ranges retain the action with fallback and source review", () => {
  const times: LegacyTime[] = ["2026-02-30", { kind: "date", date: "2026-10-10", timeZone: "Unsupported/Zone" },
    { kind: "range", from: "2026-10-12", through: "2026-10-11" }, { kind: "instant", at: "2026-10-10T25:00:00Z" }];
  for (const time of times) {
    const input = legacy(time, "amend");
    input.actions[0]!.invalidates_event = true;
    const plan = planTimeCutover(input), original = input.actions[0]!, saved = plan.after.actions[0]!;
    assert.deepEqual(saved.time, instant("2026-10-10T18:00:00Z"));
    assert.deepEqual(plan.changes[0]!.reviewPostIds, ["post-1"]);
    assert.match(plan.changes[0]!.reason, /requires review/);
    assert.deepEqual(plan.problems, []);
    assert.deepEqual([saved.id, saved.sequence, saved.sources, saved.invalidates_event], [original.id, original.sequence, original.sources, original.invalidates_event]);
  }
});

test("missing and context-only source evidence is inventoried as a blocking problem", () => {
  for (const contextOnly of [false, true]) {
    const input = legacy(null);
    if (contextOnly) input.posts[0]!.context_only = true;
    else input.posts = [];
    assert.equal(planTimeCutover(input).problems.length, 1);
  }
});

test("time cutover fingerprints include original time, state and notification data", () => {
  const input = { time: null, state: { revision: 7 }, notifications: [{ id: "sent", payload: { event: "old" } }] };
  const before = timeCutoverFingerprint(input);
  for (const changed of [{ ...input, time: "2026-10-10" }, { ...input, state: { revision: 8 } }, { ...input, notifications: [] }])
    assert.notEqual(timeCutoverFingerprint(changed), before);
});

test("legacy projection keeps manually confirmed actions even when their former inference identity was invalidated", () => {
  const input = legacy({ kind: "instant", at: "2026-10-11T10:00:00Z" });
  input.actions[0]!.action = "announce";
  const confirmation = { ...input.actions[0]!, id: "inferred-reviewed", sequence: 2, action: "confirm" as const,
    time: { kind: "instant" as const, at: "2026-10-11T12:00:00Z" }, sources: [] };
  input.actions.push(confirmation);
  input.invalidatedInferenceIds = new Set([confirmation.id]);
  assert.equal(legacyEventTime(input.events[0]!.id, input)?.status, "announced");
  input.manualConfirmationIds = new Set([confirmation.id]);
  const projected = legacyEventTime(input.events[0]!.id, input);
  assert.equal(projected?.status, "completed");
  assert.deepEqual(projected?.time, confirmation.time);
  const normalized = planTimeCutover(input).after;
  assert.deepEqual(normalized.manualConfirmationIds, input.manualConfirmationIds);
  assert.deepEqual(normalized.invalidatedInferenceIds, input.invalidatedInferenceIds);
  assert.deepEqual(normalized.standaloneFollowupIds, input.standaloneFollowupIds);
});
