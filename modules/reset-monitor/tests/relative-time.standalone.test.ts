import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEventExpression } from "../backend/public-v2-time.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";

const at = "2026-10-10T12:34:56.789Z";
const parse = (text: string, announcement = true, postText = text, publishedAt = at) =>
  resolveEventExpression(text, { text: postText, published_at: publishedAt }, announcement, postText);

test("saved next-hour announcement expressions retain the publication-anchored interval on all platforms", () => {
  for (const definition of [codex, claude, grok]) inMonitor(definition, () => {
    for (const text of ["Lands in the next hour.", "Propagating in the next hour.", "in the next hour", "within an hour", "over the next 60 minutes", "next hour"])
      assert.deepEqual(parse(text), { kind: "range", from: at, through: "2026-10-10T13:34:56.789Z" }, `${definition.monitorId}: ${text}`);
    assert.deepEqual(parse("in 2 hours"), { kind: "instant", at: "2026-10-10T14:34:56.789Z" });
    assert.deepEqual(parse("within two hours"), { kind: "range", from: at, through: "2026-10-10T14:34:56.789Z" });
  });
});

test("relative intervals use instants across DST and year boundaries without host timezone dependence", () => {
  assert.deepEqual(parse("within the next hour", true, "within the next hour PT", "2026-11-01T08:30:00Z"), {
    kind: "range", from: "2026-11-01T08:30:00.000Z", through: "2026-11-01T09:30:00.000Z",
  });
  assert.deepEqual(parse("in the next hour", true, "in the next hour", "2026-12-31T23:30:00Z"), {
    kind: "range", from: "2026-12-31T23:30:00.000Z", through: "2027-01-01T00:30:00.000Z",
  });
});

test("vague, nonnumeric and invalid quantities do not acquire invented timestamps", () => {
  for (const text of ["in a few minutes", "in a few hours", "in about an hour", "within approximately 3 hours", "soon", "shortly", "in hours", "next hours", "within 0 hours", "within 241 hours", "within -2 hours"])
    assert.deepEqual(parse(text), { kind: "unknown" }, text);
});

test("future relative promises cannot supply an already occurred result's time", () => {
  for (const text of ["in 2 hours", "within the next hour", "Propagating in the next hour."])
    assert.deepEqual(parse(text, false), { kind: "unknown" }, text);
  assert.deepEqual(parse("today at 10am UTC", false), { kind: "instant", at: "2026-10-10T10:00:00Z" });
});

test("EOD uses the source day's next-midnight boundary with explicit timezone semantics", () => {
  assert.deepEqual(parse("by EOD PST"), { kind: "range", from: at, through: "2026-10-11T08:00:00Z" });
  assert.deepEqual(parse("by end of day PT"), { kind: "range", from: at, through: "2026-10-11T07:00:00Z" });
  assert.deepEqual(parse("by EOD", true, "We will finish by EOD. All times PST."), { kind: "range", from: at, through: "2026-10-11T08:00:00Z" });
  assert.deepEqual(parse("tomorrow by EOD PST"), { kind: "range", from: at, through: "2026-10-12T08:00:00Z" });
  assert.deepEqual(parse("by EOD CST"), { kind: "unknown" });
  assert.deepEqual(parse("by EOD PST", false), { kind: "unknown" });
  assert.deepEqual(parse("yesterday by EOD PST", false), { kind: "deadline", at: "2026-10-10T08:00:00Z" });
});

test("the saved midnight follow-up retains its literal PST deadline and source calendar day", () => {
  const publishedAt = "2026-10-28T02:43:38Z", post = "Lands by midnight PST.";
  assert.deepEqual(parse("midnight PST", true, post, publishedAt), { kind: "deadline", at: "2026-10-28T08:00:00Z" });
  assert.deepEqual(parse("by midnight PST", true, post, publishedAt), { kind: "deadline", at: "2026-10-28T08:00:00Z" });
  assert.deepEqual(parse("midnight PT", true, "Lands by midnight PT.", publishedAt), { kind: "deadline", at: "2026-10-28T07:00:00Z" });
});

test("midnight and noon share numeric-clock date, timezone and DST semantics", () => {
  assert.deepEqual(parse("at midnight PST"), { kind: "instant", at: "2026-10-11T08:00:00Z" });
  assert.deepEqual(parse("at noon PST"), { kind: "instant", at: "2026-10-10T20:00:00Z" });
  assert.deepEqual(parse("noon", true, "Lands before noon PST."), { kind: "deadline", at: "2026-10-10T20:00:00Z" });
  assert.deepEqual(parse("tomorrow at noon PT"), { kind: "instant", at: "2026-10-11T19:00:00Z" });
  assert.deepEqual(parse("Oct 28 at midnight PST", true, "Oct 28 at midnight PST", "2026-10-27T20:00:00Z"), { kind: "instant", at: "2026-10-28T08:00:00Z" });
  assert.deepEqual(parse("Oct 28 at noon PST", true, "Oct 28 at noon PST", "2026-10-27T20:00:00Z"), { kind: "instant", at: "2026-10-28T20:00:00Z" });
  assert.deepEqual(parse("at midnight PT", true, "at midnight PT", "2026-11-01T20:00:00Z"), { kind: "instant", at: "2026-11-02T08:00:00Z" });
  assert.deepEqual(parse("at midnight PST", true, "at midnight PST", "2026-12-31T20:00:00Z"), { kind: "instant", at: "2027-01-01T08:00:00Z" });
  assert.deepEqual(parse("at midnight PST", false), { kind: "instant", at: "2026-10-10T08:00:00Z" });
  for (const expression of ["around midnight PST", "midnight CST", "midnight PST PDT"])
    assert.deepEqual(parse(expression), { kind: "unknown" }, expression);
});
