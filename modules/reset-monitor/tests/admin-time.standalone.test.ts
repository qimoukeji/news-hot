import assert from "node:assert/strict";
import { test } from "node:test";
import { adminTimeFilter } from "../backend/admin-time.ts";

test("admin dates include the entire Beijing day across UTC midnight", () => {
  const matches = adminTimeFilter({ from: "2026-10-23", to: "2026-10-23" });
  assert.equal(matches("2026-10-22T15:59:59.999Z"), false);
  assert.equal(matches("2026-10-22T16:00:00.000Z"), true);
  assert.equal(matches("2026-10-23T15:59:59.999Z"), true);
  assert.equal(matches("2026-10-23T16:00:00.000Z"), false);
  assert.equal(adminTimeFilter({ from: "2026-10-23" })("2027-01-01T00:00:00Z"), true);
  assert.equal(adminTimeFilter({ to: "2026-10-23" })("2026-01-01T00:00:00Z"), true);
  assert.equal(adminTimeFilter({})("2026-01-01T00:00:00Z"), true);
});

test("admin dates reject invalid calendar dates and reversed ranges", () => {
  for (const input of [{ from: "2026-02-30" }, { to: "2026-13-01" }, { from: "bad" }, { from: "2026-10-24", to: "2026-10-23" }]) {
    assert.throws(() => adminTimeFilter(input));
  }
});
