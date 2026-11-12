import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActionTime } from "../backend/public-v2-time.ts";
import { normalizePublicTime } from "../public-v2.ts";

const published_at = "2026-11-11T12:34:56.000Z";
function announcement(timeExcerpt: string | null, at = published_at, now = Date.parse(at)) {
  return resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt },
    { text: timeExcerpt ?? "We will reset usage soon.", published_at: at }, undefined, now);
}
const instant = (at: string) => normalizePublicTime({ kind: "instant", at });
const deadline = (at: string) => normalizePublicTime({ kind: "deadline", at });
const range = (from: string, through: string) => normalizePublicTime({ kind: "range", from, through });

test("date and weekday announcements become instants at 18:00 UTC", () => {
  for (const expression of ["11 月 12 日重置", "November 12", "2026-11-12", "周四重置", "Thursday"])
    assert.deepEqual(announcement(expression), { time: instant("2026-11-12T18:00:00Z"), issue: null }, expression);
  assert.deepEqual(announcement("November 12 PST"), { time: instant("2026-11-12T18:00:00Z"), issue: null });
  assert.deepEqual(announcement("November 12 UTC+05:30"), { time: instant("2026-11-12T18:00:00Z"), issue: null });
  assert.deepEqual(announcement("November 12 at 10am PST"), { time: instant("2026-11-12T18:00:00Z"), issue: null });
  assert.deepEqual(announcement("11月12日14:00 UTC"), { time: instant("2026-11-12T14:00:00Z"), issue: null });
  assert.deepEqual(announcement("November 12 at 14:00:25.123456789 UTC"), { time: instant("2026-11-12T14:00:25.123456789Z"), issue: null });
  assert.deepEqual(announcement("in 2 days at 9am UTC"), { time: instant("2026-11-13T09:00:00Z"), issue: null });
});

test("undated announcements choose a boundary once against first processing time", () => {
  for (const [now, expected] of [
    ["2026-11-11T17:59:59Z", "2026-11-11T18:00:00Z"],
    ["2026-11-11T18:00:00Z", "2026-11-11T18:00:00Z"],
    ["2026-11-11T18:00:00.001Z", "2026-11-11T23:59:00Z"],
    ["2026-11-13T08:00:00Z", "2026-11-11T23:59:00Z"],
  ]) assert.deepEqual(announcement(null, published_at, Date.parse(now!)), { time: instant(new Date(expected!).toISOString()), issue: null });
});

test("date deadlines and elapsed-hour deadlines keep their distinct boundaries", () => {
  for (const expression of ["11月12日结束前", "截至11月12日", "before November 12", "by 2026-11-12", "by tomorrow EOD"])
    assert.deepEqual(announcement(expression), { time: deadline("2026-11-12T18:00:00Z"), issue: null }, expression);
  for (const expression of ["两天内", "within two days"])
    assert.deepEqual(announcement(expression), { time: deadline("2026-11-13T18:00:00Z"), issue: null }, expression);
  assert.deepEqual(announcement("within 48 hours"), { time: deadline("2026-11-13T12:34:56.000Z"), issue: null });
  assert.deepEqual(announcement("48小时内"), { time: deadline("2026-11-13T12:34:56.000Z"), issue: null });
  assert.deepEqual(announcement("by November 12 at 3pm UTC"), { time: deadline("2026-11-12T15:00:00Z"), issue: null });
  assert.deepEqual(announcement("11月12日14:30 UTC前"), { time: deadline("2026-11-12T14:30:00Z"), issue: null });
});

test("range date defaults use publication for an elapsed start and 08:00 for a future start", () => {
  for (const expression of ["November 12 to November 14", "11月12日至14日", "2026-11-12 to 2026-11-14"])
    assert.deepEqual(announcement(expression), { time: range("2026-11-12T08:00:00Z", "2026-11-14T18:00:00Z"), issue: null }, expression);
  for (const expression of ["2026-11-11 to 2026-11-14", "2026-11-10 to 2026-11-14", "November 10 to November 14", "11月10日至11月14日"])
    assert.deepEqual(announcement(expression), { time: range(published_at, "2026-11-14T18:00:00Z"), issue: null }, expression);
  assert.deepEqual(announcement("November 12 at 9am UTC to November 14"),
    { time: range("2026-11-12T09:00:00Z", "2026-11-14T18:00:00Z"), issue: null });
  assert.deepEqual(announcement("November 12 to November 14 at 5pm UTC"),
    { time: range("2026-11-12T08:00:00Z", "2026-11-14T17:00:00Z"), issue: null });
  assert.deepEqual(announcement("from 08:00 to 18:00 UTC"),
    { time: range("2026-11-11T08:00:00Z", "2026-11-11T18:00:00Z"), issue: null });
  assert.deepEqual(announcement("November 12 at 8am–5pm UTC"),
    { time: range("2026-11-12T08:00:00Z", "2026-11-12T17:00:00Z"), issue: null });
  assert.deepEqual(announcement("November 10 to November 14 at 5pm UTC"),
    { time: range(published_at, "2026-11-14T17:00:00Z"), issue: null });
  assert.deepEqual(announcement("Nov 10–12"), { time: range(published_at, "2026-11-12T18:00:00Z"), issue: null });
  assert.deepEqual(announcement("Nov 10 to 14"), { time: range(published_at, "2026-11-14T18:00:00Z"), issue: null });
  assert.deepEqual(announcement("Nov 12 at 9am PST to 5pm PST"),
    { time: range("2026-11-12T17:00:00Z", "2026-11-13T01:00:00Z"), issue: null });
});

