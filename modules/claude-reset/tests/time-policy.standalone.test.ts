import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEventExpression } from "@aihot/reset-monitor/backend/public-v2-time";
import { quotaScope } from "../scope-policy.ts";

const parse = (text: string, at = "2026-10-10T12:00:00Z") => resolveEventExpression(text, { text, published_at: at }, true, text);

test("source clocks use explicit UTC/Pacific zones with daylight saving and preserve ranges", () => {
  for (const [source, expected] of [
    ["Oct 10 at 6pm UTC", "2026-10-10T18:00:00Z"],
    ["Oct 10 at 6pm PT", "2026-10-11T01:00:00Z"],
    ["Oct 10 at 6pm PST", "2026-10-11T02:00:00Z"],
    ["Dec 10 at 6pm PT", "2026-12-11T02:00:00Z"],
  ] as const) assert.deepEqual(parse(source), { kind: "instant", at: expected }, source);
  assert.deepEqual(parse("Oct 10 from 11pm to Oct 11 at 1am UTC"), { kind: "range", from: "2026-10-10T23:00:00Z", through: "2026-10-11T01:00:00Z" });
});

test("source relative quantities are converted but vague and unsupported times remain unknown", () => {
  assert.deepEqual(parse("in 2 hours"), { kind: "instant", at: "2026-10-10T14:00:00.000Z" });
  assert.deepEqual(parse("within the next 30 minutes"), { kind: "range", from: "2026-10-10T12:00:00.000Z", through: "2026-10-10T12:30:00.000Z" });
  for (const source of ["soon", "in a few hours", "in about an hour", "tonight", "Oct 12 at 25:00 UTC", "Feb 30 at 6pm UTC", "Oct 12 at 6pm XYZ"])
    assert.deepEqual(parse(source), { kind: "unknown" }, source);
});

test("yearless dates follow publication across New Year and date-only precision is retained", () => {
  assert.deepEqual(parse("Jan 2 at 6pm UTC", "2026-12-31T12:00:00Z"), { kind: "instant", at: "2027-01-02T18:00:00Z" });
  assert.deepEqual(parse("tomorrow at 6pm UTC", "2026-12-31T12:00:00Z"), { kind: "instant", at: "2027-01-01T18:00:00Z" });
  assert.deepEqual(parse("Jan 2", "2026-12-31T12:00:00Z"), { kind: "date", date: "2027-01-02", timeZone: "UTC" });
  assert.deepEqual(parse("Oct 12 at 6pm"), { kind: "instant", at: "2026-10-12T18:00:00Z" });
});

test("source clocks are literal and zero-padding does not change their meaning", () => {
  for (const clock of ["00:00", "06:00", "09:30", "18:00"]) {
    for (const sourceClock of [clock, clock.replace(/^0/, "")])
      assert.deepEqual(parse(`Oct 10 at ${sourceClock} UTC`), { kind: "instant", at: `2026-10-10T${clock}:00Z` });
  }
  assert.deepEqual(parse("Oct 10 between 06:00 and 09:30 UTC"), { kind: "range", from: "2026-10-10T06:00:00Z", through: "2026-10-10T09:30:00Z" });
});

test("Claude quota policy distinguishes five-hour, weekly and unknown scopes", () => {
  for (const source of ["5h usage", "five-hour limits", "5-hour limits", "五小时额度", "5 小時限額"])
    assert.equal(quotaScope({ audienceSource: source, productsZh: null }), "five_hour", source);
  for (const source of ["weekly limits", "week quota", "7-day usage", "周额度", "每週限額"])
    assert.equal(quotaScope({ audienceSource: null, productsZh: source }), "weekly", source);
  assert.equal(quotaScope({ audienceSource: "Max", productsZh: "Claude" }), null);
  assert.equal(quotaScope({ audienceSource: "5h and weekly limits", productsZh: null }), "five_hour+weekly");
});
