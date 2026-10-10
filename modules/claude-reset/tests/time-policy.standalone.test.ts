import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { inMonitor } from "@aihot/reset-monitor/backend/context";
import { resolveStatedTime, scheduleFrom, estimateFor, type StatedWords } from "@aihot/reset-monitor/backend/time";
import { backendDefinition } from "../backend-definition.ts";
import { resolve } from "../time-policy.ts";
import { quotaScope } from "../scope-policy.ts";

const postAt = new Date("2026-10-10T12:00:00Z");
const words = (patch: Partial<StatedWords> = {}): StatedWords => ({
  precision: "exact", relativeHours: null, period: null, clock: null, clockThrough: null, dayOffset: null, ...patch,
});

test("Claude converts explicit UTC, Pacific and relative hours without predicting landing", () => {
  inMonitor(backendDefinition, () => {
    for (const [input, expected] of [
      [words({ timezone: "UTC", date: "2026-10-10", clock: "18:00" }), "2026-10-10T18:00:00.000Z"],
      [words({ timezone: "PT", date: "2026-10-10", clock: "18:00" }), "2026-10-11T01:00:00.000Z"],
      [words({ timezone: "PST", date: "2026-10-10", clock: "18:00" }), "2026-10-11T02:00:00.000Z"],
      [words({ relativeHours: 2, precision: "deadline" }), "2026-10-10T14:00:00.000Z"],
    ] as const) {
      const stated = resolveStatedTime(input, postAt);
      assert.ok(stated);
      const schedule = scheduleFrom(stated);
      assert.equal(schedule.from, expected);
      assert.equal(schedule.through, expected);
      assert.match(schedule.label, /北京时间/);
      assert.equal(estimateFor({ schedule, announcedAt: postAt, model: {
        earliestPacific: "2026-10-10 16:30", latestPacific: "2026-10-10 21:30", note: "模型预测",
      } }), null);
    }
  });
});

test("Claude retains unknown time for missing timezone, named periods and vague announcements", () => {
  inMonitor(backendDefinition, () => {
    for (const input of [words(), words({ clock: "18:00" }), words({ period: "tonight" }),
      words({ timezone: "PT", period: "evening" }), words({ dayOffset: 1, precision: "date" })]) {
      assert.equal(resolveStatedTime(input, postAt), null);
    }
    assert.equal(estimateFor({ schedule: null, announcedAt: postAt }), null);
  });
});

test("Claude explicit clock ranges preserve endpoints and Pacific daylight saving", () => {
  inMonitor(backendDefinition, () => {
    const stated = resolveStatedTime(words({ timezone: "UTC", date: "2026-10-10", clock: "23:00", clockThrough: "01:00" }), postAt)!;
    const schedule = scheduleFrom(stated);
    assert.equal(schedule.from, "2026-10-10T23:00:00.000Z");
    assert.equal(schedule.through, "2026-10-11T01:00:00.000Z");
    const winter = scheduleFrom(resolveStatedTime(words({ timezone: "PT", date: "2026-12-10", clock: "18:00" }), postAt)!);
    assert.equal(winter.from, "2026-12-11T02:00:00.000Z");
  });
});

