import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { fixture, at } from "./action-fixture.ts";
import { projectPublicV2 } from "../backend/public-v2.ts";
import { completeStandardScopeLabel, defaultScopeLabel } from "../backend/scope-labels.ts";
import { resetSnapshotSchema } from "../public-v2.ts";
import { languages } from "../actions.ts";

for (const definition of [codex, claude, grok]) test(`${definition.monitorId}: publication preserves unknown scope without asserting the historical default label`, t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Publication cannot call a model"); });
  const input = fixture();
  input.events[0]!.title = { zh: "人工创建的额度事件" };
  input.actions[0]!.title = { zh: "人工确认额度已生效" };
  const historicalScope = { type: "unknown" as const, productCodes: ["old-product"], planCodes: ["old-plan"], quotaWindowCodes: ["old-cycle"], note: { zh: "所有用户" } };
  input.events[0]!.scope = historicalScope;
  const before = structuredClone(input), snapshot = projectPublicV2(input, definition, Date.parse(at));
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]!.scope.type, "unknown");
  assert.deepEqual(Object.keys(snapshot.events[0]!.scope).sort(), ["note", "type"]);
  assert.equal(snapshot.events[0]!.scope.note!.en, "Eligibility unspecified");
  assert.equal(resetSnapshotSchema.safeParse(snapshot).success, true);
  assert.deepEqual(input, before, "read projection must not persist synthesized translations");
});

test("fixed audience labels fill only missing languages", () => {
  assert.equal(defaultScopeLabel("unknown").en, "Eligibility unspecified");
  assert.equal(defaultScopeLabel("selected_users").en, "Eligibility unspecified");
  for (const zh of ["所有用户", "付费用户"]) {
    const source = { zh }, note = completeStandardScopeLabel(source)!;
    assert.ok(note, zh);
    assert.equal(note.zh, zh);
    assert.ok(languages.every(language => !!note[language].trim()), zh);
    assert.deepEqual(source, { zh });
  }
  assert.equal(completeStandardScopeLabel({ zh: "  所有用户  " })!.zh, "  所有用户  ");
  assert.equal(completeStandardScopeLabel({ zh: "付费用户", en: "Paid users" })!.en, "Paid users");
  assert.equal(completeStandardScopeLabel(null), null);
  assert.equal(completeStandardScopeLabel({ zh: " " }), null);
});

test("custom eligibility, contradictory partial translations and selected-user notes are not generalized", () => {
  for (const note of [{ zh: "仅限截止日前注册的用户" }, { zh: "所有用户", en: "Paid users" }, { zh: "所有用户 · unknown 所有产品", en: "Paid users · unknown All products" }]) {
    assert.equal(completeStandardScopeLabel(note), null);
    const input = fixture();
    input.events[0]!.scope = { type: "unknown", note };
    assert.equal(projectPublicV2(input, codex, Date.parse(at)).events.length, 0);
  }
  const input = fixture();
  input.events[0]!.scope = { type: "selected_users", note: { zh: "所有用户" } };
  assert.equal(projectPublicV2(input, codex, Date.parse(at)).events.length, 0);
});
