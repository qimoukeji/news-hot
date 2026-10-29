import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEventExpression } from "@aihot/reset-monitor/backend/public-v2-time";
import { defaultProductForAuthor, scopeConflicts } from "../scope-policy.ts";
import { backendDefinition } from "../backend-definition.ts";

test("Grok uses source quantities and configured products without author timing profiles", () => {
  const source = { text: "", published_at: "2026-10-10T08:00:00Z" };
  assert.deepEqual(resolveEventExpression("soon", source, true, ""), { kind: "unknown" });
  assert.deepEqual(resolveEventExpression("in 2 hours", source, true, ""), { kind: "instant", at: "2026-10-10T10:00:00.000Z" });
  assert.equal("timing" in backendDefinition || "timingProfiles" in backendDefinition, false);
  assert.equal(defaultProductForAuthor("@BOT", backendDefinition), "Grok Bot");
  assert.equal(defaultProductForAuthor("grok", backendDefinition), "Grok 普通额度");
  assert.equal(defaultProductForAuthor("reader", backendDefinition), null);
  const scope = (product: string) => ({ audienceSource: null, plans: null, audienceZh: null, productsZh: product });
  assert.ok(scopeConflicts(scope("Grok Bot"), scope("Grok 普通额度"), backendDefinition));
  assert.equal(scopeConflicts(scope("Grok Bot 和 Grok"), scope("Grok Bot"), backendDefinition), false);
});
