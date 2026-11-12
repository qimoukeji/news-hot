import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSourceTime } from "../backend/public-v2-time.ts";

const activityAnchor = "2026-11-11T12:34:56Z";
const parse = (expression: string) => resolveSourceTime(expression,
  { activityAnchor, postText: expression, activityText: expression, deadline: false });

test("source clock intervals reject inversion without an explicit overnight date", () => {
  for (const separator of ["-", "–", "—", " to ", " through ", " until ", " and "])
    for (const end of ["08:00 UTC", "Nov 12 08:00 UTC"])
      assert.equal(parse(`Nov 12 18:00${separator}${end}`), null, `${separator}${end}`);
});

test("source clock intervals accept an explicit next day or a later end date", () => {
  for (const separator of ["-", "–", "—", " to ", " through ", " until ", " and "])
    for (const end of ["next day 08:00 UTC", "the next day at 08:00 UTC", "次日08:00 UTC", "翌日08:00 UTC", "08:00 UTC next day", "Nov 13 08:00 UTC"])
      assert.deepEqual(parse(`Nov 12 18:00${separator}${end}`)?.time,
        { kind: "range", from: "2026-11-12T18:00:00Z", through: "2026-11-13T08:00:00Z" }, `${separator}${end}`);
  assert.deepEqual(parse("Dec 31, 2026 18:00-next day 08:00 UTC")?.time,
    { kind: "range", from: "2026-12-31T18:00:00Z", through: "2027-01-01T08:00:00Z" });
  assert.deepEqual(parse("Nov 12 18:00-next day 20:00 UTC")?.time,
    { kind: "range", from: "2026-11-12T18:00:00Z", through: "2026-11-13T20:00:00Z" });
});

test("valid source ranges retain meridiem inference, equal endpoints and precise timestamps", () => {
  assert.deepEqual(parse("Nov 12 8-5pm PST")?.time,
    { kind: "range", from: "2026-11-12T16:00:00Z", through: "2026-11-13T01:00:00Z" });
  assert.deepEqual(parse("Nov 12 18:00-18:00 UTC")?.time,
    { kind: "range", from: "2026-11-12T18:00:00Z", through: "2026-11-12T18:00:00Z" });
  assert.deepEqual(parse("Nov 12 18:00:25.123456789-next day 08:00:30.987654321 UTC")?.time,
    { kind: "range", from: "2026-11-12T18:00:25.123456789Z", through: "2026-11-13T08:00:30.987654321Z" });
});
