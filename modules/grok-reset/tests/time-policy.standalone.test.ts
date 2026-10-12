import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, estimate } from "../time-policy.ts";
import { defaultProductForAuthor, scopeConflicts } from "../scope-policy.ts";
import { initialRangeFromArgs } from "../scripts/initialize.ts";
import { backendDefinition } from "../backend-definition.ts";

test("explicit time is verified against source words and never predicted", () => {
  const at = new Date("2026-10-10T08:00:00Z");
  const words = { precision: "exact" as const, relativeHours: null, period: null, clock: null, clockThrough: null, dayOffset: null };
  assert.equal(resolve({ ...words, clock: "12:00" }, at, "at 12:00"), null);
  assert.equal(resolve({ ...words, relativeHours: 2 }, at, "soon"), null);
  assert.equal(resolve({ ...words, relativeHours: 2 }, at, "in 2 hours")!.from, "10:00");
  assert.equal(estimate(), null);
  assert.equal(defaultProductForAuthor("@BOT", backendDefinition), "Grok Bot");
  assert.equal(defaultProductForAuthor("grok", backendDefinition), "Grok 普通额度");
  assert.equal(defaultProductForAuthor("reader", backendDefinition), null);
  const scope = (product: string) => ({ audienceSource: null, plans: null, audienceZh: null, productsZh: product });
  assert.ok(scopeConflicts(scope("Grok Bot"), scope("Grok 普通额度"), backendDefinition));
  assert.equal(scopeConflicts(scope("Grok Bot 和 Grok"), scope("Grok Bot"), backendDefinition), false);
});

test("initialization requires an explicit valid finite past range", () => {
  const now = new Date("2026-10-10T08:00:00Z");
  assert.throws(() => initialRangeFromArgs([], now));
  assert.throws(() => initialRangeFromArgs(["--since", "2026-10-10", "--until", "2026-10-11"], now));
  assert.deepEqual(initialRangeFromArgs(["--since", "2026-10-09T00:00:00Z", "--until", "2026-10-10T00:00:00Z"], now),
    { since: "2026-10-09T00:00:00Z", until: "2026-10-10T00:00:00Z" });
});
