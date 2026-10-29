import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { planActionDefaults } from "../scripts/repair-action-defaults.ts";
import { fixture, at } from "./action-fixture.ts";
import { properName } from "../backend/public-v2.ts";
import { inferredConfirmation } from "../backend/confirmation.ts";

test("repair persists the earliest valid source time and a concise multilingual audience label", () => {
  const input = fixture();
  input.posts.push({ ...input.posts[0]!, id: "earlier", published_at: "2026-10-09T09:00:00Z" });
  input.actions[0]!.sources.push({ postId: "earlier" });
  input.events[0]!.scope = { type: "unknown", productCodes: [], planCodes: ["pro"], quotaWindowCodes: ["weekly"], note: properName("unknown All users · unknown All products") };
  const before = structuredClone(input), result = planActionDefaults(input);
  assert.equal(result.after.actions[0]!.time, "2026-10-09T09:00:00.000Z");
  assert.equal(result.after.events[0]!.scope!.note!.en, "All users");
  assert.equal(result.after.events[0]!.scope!.note!.zh, "所有用户");
  assert.equal(result.after.events[0]!.scope!.type, "unknown");
  assert.deepEqual(result.after.events[0]!.scope!.planCodes, ["pro"]);
  assert.deepEqual(result.after.events[0]!.scope!.quotaWindowCodes, ["weekly"]);
  assert.deepEqual(input, before);
  assert.deepEqual(planActionDefaults(result.after).actions, []);
  assert.deepEqual(planActionDefaults(result.after).events, []);
});

test("repaired announcements wait until the Beijing publication day ends without time metadata", () => {
  const input = fixture(); input.actions[0]!.action = "announce";
  const result = planActionDefaults(input);
  assert.equal(result.after.actions[0]!.time, "2026-10-10");
  assert.equal(inferredConfirmation(result.after.events[0]!, result.after, Date.parse(at)), null);
  assert.equal(inferredConfirmation(result.after.events[0]!, result.after, Date.parse("2026-10-10T15:59:59.999Z")), null);
  const confirmation = inferredConfirmation(result.after.events[0]!, result.after, Date.parse("2026-10-10T16:00:00Z"));
  assert.equal(confirmation!.time, "2026-10-10");
  assert.deepEqual(confirmation!.sources, []);
  const dated = fixture(); dated.actions[0]!.time = "2026-10-11";
  assert.equal(planActionDefaults(dated).after.actions[0]!.time, "2026-10-11");
});

test("only an original missing-time backup can authorize correcting a saved announcement default", () => {
  const prior = fixture(); prior.actions[0]!.action = "announce";
  const saved = structuredClone(prior); saved.actions[0]!.time = at;
  assert.equal(planActionDefaults(saved).after.actions[0]!.time, at, "an explicit timestamp may equal publication time");
  const repaired = planActionDefaults(saved, prior);
  assert.equal(repaired.after.actions[0]!.time, "2026-10-10");
  assert.deepEqual(planActionDefaults(repaired.after, prior).actions, []);
  saved.actions[0]!.time = "2026-10-11T08:00:00Z";
  assert.equal(planActionDefaults(saved, prior).after.actions[0]!.time, "2026-10-11T08:00:00Z", "later explicit edits are preserved");
});

test("repair refuses missing source evidence and custom scope notes", () => {
  const input = fixture(); input.actions[0]!.sources = [];
  assert.throws(() => planActionDefaults(input), /no valid source/);
  const custom = fixture(); custom.events[0]!.scope = { type: "selected_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: properName("unknown eligibility condition") };
  assert.throws(() => planActionDefaults(custom), /custom scope note/);
});
