import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { projectPublicV2, properName } from "../backend/public-v2.ts";
import {
  resetSnapshotSchema,
  eventUpdateSchema,
  normalizePublicTime,
} from "../public-v2.ts";
import { reduceEvent, actionDraftSchema } from "../actions.ts";
import { fixture, addAction, at } from "./action-fixture.ts";
const now = Date.parse("2026-10-15T00:00:00Z"),
  read = (input = fixture()) => projectPublicV2(input, codex, now);

test("action time preserves precision and defaults to source publication time", () => {
  for (const time of [null, "2026-10-09T01:25:00Z", "2026-10-09", "2026-10-09T01:00:00Z/2026-10-09T03:00:00Z"]) {
    const input = fixture(); input.actions[0]!.time = time;
    const update = read(input).events[0]!.updates[0]!;
    assert.equal(update.time, time ?? at);
    assert.equal(update.publishedAt, at);
    assert.equal(eventUpdateSchema.safeParse({ ...update, time: "not-a-business-time" }).success, false);
    assert.equal(eventUpdateSchema.safeParse({ ...update, time: null }).success, false);
  }
});

test("scope keeps explicit eligibility notes and never expands unknown users", () => {
  const input = fixture();
  input.events[0]!.scope = { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: properName("Only accounts created before the stated cutoff") };
  assert.deepEqual(read(input).events[0]!.scope.note, input.events[0]!.scope.note);
  input.events[0]!.scope.note = { zh: "仅限截止日前创建的账号" };
  assert.deepEqual(read(input).events, []);
  input.events[0]!.scope = { ...input.events[0]!.scope, type: "unknown", note: null };
  assert.equal(read(input).events[0]!.scope.type, "unknown");
  assert.equal(read(input).events[0]!.scope.note!.en, "All users");
});
test("initial confirmation completes without an announcement", () => {
  const snapshot = read();
  assert.equal(snapshot.events[0]!.status, "completed");
  assert.equal(snapshot.resetTime, at);
  assert.equal(snapshot.announcedResetTime, null);
  assert.equal(snapshot.statistics.resetsLast30Days, 1);
  assert.equal(snapshot.events[0]!.updates[0]!.id, "action-1");
});
test("one post supports multiple actions on the same event", () => {
  const input = fixture();
  input.actions[0]!.sequence = 2;
  input.actions.unshift({
    ...input.actions[0]!,
    id: "action-0",
    action: "announce",
    sequence: 1,
    time: "2026-10-20T00:00:00Z",
  });
  const event = read(input).events[0]!;
  assert.equal(event.status, "completed");
  assert.equal(event.time, at);
  assert.deepEqual(
    event.updates.map((update) => update.id),
    ["action-0", "action-1"],
  );
});
test("one action returns all original links without inflating statistics", () => {
  const input = fixture();
  input.posts.push({
    ...input.posts[0]!,
    id: "post-2",
    published_at: "2026-10-12T00:00:00Z",
    url: "https://example.test/second",
  });
  input.actions[0]!.sources.push({ postId: "post-2" });
  const snapshot = read(input),
    update = snapshot.events[0]!.updates[0]!;
  assert.equal(update.publishedAt, at);
  assert.deepEqual(
    update.sources.map((source) => source.postId),
    ["post-1", "post-2"],
  );
  assert.equal(update.sources[1]!.url, "https://example.test/second");
  assert.equal(snapshot.statistics.resetsLast30Days, 1);
  assert.equal(snapshot.events[0]!.updates.length, 1);
});
test("confirmation replaces planned timing and later progress cannot undo completion", () => {
  const input = fixture();
  input.actions[0]!.action = "announce";
  input.actions[0]!.time = "2026-10-20T00:00:00Z";
  assert.equal(read(input).announcedResetTime, "2026-10-20T00:00:00Z");
  addAction(input, "c", "confirm", "2026-10-11T00:00:00Z");
  addAction(input, "p", "progress", "2026-10-12T00:00:00Z", {
    time: "2026-10-21T00:00:00Z",
  });
  assert.equal(read(input).events[0]!.status, "completed");
  assert.equal(read(input).resetTime, "2026-10-11T00:00:00.000Z");
  assert.equal(read(input).announcedResetTime, null);
});
test("different progress and amendment facts stay separate", () => {
  const input = fixture();
  input.actions[0]!.action = "announce";
  addAction(input, "p1", "progress", "2026-10-11T00:00:00Z");
  addAction(input, "p2", "progress", "2026-10-12T00:00:00Z");
  addAction(input, "a1", "amend", "2026-10-13T00:00:00Z");
  assert.deepEqual(
    read(input).events[0]!.updates.map((update) => update.id),
    ["a1", "p2", "p1", "action-1"],
  );
  assert.equal(read(input).events[0]!.status, "in_progress");
});
test("official cancel and moderation withdrawal are distinct", () => {
  const input = fixture();
  addAction(input, "cancelled", "amend", "2026-10-11T00:00:00Z", { invalidates_event: true });
  addAction(input, "stale-confirm", "confirm", "2026-10-12T00:00:00Z");
  assert.equal(read(input).events[0]!.status, "cancelled");
  input.events[0]!.withdrawn = true;
  assert.deepEqual(read(input).events, []);
  input.events[0]!.withdrawn = false;
  assert.equal(read(input).events[0]!.status, "cancelled");
  addAction(input, "new-plan", "announce", "2026-10-13T00:00:00Z");
  assert.equal(read(input).events[0]!.status, "cancelled");
});
test("removing the last confirmation source recomputes accepted actions", () => {
  const input = fixture();
  input.actions[0]!.action = "announce";
  addAction(input, "c", "confirm", "2026-10-11T00:00:00Z");
  assert.equal(read(input).events[0]!.status, "completed");
  input.actions.find(action => action.id === "c")!.sources = [];
  assert.equal(read(input).events[0]!.status, "announced");
  for (const action of input.actions) action.sources = [];
  assert.equal(reduceEvent(input.events[0]!, input), null);
  assert.deepEqual(read(input).events, []);
});
test("progress alone cannot establish a public event", () => {
  const input = fixture();
  input.actions[0]!.action = "progress";
  assert.deepEqual(read(input).events, []);
});
test("bonus lifecycle uses shared completion and progress without clock changes", () => {
  const input = fixture("bonus_credit");
  assert.equal(read(input).events[0]!.status, "completed");
  for (const [index, fact] of ["Claiming closed", "Credits expired", "Claiming reopened"].entries()) {
    addAction(input, `progress-${index}`, "progress", `2026-10-${11 + index}T00:00:00Z`, { title: properName(fact) });
    assert.equal(read(input).events[0]!.status, "completed");
    assert.equal(read(input).resetTime, at);
  }
  assert.equal(
    projectPublicV2(input, codex, Date.parse("2030-01-01")).events[0]!.status,
    "completed",
  );
  assert.equal(read(input).statistics.resetsLast30Days, 0);
});
test("actual dates and UTC intervals preserve their precision", () => {
  const input = fixture();
  input.actions[0]!.time = "2026-10-09";
  assert.equal(read(input).events[0]!.time, "2026-10-09");
  input.actions[0]!.time = "2026-10-10T18:00:00+08:00";
  assert.equal(read(input).events[0]!.time, "2026-10-10T10:00:00Z");
  assert.equal(
    normalizePublicTime("2026-10-10T18:00:00+08:00/2026-10-10T19:00:00+08:00"),
    "2026-10-10T10:00:00Z/2026-10-10T11:00:00Z",
  );
});
test("partial manual text never publishes old translations", () => {
  const input = fixture();
  input.events[0]!.title = { zh: "人工标题" };
  input.events[0]!.summary = { zh: "人工摘要" };
  const event = read(input).events[0]!;
  assert.notEqual(event.title.zh, "人工标题");
  assert.equal(event.summary, null);
  input.events[0]!.title = properName("Translated title");
  assert.equal(read(input).events[0]!.title.en, "Translated title");
});
test("strict public schemas reject raw text, retired sources and incomplete languages", () => {
  const snapshot = read(),
    update = snapshot.events[0]!.updates[0]!;
  assert.equal(resetSnapshotSchema.safeParse(snapshot).success, true);
  for (const change of [
    { source: update.sources[0] },
    { action: "withdraw" },
    { action: "restore" },
    { text: "raw body" },
    { title: { en: "Only English" } },
  ])
    assert.equal(
      eventUpdateSchema.safeParse({ ...update, ...change }).success,
      false,
    );
  assert.equal(
    actionDraftSchema.safeParse({
      action: "confirm",
      eventId: null,
      title: { zh: "确认" },
      summary: null,
      time: null,
      originalText: "body",
    }).success,
    false,
  );
});

test("older added sources cannot reorder accepted event facts or expose original bodies", () => {
  const input = fixture("bonus_credit");
  addAction(input, "cancelled", "amend", "2026-10-11T00:00:00Z", { invalidates_event: true });
  input.posts.push({ ...input.posts[0]!, id: "older-source", published_at: "2026-10-01T00:00:00Z", text: "PRIVATE_OLD_SOURCE_BODY", quoted_post: { id: "q", author: "source", relation: "quote", text: "PRIVATE_QUOTED_BODY", url: "https://example.test/q", publishedAt: null } });
  input.actions[1]!.sources.push({ postId: "older-source" });
  const event = read(input).events[0]!;
  assert.equal(event.status, "cancelled");
  assert.equal(input.actions[1]!.sequence, 2);
  assert.ok(!JSON.stringify(event).includes("PRIVATE_"));
  input.actions[1]!.sequence = 0;
  assert.equal(read(input).events[0]!.status, "completed");
});
