import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { validateAcceptedScope } from "../backend/public-v2-scope.ts";
import { properName, type PublicV2EventRow } from "../backend/public-v2.ts";
import type { ResetEvent } from "../public-v2.ts";

const catalog = codex.publicV2!.catalog;
function row(): PublicV2EventRow {
  return { id: "synthetic", type: "direct_reset", status: "confirmed", title: "", scope: "Pro、Plus", label: "", display_label: "",
    schedule: null, estimate: null, presentation: { scopeLabel: "Pro, Plus", audienceZh: "仅付费用户", productsZh: "Codex", quotaScope: "five_hour+weekly" },
    confirmed_at: null, occurred_on: null, confirmation_basis: "source_post", withdrawn: false, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
}
const scope = (): ResetEvent["scope"] => ({ type: "paid_users", note: properName("Paid users"), productCodes: ["codex"], planCodes: ["plus", "pro"], quotaWindowCodes: ["five-hour", "weekly"] });

test("known accepted dimensions must match even when catalog codes are otherwise valid", () => {
  assert.doesNotThrow(() => validateAcceptedScope(scope(), row(), catalog));
  for (const changed of [
    { ...scope(), type: "all_users" as const }, { ...scope(), planCodes: [] }, { ...scope(), planCodes: ["free"] },
    { ...scope(), productCodes: ["chatgpt"] }, { ...scope(), quotaWindowCodes: ["weekly", "monthly"] },
  ]) assert.throws(() => validateAcceptedScope(changed, row(), catalog), /contradicts/);
  const precise = row(); precise.scope = "Pro 5x"; precise.presentation!.scopeLabel = "Pro 5x";
  assert.doesNotThrow(() => validateAcceptedScope({ ...scope(), planCodes: ["pro-5x"] }, precise, catalog));
});

test("unknown explicit restrictions need review instead of becoming empty dimensions", () => {
  for (const field of ["scopeLabel", "productsZh", "quotaScope"]) {
    const facts = row(); facts.presentation![field] = "Unlisted restriction";
    assert.throws(() => validateAcceptedScope(scope(), facts, catalog), /cannot be mapped/);
  }
  const unspecified = row(); unspecified.scope = ""; unspecified.presentation = {};
  assert.doesNotThrow(() => validateAcceptedScope({ ...scope(), type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [] }, unspecified, catalog));
});

test("selected user conditions cannot be replaced with the generic all-users note", () => {
  const facts = row(); facts.presentation!.audienceZh = "受影响的部分用户";
  assert.doesNotThrow(() => validateAcceptedScope({ ...scope(), type: "selected_users", note: properName("受影响的部分用户") }, facts, catalog));
  assert.throws(() => validateAcceptedScope({ ...scope(), type: "selected_users" }, facts, catalog), /omits/);
});
