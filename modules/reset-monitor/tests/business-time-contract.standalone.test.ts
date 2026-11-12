import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeCursor } from "@aihot/backend/lib/cursor";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { businessTimeSchema, normalizePublicTime, compareBusinessTime, businessTimeBoundary, isFutureBusinessTime, eventUpdateSchema, platformOverviewSchema, eventListSchema, resetSnapshotSchema, utcInstantSchema, type BusinessTime } from "../public-v2.ts";
import { projectPublicV2 } from "../backend/public-v2.ts";
import { paginatePublicV2, parsePublicV2Query, PublicV2QueryError } from "../backend/public-v2-list.ts";
import { inferredConfirmation, inferredConfirmationTime, inferenceBoundary } from "../backend/confirmation.ts";
import { resolveActionTime } from "../backend/public-v2-time.ts";
import { fixture } from "./action-fixture.ts";

test("overview instants require UTC timestamp strings and reject all object and imprecise forms", () => {
  const instant = "2026-11-02T05:42:26.123456789Z";
  const snapshot = projectPublicV2(fixture(), codex);
  assert.equal(utcInstantSchema.safeParse(instant).success, true);
  for (const key of ["resetTime", "predictedResetTime"] as const) {
    assert.equal(resetSnapshotSchema.safeParse({ ...snapshot, [key]: instant }).success, true);
    for (const value of [{ kind: "instant", at: instant }, { kind: "date", date: "2026-11-02", timeZone: "UTC" },
      { kind: "range", from: instant, through: instant }, { kind: "deadline", at: instant },
      "2026-11-02", "2026-11-02T13:42:26+08:00", "2026-02-30T00:00:00Z", "2026-11-02T05:42:26.1234567890Z"])
      assert.equal(resetSnapshotSchema.safeParse({ ...snapshot, [key]: value }).success, false);
  }
});

test("inferred confirmation uses the exact plan boundary without truncating nanoseconds", () => {
  const at = "2026-11-02T05:42:26.123456789Z";
  for (const time of [{ kind: "instant", at }, { kind: "deadline", at },
    { kind: "range", from: "2026-10-31T05:42:26Z", through: at }] as BusinessTime[])
    assert.deepEqual(inferredConfirmationTime(time), { kind: "instant", at });
  assert.deepEqual(inferredConfirmationTime({ kind: "deadline", at: "2026-11-02T13:42:26.123456789+08:00" }), { kind: "instant", at });
});

test("business time is a strict three-kind contract and rejects all old scalar forms", () => {
  const valid: BusinessTime[] = [
    { kind: "instant", at: "2026-12-31T23:59:59.123456789Z" },
    { kind: "range", from: "2026-11-02T01:00:00Z", through: "2026-11-02T01:00:00.000000001Z" },
    { kind: "deadline", at: "2026-11-02T18:00:00+08:00" },
  ];
  for (const value of valid) assert.deepEqual(businessTimeSchema.parse(value), value);
  for (const value of [
    { kind: "date", date: "2028-02-29", timeZone: "America/Los_Angeles" },
    null, "2026-11-02", "2026-11-02T05:42:26Z", "2026-11-02T01:00:00Z/2026-11-02T02:00:00Z", "11月02日 13:42:26", { kind: "unknown" },
    { kind: "date", date: "2026-02-30", timeZone: "UTC" },
    { kind: "date", date: "2026-11-02", timeZone: "Invalid/Zone" },
    { kind: "date", date: "2026-11-02", timeZone: "+08:00" },
    { kind: "date", date: "2026-11-02" },
    { kind: "instant", at: "2026-11-02T12:00:00" },
    { kind: "instant", at: "2026-11-02T12:00:00Z", date: "2026-11-02" },
    { kind: "range", from: "2026-11-02T01:00:00.000000002Z", through: "2026-11-02T01:00:00.000000001Z" },
  ]) assert.equal(businessTimeSchema.safeParse(value).success, false, JSON.stringify(value));
});

test("UTC conversion keeps nanosecond precision, interval bounds and deadline meaning", () => {
  assert.deepEqual(normalizePublicTime({ kind: "instant", at: "2027-01-01T07:59:59.123456789+08:00" }), { kind: "instant", at: "2026-12-31T23:59:59.123456789Z" });
  assert.deepEqual(normalizePublicTime({ kind: "range", from: "2026-11-02T09:00:00.123456789+08:00", through: "2026-11-02T10:00:00.987654321+08:00" }),
    { kind: "range", from: "2026-11-02T01:00:00.123456789Z", through: "2026-11-02T02:00:00.987654321Z" });
  assert.deepEqual(normalizePublicTime({ kind: "deadline", at: "2026-11-02T18:00:00+08:00" }), { kind: "deadline", at: "2026-11-02T10:00:00Z" });
});

