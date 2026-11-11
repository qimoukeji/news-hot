import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEventExpression } from "@aihot/reset-monitor/backend/public-v2-time";
import { backendDefinition } from "../backend-definition.ts";

test("Grok uses source quantities without author timing profiles", () => {
  const source = { text: "", published_at: "2026-10-10T08:00:00Z" };
  assert.deepEqual(resolveEventExpression("soon", source, true, ""), { kind: "unknown" });
  assert.deepEqual(resolveEventExpression("in 2 hours", source, true, ""), { kind: "instant", at: "2026-10-10T10:00:00.000Z" });
  assert.equal("timing" in backendDefinition || "timingProfiles" in backendDefinition, false);
});
