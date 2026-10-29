import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAssociationCommands, type AssociationAddition } from "../web/association-draft.ts";
import type { ActionFact } from "../web/admin-types.ts";

const fact = (title = "Official reset", action: ActionFact["action"] = "confirm"): ActionFact => ({
  action, invalidatesEvent: false, title: { zh: title, en: title }, summary: { zh: "Current source fact" }, time: "2026-10-26T12:00:00Z",
});

test("an empty association draft sends no event, action, source or recognition changes", () => {
  assert.deepEqual(buildAssociationCommands([], [], "post"), {
    events: { create: [], update: [] }, actions: { create: [], update: [] }, sources: { add: [], remove: [] }, orders: [],
  });
});

test("one review command combines independent new events, actions, sources and removals", () => {
  const additions: AssociationAddition[] = [
    { key: "source", kind: "source", eventId: "existing", actionId: "official-confirmation" },
    { key: "progress", kind: "action", eventId: "existing", fact: fact("Delivery progress", "progress") },
    { key: "new-event-a", kind: "event", event: { type: "direct_reset", title: "  First event  ", summary: "Original summary", scope: "  Paid users  " }, fact: fact("First announcement", "announce") },
    { key: "new-event-b", kind: "event", event: { type: "bonus_credit", title: "Second event", summary: "", scope: "" }, fact: fact("Second confirmation") },
  ];
  const commands = buildAssociationCommands(additions, ["old-action"], "current-post");
  assert.deepEqual(commands.events.create, [
    { localKey: "event-new-event-a", type: "direct_reset", title: { zh: "First event" }, summary: { zh: "Original summary" },
      scope: { type: "unknown", productCodes: [], planCodes: [], quotaWindowCodes: [], note: { zh: "Paid users" } } },
    { localKey: "event-new-event-b", type: "bonus_credit", title: { zh: "Second event" }, summary: null },
  ]);
  assert.deepEqual(commands.actions.create, [
    { localKey: "progress", eventId: "existing", ...fact("Delivery progress", "progress") },
    { localKey: "new-event-a", eventKey: "event-new-event-a", ...fact("First announcement", "announce") },
    { localKey: "new-event-b", eventKey: "event-new-event-b", ...fact("Second confirmation") },
  ]);
  assert.deepEqual(commands.sources, {
    add: [{ actionId: "official-confirmation", postId: "current-post" }, { actionKey: "progress", postId: "current-post" },
      { actionKey: "new-event-a", postId: "current-post" }, { actionKey: "new-event-b", postId: "current-post" }],
    remove: [{ actionId: "old-action", postId: "current-post" }],
  });
  assert.deepEqual(commands.events.update, []); assert.deepEqual(commands.actions.update, []); assert.deepEqual(commands.orders, []);
  assert.deepEqual(Object.keys(commands).sort(), ["actions", "events", "orders", "sources"]);
});

test("adding official evidence corrects only the chosen confirmation and preserves its action ID", () => {
  const correction = fact("Officially confirmed");
  const commands = buildAssociationCommands([{ key: "upgrade", kind: "source", eventId: "event", actionId: "inferred-confirmation", fact: correction }], [], "official-post");
  assert.deepEqual(commands.actions, { create: [], update: [{ id: "inferred-confirmation", ...correction }] });
  assert.deepEqual(commands.sources, { add: [{ actionId: "inferred-confirmation", postId: "official-post" }], remove: [] });
  assert.deepEqual(commands.events, { create: [], update: [] });
});

test("whitespace-only optional event fields remain empty rather than producing scope facts", () => {
  const commands = buildAssociationCommands([{ key: "event", kind: "event", event: { type: "reset_credit", title: "  Reset card  ", summary: " \n ", scope: " \t " }, fact: fact() }], [], "post");
  assert.deepEqual(commands.events.create, [{ localKey: "event-event", type: "reset_credit", title: { zh: "Reset card" }, summary: null }]);
});

test("building commands leaves caller drafts unchanged and returns an isolated preview snapshot", () => {
  const additions: AssociationAddition[] = [
    { key: "new", kind: "action", eventId: "existing", fact: fact() },
    { key: "upgrade", kind: "source", eventId: "existing", actionId: "unsourced", fact: fact("Corrected") },
  ];
  const removed = ["old"], before = structuredClone({ additions, removed });
  const commands = buildAssociationCommands(additions, removed, "post");
  assert.deepEqual({ additions, removed }, before);
  commands.actions.create[0]!.title.zh = "Changed command";
  commands.actions.update[0]!.summary!.zh = "Changed preview";
  commands.sources.remove[0]!.actionId = "other";
  assert.deepEqual({ additions, removed }, before);
  assert.deepEqual(buildAssociationCommands([], [], "post").sources, { add: [], remove: [] });
});

test("duplicate draft keys and duplicate source commands are rejected explicitly", () => {
  const source: AssociationAddition = { key: "source", kind: "source", eventId: "event", actionId: "action" };
  assert.throws(() => buildAssociationCommands([source, { ...source, kind: "action", eventId: "event", fact: fact() }], [], "post"), /草稿标识不能重复/);
  assert.throws(() => buildAssociationCommands([source, { ...source, key: "another" }], [], "post"), /重复关联同一动作/);
  assert.throws(() => buildAssociationCommands([], ["action", "action"], "post"), /重复移除/);
  assert.throws(() => buildAssociationCommands([source], ["action"], "post"), /同时添加和移除/);
});