test("business-time validation rejects unsupported precision and malformed interval endpoints without throwing", () => {
  const good = "2026-11-02T00:00:00.123456789Z";
  const invalid = ["not-a-date", "2026-02-30T00:00:00Z", "2026-11-02T00:00:00", "2026-11-02T00:00:00.1234567890Z", "2026-11-02T08:00:00.1234567890+08:00"];
  for (const at of invalid) {
    for (const value of [
      { kind: "instant", at }, { kind: "deadline", at },
      { kind: "range", from: at, through: good }, { kind: "range", from: good, through: at },
    ]) assert.doesNotThrow(() => assert.equal(businessTimeSchema.safeParse(value).success, false, JSON.stringify(value)));
  }
  for (const kind of ["instant", "deadline"] as const) {
    const value = normalizePublicTime({ kind, at: "2026-11-02T08:00:00.123456789+08:00" });
    assert.deepEqual(value, { kind, at: good });
    assert.equal(compareBusinessTime(value, { kind: "instant", at: good }), 0);
  }
});

test("sorting distinguishes sub-millisecond instants and uses interval starts", () => {
  assert.equal(businessTimeBoundary({ kind: "range", from: "2026-11-02T01:00:00Z", through: "2026-11-03T01:00:00Z" }), "2026-11-02T01:00:00Z");
  assert.equal(compareBusinessTime({ kind: "instant", at: "2026-11-02T00:00:00.000000001Z" }, { kind: "instant", at: "2026-11-02T00:00:00.000000002Z" }), -1);
});

test("nested list and snapshot validation reports invalid business times without throwing in ordering", () => {
  const snapshot = projectPublicV2(fixture(), codex);
  const first = snapshot.events[0]!;
  for (const time of [
    { kind: "instant", at: "2026-11-02T00:00:00.1234567890Z" },
    { kind: "range", from: "not-a-date", through: "2026-11-02T00:00:00Z" },
    { kind: "date", date: "2026-11-02", timeZone: "Invalid/Zone" },
  ]) {
    const events = [first, { ...first, id: "invalid-time", time }];
    assert.doesNotThrow(() => assert.equal(resetSnapshotSchema.safeParse({ ...snapshot, events }).success, false));
    assert.doesNotThrow(() => assert.equal(eventListSchema.safeParse({ list: events, pagination: { limit: null, total: 2, hasMore: false, nextCursor: null } }).success, false));
  }
});

test("future-time checks preserve sub-millisecond precision", () => {
  const at = "2026-11-02T00:00:00Z";
  assert.equal(isFutureBusinessTime({ kind: "instant", at: "2026-11-02T00:00:00.000000001Z" }, at), true);
  assert.equal(isFutureBusinessTime({ kind: "deadline", at }, at), false);
});

test("inference waits for the first full millisecond after a fractional instant or interval end", () => {
  const at = "2026-11-02T00:00:00.000000001Z", boundary = Date.parse("2026-11-02T00:00:00.001Z");
  for (const time of [
    { kind: "instant", at }, { kind: "deadline", at },
    { kind: "range", from: "2026-11-01T23:00:00Z", through: at },
  ] as BusinessTime[]) {
    assert.equal(inferenceBoundary(time), boundary);
    const input = fixture();
    Object.assign(input.actions[0]!, { action: "announce", time });
    assert.equal(inferredConfirmation(input.events[0]!, input, boundary - 1), null);
    assert.ok(inferredConfirmation(input.events[0]!, input, boundary));
  }
});