test("invalid time metadata always yields publication-date 18:00 with a review reason", () => {
  for (const expression of ["2026-02-30", "November 12 at 10am CST", "from 2026-11-14 to 2026-11-12", "11月12日至无法解析", "Nov 12 18:00–08:00 UTC", "Nov 12 at 9am UTC until Nov 31", "after some unknown time"])
    for (const now of ["2026-11-11T10:00:00Z", "2026-11-13T20:00:00Z"]) {
      const result = announcement(expression, published_at, Date.parse(now));
      assert.deepEqual(result.time, instant("2026-11-11T18:00:00Z"), expression);
      assert.ok(result.issue, expression);
    }
});

test("inverted clock ranges require an explicit next day or end date for every separator", () => {
  for (const separator of ["-", "–", "—", " - ", " to ", " through ", " until ", "至", "到"])
    for (const date of ["Nov 12", "2026-11-12", "11月12日"])
      for (const now of [published_at, "2026-11-13T20:00:00Z"]) {
        const expression = `${date} 18:00${separator}08:00 UTC`;
        const result = announcement(expression, published_at, Date.parse(now));
        assert.deepEqual(result.time, instant("2026-11-11T18:00:00Z"), expression);
        assert.ok(result.issue, expression);
      }
});

test("exact clock ranges retain explicit overnight dates and source timezone precision", () => {
  for (const separator of ["-", "–", "—", " to ", " through ", " until ", "至", "到"]) {
    for (const end of ["next day 08:00 UTC", "the next day 08:00 UTC", "次日08:00 UTC", "翌日08:00 UTC", "08:00 UTC next day", "Nov 13 08:00 UTC"])
      assert.deepEqual(announcement(`Nov 12 18:00${separator}${end}`),
        { time: range("2026-11-12T18:00:00Z", "2026-11-13T08:00:00Z"), issue: null }, `${separator}${end}`);
    assert.deepEqual(announcement(`Nov 12 08:00${separator}18:00 UTC`),
      { time: range("2026-11-12T08:00:00Z", "2026-11-12T18:00:00Z"), issue: null });
    assert.deepEqual(announcement(`Nov 12 9am${separator}5pm PST`),
      { time: range("2026-11-12T17:00:00Z", "2026-11-13T01:00:00Z"), issue: null });
  }
  assert.deepEqual(announcement("2026-11-12T18:00:00-08:00"),
    { time: instant("2026-11-13T02:00:00Z"), issue: null });
  assert.deepEqual(announcement("Nov 12 18:00 UTC-08:00"),
    { time: instant("2026-11-13T02:00:00Z"), issue: null });
  assert.deepEqual(announcement("Nov 12 18:00–next day 20:00 UTC"),
    { time: range("2026-11-12T18:00:00Z", "2026-11-13T20:00:00Z"), issue: null });
});

test("Chinese qualified weekdays use calendar weeks while English next keeps its occurrence rule", () => {
  for (const [expression, date] of [
    ["下周四", "2026-11-19"], ["下週四", "2026-11-19"], ["下星期四", "2026-11-19"],
    ["上周一", "2026-11-02"], ["上周四", "2026-11-05"],
    ["本周一", "2026-11-09"], ["这周四", "2026-11-12"], ["這週日", "2026-11-15"],
    ["next Thursday", "2026-11-12"], ["last Monday", "2026-11-09"],
  ]) assert.deepEqual(announcement(expression!), { time: instant(`${date}T18:00:00Z`), issue: null }, expression);
});

test("confirmation uses its source publication without parsing a completed or forecast time", () => {
  for (const timeExcerpt of [null, "2026-02-30", "November 12", "2026-11-10T09:00:00Z", "not in source"])
    assert.deepEqual(resolveActionTime({ action: "confirm", invalidatesEvent: false, timeExcerpt },
      { text: "We have reset usage.", published_at }), { time: instant(published_at), issue: null });
});