test("Claude requires literal time evidence rather than trusting model-invented clocks and durations", () => {
  for (const [source, hours] of [
    ["We will reset in two hours.", 2], ["Within an hour, usage will reset.", 1],
    ["We will reset in 30 minutes.", 0.5], ["We will reset in half an hour.", 0.5],
    ["We will reset in 2h.", 2], ["We will reset in 30m.", 0.5],
    ["We will reset in about an hour.", 1], ["We will reset in a couple of hours.", 2],
    ["额度将在两小时后重置。", 2], ["额度将在90分钟内重置。", 1.5],
  ] as const) {
    const stated = resolve(words({ relativeHours: hours, precision: "deadline" }), postAt, source);
    assert.ok(stated, source);
    assert.equal(Date.parse(scheduleFrom(stated).from), postAt.getTime() + hours * 3600_000);
  }
  for (const source of ["We will reset soon.", "We will reset in a few hours.", "The limit resets every two hours.", "We will reset in three hours."]) {
    assert.equal(resolve(words({ relativeHours: 2 }), postAt, source), null, source);
  }
  assert.equal(resolve(words({ timezone: "PT", clock: "18:00" }), postAt, "We will reset at 18:00."), null);
  assert.equal(resolve(words({ timezone: "UTC", clock: "18:00" }), postAt, "We will reset at 19:00 UTC."), null);
  assert.equal(resolve(words({ timezone: "UTC", date: "2026-10-11", clock: "18:00" }), postAt, "We will reset at 18:00 UTC."), null);
  assert.ok(resolve(words({ timezone: "PT", clock: "18:00" }), postAt, "We will reset at 6pm PT."));
  assert.ok(resolve(words({ timezone: "UTC", date: "2026-10-11", clock: "18:00" }), postAt, "We will reset tomorrow at 18:00 UTC."));
  assert.ok(resolve(words({ timezone: "PDT", date: "2026-10-12", clock: "18:00" }), postAt, "We will reset Oct 12, 2026 at 6pm PDT."));
  assert.ok(resolve(words({ timezone: "+08:00", clock: "23:00" }), postAt, "We will reset at 23:00 +0800."));
  assert.equal(resolve(words({ timezone: "UTC", clock: "25:00" }), postAt, "We will reset at 25:00 UTC."), null);
  assert.equal(resolve(words({ timezone: "UTC", date: "2026-02-30", clock: "18:00" }), postAt, "We will reset at 18:00 UTC on 2026-02-30."), null);
});

test("Claude converts zero-padded clocks without accepting a different hour", () => {
  for (const clock of ["00:00", "06:00", "09:30", "18:00"]) {
    const input = words({ timezone: "UTC", date: "2026-10-10", clock });
    for (const sourceClock of [clock, clock.replace(/^0/, "")]) {
      const stated = resolve(input, postAt, `We will reset at ${sourceClock} UTC on 2026-10-10.`);
      assert.ok(stated, sourceClock);
      assert.equal(scheduleFrom(stated).from, `2026-10-10T${clock}:00.000Z`);
    }
  }
  assert.equal(resolve(words({ timezone: "UTC", clock: "06:00" }), postAt, "We will reset at 16:00 UTC."), null);
  const range = resolve(words({ timezone: "UTC", clock: "06:00", clockThrough: "09:30" }), postAt,
    "We will reset between 06:00 and 09:30 UTC.");
  assert.ok(range);
  assert.equal(scheduleFrom(range).through, "2026-10-10T09:30:00.000Z");
});

test("Claude does not invent the year of a named date across New Year", () => {
  const at = new Date("2026-12-31T12:00:00Z");
  for (const date of ["2026-01-02", "2027-01-02", "2026-12-31", null]) {
    assert.equal(resolve(words({ timezone: "UTC", date, clock: "18:00" }), at,
      "We will reset Jan 2 at 6pm UTC."), null, String(date));
  }
  const input = words({ timezone: "UTC", date: "2027-01-02", clock: "18:00" });
  assert.equal(scheduleFrom(resolve(input, at, "We will reset Jan 2, 2027 at 6pm UTC.")!).from,
    "2027-01-02T18:00:00.000Z");
  assert.equal(scheduleFrom(resolve(words({ timezone: "UTC", date: "2027-01-01", clock: "18:00" }), at,
    "We will reset tomorrow at 6pm UTC.")!).from, "2027-01-01T18:00:00.000Z");
});

test("Claude quota policy distinguishes five-hour, weekly and unknown scopes", () => {
  for (const source of ["5h usage", "five-hour limits", "5-hour limits", "五小时额度", "5 小時限額"]) {
    assert.equal(quotaScope({ audienceSource: source, productsZh: null }), "five_hour", source);
  }
  for (const source of ["weekly limits", "week quota", "7-day usage", "周额度", "每週限額"]) {
    assert.equal(quotaScope({ audienceSource: null, productsZh: source }), "weekly", source);
  }
  assert.equal(quotaScope({ audienceSource: "Max", productsZh: "Claude" }), null);
  assert.equal(quotaScope({ audienceSource: "5h and weekly limits", productsZh: null }), "five_hour+weekly");
});
