import { bt } from "./business-time-fixture.ts";
import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { planActionDefaults } from "../scripts/repair-action-defaults.ts";
import { fixture, addAction, at } from "./action-fixture.ts";
import { properName } from "../backend/public-v2.ts";
import { inferredConfirmation } from "../backend/confirmation.ts";

test("repair persists the earliest valid source time and a concise multilingual audience label", () => {
  const input = fixture();
  input.posts.push({ ...input.posts[0]!, id: "earlier", published_at: "2026-10-09T09:00:00Z" });
  input.actions[0]!.sources.push({ postId: "earlier" });
  input.events[0]!.scope = { type: "unknown", note: properName("unknown All users · unknown All products") };
  const before = structuredClone(input), result = planActionDefaults(input);
  assert.deepEqual(result.after.actions[0]!.time, bt("2026-10-09T09:00:00.000Z"));
  assert.equal(result.after.events[0]!.scope!.note!.en, "Eligibility unspecified");
  assert.equal(result.after.events[0]!.scope!.note!.zh, "适用范围未明确");
  assert.equal(result.after.events[0]!.scope!.type, "unknown");
  assert.deepEqual(Object.keys(result.after.events[0]!.scope!).sort(), ["note", "type"]);
  assert.deepEqual(input, before);
  assert.deepEqual(planActionDefaults(result.after).actions, []);
  assert.deepEqual(planActionDefaults(result.after).events, []);
});

test("unknown announcement times remain empty and never trigger automatic confirmation", () => {
  const input = fixture(); input.actions[0]!.action = "announce";
  const result = planActionDefaults(input);
  assert.equal(result.after.actions[0]!.time, null);
  assert.equal(inferredConfirmation(result.after.events[0]!, result.after, Date.parse("2026-10-10T09:59:59Z")), null);
  assert.equal(inferredConfirmation(result.after.events[0]!, result.after, Date.parse("2026-10-10T09:59:59.999Z")), null);
  assert.equal(inferredConfirmation(result.after.events[0]!, result.after, Date.parse("2026-10-10T10:00:00Z")), null);
  assert.equal(inferredConfirmation(result.after.events[0]!, result.after, Date.parse("2027-01-01T00:00:00Z")), null);
  assert.deepEqual(result.actions, []);
  const dated = fixture(); dated.actions[0]!.time = bt("2026-10-11");
  assert.deepEqual(planActionDefaults(dated).after.actions[0]!.time, bt("2026-10-11"));
});

test("missing amendment times use the earliest source's next 10:00 UTC and preserve explicit times", () => {
  const input = fixture(); input.actions[0]!.action = "announce";
  addAction(input, "correction", "amend", "2026-10-10T10:00:00.001Z");
  input.posts.push({ ...input.posts[0]!, id: "earlier-correction", published_at: "2026-10-10T09:59:59.999Z" });
  input.actions[1]!.sources.push({ postId: "earlier-correction" });
  const result = planActionDefaults(input);
  assert.deepEqual(result.after.actions[1]!.time, bt("2026-10-10T10:00:00.000Z"));
  assert.equal(result.after.actions[0]!.time, null);
  assert.deepEqual(result.actions, ["correction"]);
  assert.deepEqual(planActionDefaults(result.after).actions, []);
  const explicit = structuredClone(input); explicit.actions[1]!.time = bt("2026-10-10T09:17:21.123456789Z");
  assert.deepEqual(planActionDefaults(explicit).after.actions[1]!.time, explicit.actions[1]!.time);
});

test("only an original missing-time backup can authorize correcting a saved announcement default", () => {
  const prior = fixture(); prior.actions[0]!.action = "announce";
  const saved = structuredClone(prior); saved.actions[0]!.time = bt(at);
  assert.deepEqual(planActionDefaults(saved).after.actions[0]!.time, bt(at), "an explicit timestamp may equal publication time");
  const repaired = planActionDefaults(saved, prior);
  assert.equal(repaired.after.actions[0]!.time, null);
  assert.deepEqual(planActionDefaults(repaired.after, prior).actions, []);
  saved.actions[0]!.time = bt("2026-10-11T08:00:00Z");
  assert.deepEqual(planActionDefaults(saved, prior).after.actions[0]!.time, bt("2026-10-11T08:00:00Z"), "later explicit edits are preserved");
});

test("repair refuses missing source evidence and custom scope notes", () => {
  const input = fixture(); input.actions[0]!.sources = [];
  assert.throws(() => planActionDefaults(input), /no valid source/);
  const custom = fixture(); custom.events[0]!.scope = { type: "selected_users", note: properName("unknown eligibility condition") };
  assert.throws(() => planActionDefaults(custom), /custom scope note/);
});
