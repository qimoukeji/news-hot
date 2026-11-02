import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBusinessTime } from "../../../modules/reset-monitor/business-time.ts";
import { businessDate, fromTimeInput, toTimeInput } from "../../../modules/reset-monitor/web/business-time.ts";
import type { BusinessTime } from "../../../modules/reset-monitor/public-v2.ts";

test("business date rendering retains date precision and its source zone", () => {
  const day: BusinessTime = { kind: "date", date: "2026-11-02", timeZone: "America/Los_Angeles" };
  assert.equal(businessDate(day, "Asia/Shanghai"), "2026-11-02");
  assert.match(formatBusinessTime(day), /2026.*11.*02.*America\/Los_Angeles/);
  assert.doesNotMatch(formatBusinessTime(day), /18:00|00:00/);
  const at: BusinessTime = { kind: "instant", at: "2026-12-31T23:59:07.123456789Z" };
  assert.equal(businessDate(at, "Asia/Shanghai"), "2027-01-01");
  assert.equal(businessDate(at, "America/Los_Angeles"), "2026-12-31");
  assert.match(formatBusinessTime(at), /2027/);
  assert.match(formatBusinessTime({ kind: "deadline", at: at.at }, "en", "UTC"), /^Before /);
  assert.match(formatBusinessTime({ kind: "range", from: "2026-12-31T23:00:00Z", through: "2027-01-01T02:00:00Z" }, "en", "UTC"), /2026.* – .*2027/);
});

test("time selection uses an explicit zone and preserves the selected kind", () => {
  assert.deepEqual(fromTimeInput({ kind: "instant", start: "2026-11-02T13:42:26", end: "", timeZone: "Asia/Shanghai" }), { kind: "instant", at: "2026-11-02T05:42:26Z" });
  assert.deepEqual(fromTimeInput({ kind: "date", start: "2026-11-02", end: "", timeZone: "America/Los_Angeles" }), { kind: "date", date: "2026-11-02", timeZone: "America/Los_Angeles" });
  assert.deepEqual(fromTimeInput({ kind: "deadline", start: "2026-11-02T13:42:26", end: "", timeZone: "UTC" }), { kind: "deadline", at: "2026-11-02T13:42:26Z" });
  assert.deepEqual(toTimeInput({ kind: "date", date: "2026-11-02", timeZone: "Asia/Tokyo" }), { kind: "date", start: "2026-11-02", end: "", timeZone: "Asia/Tokyo" });
  assert.equal(fromTimeInput({ kind: "empty", start: "", end: "", timeZone: "UTC" }), null);
});

test("time selection rejects incomplete input, inverted ranges and DST ambiguity", () => {
  const input = { kind: "instant" as const, start: "2026-03-08T02:30:00", end: "", timeZone: "America/Los_Angeles" };
  assert.throws(() => fromTimeInput(input), /夏令时歧义/);
  assert.throws(() => fromTimeInput({ ...input, start: "2026-11-01T01:30:00" }), /夏令时歧义/);
  assert.throws(() => fromTimeInput({ ...input, start: "" }), /完整/);
  assert.throws(() => fromTimeInput({ ...input, timeZone: "Not/AZone" }), /IANA/);
  assert.throws(() => fromTimeInput({ ...input, kind: "range", timeZone: "UTC", start: "2026-11-02T10:00:00", end: "2026-11-02T09:00:00" }), /结束时间/);
});

test("changing input zones preserves instants and unedited range endpoints down to nanoseconds", () => {
  const instant: BusinessTime = { kind: "instant", at: "2026-10-22T16:30:00.123456789Z" };
  for (const timeZone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
    assert.deepEqual(fromTimeInput(toTimeInput(instant, timeZone), instant), instant);
  }
  const range: BusinessTime = { kind: "range", from: instant.at, through: "2026-10-22T17:45:00.987654321Z" };
  const input = toTimeInput(range, "UTC");
  assert.deepEqual(fromTimeInput(input, range), range);
  assert.deepEqual(fromTimeInput({ ...input, end: "2026-10-22T18:46:26" }, range), { ...range, through: "2026-10-22T18:46:26Z" });
  const repeated: BusinessTime = { kind: "instant", at: "2026-11-01T09:30:00.123456789Z" };
  assert.deepEqual(fromTimeInput(toTimeInput(repeated, "America/Los_Angeles"), repeated), repeated);
});