test("a normalized announcement confirms at its saved UTC boundary", () => {
  const input = fixture();
  input.actions[0]!.action = "announce";
  const plan = { kind: "instant", at: "2026-11-02T18:00:00Z" } as const;
  input.actions[0]!.time = plan;
  const boundary = Date.parse("2026-11-02T18:00:00Z");
  assert.equal(inferenceBoundary(plan), boundary);
  assert.equal(inferredConfirmation(input.events[0]!, input, boundary - 1), null);
  const confirmation = inferredConfirmation(input.events[0]!, input, boundary)!;
  assert.deepEqual(confirmation.time, { kind: "instant", at: "2026-11-02T18:00:00Z" });
  const snapshot = projectPublicV2(input, codex, boundary);
  assert.deepEqual(snapshot.announcedResetTime, plan);
  assert.deepEqual(snapshot.events[0]!.time, plan);
  assert.deepEqual(snapshot.events[0]!.updates[0]!.time, plan);
  input.actions.push(confirmation);
  const completed = projectPublicV2(input, codex, boundary);
  assert.deepEqual(completed.events[0]!.time, confirmation.time);
  assert.equal(completed.resetTime, "2026-11-02T18:00:00Z");
  assert.deepEqual(completed.events[0]!.updates.find(update => update.action === "announce")!.time, plan);
  assert.equal(eventUpdateSchema.safeParse({ ...snapshot.events[0]!.updates[0], time: "2026-11-02" }).success, false);
  const { events: _events, schemaVersion: _version, generatedAt: _generatedAt, ...overview } = snapshot;
  assert.equal(platformOverviewSchema.safeParse(overview).success, true);
  assert.equal(platformOverviewSchema.safeParse({ ...overview, announcedResetTime: "11月02日 18:00:00" }).success, false);
  assert.equal(platformOverviewSchema.safeParse({ ...overview, announcedResetTime: null }).success, false);
  assert.equal(platformOverviewSchema.safeParse({ ...overview, hasAnnouncement: false }).success, false);
});

test("calendar dates and weekdays without a source zone both infer at 18:00 UTC", () => {
  for (const text of ["11 月 12 日重置", "周四重置", "Reset on Nov 12", "Reset on Thursday"]) {
    const { time, issue } = resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: text },
      { text, published_at: "2026-11-11T12:00:00Z" });
    assert.equal(issue, null);
    assert.deepEqual(time, { kind: "instant", at: "2026-11-12T18:00:00Z" });
    const input = fixture();
    Object.assign(input.actions[0]!, { action: "announce", time });
    assert.equal(inferredConfirmation(input.events[0]!, input, Date.parse("2026-11-12T17:59:59.999Z")), null);
    const result = inferredConfirmation(input.events[0]!, input, Date.parse("2026-11-12T18:00:00Z"));
    assert.deepEqual(result?.time, { kind: "instant", at: "2026-11-12T18:00:00Z" });
  }
});

test("recognition normalizes calendar dates and preserves explicit deadlines", () => {
  const date = resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: "Nov 2, 2026 PT" },
    { text: "We will reset usage on Nov 2, 2026 PT.", published_at: "2026-10-31T12:00:00Z" });
  assert.deepEqual(date, { time: { kind: "instant", at: "2026-11-02T18:00:00Z" }, issue: null });
  const deadline = resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: "before Nov 2, 2026 at 3pm UTC" },
    { text: "We will reset usage before Nov 2, 2026 at 3pm UTC.", published_at: "2026-10-31T12:00:00Z" });
  assert.deepEqual(deadline, { time: { kind: "deadline", at: "2026-11-02T15:00:00Z" }, issue: null });
});

test("cursor pagination preserves nanosecond order and rejects pre-structure cursors", () => {
  const snapshot = projectPublicV2(fixture(), codex);
  const original = snapshot.events[0]!;
  snapshot.events = [
    { ...original, id: "z", time: { kind: "instant", at: "2026-11-02T00:00:00.000000002Z" } },
    { ...original, id: "a", time: { kind: "instant", at: "2026-11-02T00:00:00.000000001Z" } },
  ];
  const params = { from: "2026-11-01", to: "2026-11-30", limit: "1", timeZone: "UTC" };
  const first = paginatePublicV2(snapshot, parsePublicV2Query(params));
  assert.equal(first.list[0]!.id, "z");
  const second = paginatePublicV2(snapshot, parsePublicV2Query({ ...params, cursor: first.pagination.nextCursor! }));
  assert.equal(second.list[0]!.id, "a");
  assert.equal(second.pagination.hasMore, false);
  const legacy = encodeCursor("rma3", { binding: "old", at: Date.parse("2026-11-02T00:00:00Z"), id: "z" });
  assert.throws(() => paginatePublicV2(snapshot, parsePublicV2Query({ ...params, cursor: legacy })), PublicV2QueryError);
});
