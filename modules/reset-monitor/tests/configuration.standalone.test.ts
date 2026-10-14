import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";
import { RESET_EVENT_KINDS } from "../definition.ts";
import { buildCollectionFilter } from "../collection-filter.ts";
import { buildResetMonitorPrompt } from "../prompt.ts";
import { excludeNonEvent } from "../backend/recognition-policy.ts";
import { productForAuthor, scopeConflicts, quotaScope, plansFromScopeLabel } from "../backend/scope-policy.ts";
import type { Proposition } from "../backend/recognize.ts";
import codex from "../../codex-reset/definition.ts";
import claude from "../../claude-reset/definition.ts";
import grok from "../../grok-reset/definition.ts";
import { excludeProposition as excludeClaude } from "../../claude-reset/recognition-policy.ts";
import { buildPrompt as buildCodexPrompt } from "../../codex-reset/prompt.ts";
import { backendDefinition as grokBackend } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";

const proposition = (excerpt: string, kind: Proposition["kind"] = "direct_reset"): Proposition => ({
  kind, kindExplicit: true, action: "confirm", real: true, count: 1, relatesTo: null, excerpt, excerptZh: excerpt,
  statedTime: null, timeInferred: false, expectedLanding: null,
  scope: { audienceSource: null, audienceZh: null, productsZh: null, plans: null },
});
const scope = (productsZh: string, plans: string[] | null = null) => ({ audienceSource: null, audienceZh: null, productsZh, plans });

test("the three monitors share event kinds and configure authors, plans and defaults without credentials", () => {
  for (const definition of [codex, claude, grok]) {
    assert.equal(definition.processingMode, "automatic_incremental");
    assert.equal(definition.eventKinds, RESET_EVENT_KINDS);
    assert.deepEqual(definition.authors, RESET_MONITORS[definition.monitorId as keyof typeof RESET_MONITORS].authors);
    assert.equal(buildCollectionFilter(definition.collection), undefined);
  }
  assert.equal(productForAuthor(grok.authors, "@BOT"), "Grok Bot");
  assert.equal(productForAuthor([{ handle: "Another", name: "Other", defaultProduct: "New Product" }], "another"), "New Product");
  inMonitor({ ...grokBackend, authors: [{ handle: "Another", name: "Other", defaultProduct: "New Product" }] }, () => {
    assert.equal(grokBackend.defaultProductForAuthor!("another"), "New Product");
    assert.equal(grokBackend.defaultProductForAuthor!("bot"), null);
  });
  assert.throws(() => validateResetMonitorConfig({ authors: [{ handle: "one", name: "One" }, { handle: "ONE", name: "Two" }], plans: [] }), /Invalid X/);
  assert.throws(() => validateResetMonitorConfig({ authors: [], plans: [] }), /Invalid X/);
  assert.throws(() => validateResetMonitorConfig({ ...RESET_MONITORS.codex, processingMode: "invalid" as never }), /processing mode/);
  assert.throws(() => validateResetMonitorConfig({ authors: [{ handle: "one", name: "One" }], plans: ["Plan", "plan"] }), /Invalid reset monitor plans/);
});

test("prompt generation uses the bound author list, default products, plans and author time strategy", () => {
  const configured = { ...codex, authors: [{ handle: "NewOfficial", name: "New Name", defaultProduct: "New Product" }], plans: ["Custom"] };
  const prompt = buildCodexPrompt(configured);
  assert.match(prompt, /@NewOfficial/);
  assert.match(prompt, /New Name/);
  assert.match(prompt, /New Product/);
  assert.match(prompt, /Custom/);
  assert.doesNotMatch(prompt, /@thsottiaux|16:30–21:30/);
  assert.match(prompt, /bonus_credit/);
  assert.match(prompt, /OK fine/);
  assert.match(buildCodexPrompt(codex), /16:30–21:30/);
  assert.doesNotMatch(buildResetMonitorPrompt(claude, "Claude rule"), /@thsottiaux|16:30–21:30/);
});

test("common exclusions operate on the proposition and preserve explicit one-time actions in mixed posts", () => {
  assert.match(excludeNonEvent(proposition("Limits reset automatically every day"))!, /日常/);
  assert.match(excludeNonEvent(proposition("We doubled usage limits"))!, /普通额度/);
  assert.match(excludeNonEvent(proposition("API credits are available", "bonus_credit"))!, /API/);
  assert.equal(excludeNonEvent(proposition("We applied the resets automatically")), null);
  assert.equal(excludeNonEvent(proposition("We reset Codex usage today and grant API credits separately")), null);
  assert.equal(excludeNonEvent(proposition("We reset usage today. Normally limits reset every day.")), null);
  assert.equal(excludeNonEvent(proposition("We reset usage limits this time as compensation")), null);
  assert.equal(excludeNonEvent(proposition("One-time bonus credits are now available", "bonus_credit")), null);
  assert.equal(excludeClaude(proposition("One-time bonus credit for cloud sessions is now available", "bonus_credit"), "API credits are unrelated. One-time bonus credit for cloud sessions is now available"), null);
  assert.match(excludeClaude(proposition("Bonus credits for API are available", "bonus_credit"), "Bonus credits for API are available")!, /API/);
  assert.match(excludeClaude(proposition("One-time bonus credits are available", "bonus_credit"), "One-time bonus credits are available")!, /云会话/);
  assert.equal(excludeClaude({ ...proposition("The credit applies automatically for cloud sessions", "bonus_credit"), real: false, role: "explanation" },
    "The credit applies automatically for cloud sessions", { trustedEventKinds: ["bonus_credit"] }), null);
});

test("a daily compensation policy retains its explicitly timed first card grant, not routine resets", () => {
  // Saved official post 2095651088502591861 includes a policy and today's concrete first issuance.
  const excerpt = "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today. … First one will land in ~ 3 hours.";
  assert.equal(excludeNonEvent({ ...proposition(excerpt, "reset_credit"), action: "announce", role: "action" }), null);
  assert.match(excludeNonEvent({ ...proposition("We will give one banked reset for every day you don't have access.", "reset_credit"), action: "announce", role: "action" })!, /日常/);
  assert.match(excludeNonEvent({ ...proposition("Your usage limits reset automatically every day."), real: true, role: "action" })!, /日常/);
  assert.match(excludeNonEvent({ ...proposition("Your banked reset restores usage every day automatically.", "reset_credit"), real: true, role: "action" })!, /日常/);
});

test("shared scopes distinguish explicit products and plans and preserve quota action evidence", () => {
  assert.ok(scopeConflicts(scope("Grok Bot"), scope("Grok 普通额度"), grok.productAliases));
  assert.equal(scopeConflicts(scope("Grok Bot 和 Grok"), scope("Grok Bot"), grok.productAliases), false);
  assert.ok(scopeConflicts(scope("Claude Code"), scope("Claude"), claude.productAliases));
  assert.ok(scopeConflicts(scope("Codex", ["Plus"]), scope("Codex", ["Pro"]), codex.productAliases));
  assert.equal(scopeConflicts(scope("Codex", ["Pro"]), scope("ChatGPT Work", ["pro"]), codex.productAliases), false);
  assert.equal(quotaScope(scope("Claude"), { excerpt: "We reset 5-hour usage and we doubled weekly limits", kind: "direct_reset" }), "five_hour");
  assert.equal(quotaScope(scope("Claude weekly"), { excerpt: "One-time cloud session credit", kind: "bonus_credit" }), null);
  assert.equal(plansFromScopeLabel("all paid subscriptions", codex.plans), null);
  assert.equal(plansFromScopeLabel("business accounts (all paid users)", codex.plans), null);
  assert.deepEqual(plansFromScopeLabel("Plus, Pro", codex.plans), ["Plus", "Pro"]);
  assert.deepEqual(plansFromScopeLabel("Plan A", []), ["Plan A"]);
});

test("shared filtered collection preserves announcements and configured relevant replies", () => {
  const filter = buildCollectionFilter({ mode: "announcements_and_relevant_replies", productWords: ["NewProduct"], words: ["reset"], benefitWords: ["reward"], selfPhrases: ["my quota"] })!;
  assert.equal(filter.accepts({ text: "A product release", isReply: false }), true);
  assert.equal(filter.accepts({ text: "@reader NewProduct RESET ready", isReply: true }), true);
  assert.equal(filter.accepts({ text: "My quota refreshed", isReply: true }), true);
  assert.equal(filter.accepts({ text: "Another service reward", isReply: true }), false);
  assert.deepEqual(filter.query, ["-filter:replies", 'filter:replies (reset OR reward OR "my quota")']);
  assert.equal(buildCollectionFilter({ mode: "announcements_and_relevant_replies", words: ["reset"] })!.accepts({ text: "We reset usage", isReply: true }), true);
  assert.throws(() => buildCollectionFilter({ mode: "announcements_and_relevant_replies" }), /relevance terms/);
});

test("collection signatures bind acceptance data independently of legacy query version and prose", () => {
  const configuration = { mode: "announcements_and_relevant_replies" as const, words: ["reset"], productWords: ["Product"],
    queryGroups: { query: ["-filter:replies", "filter:replies reset"], version: "paid-legacy-version", reason: "Original description" } };
  const original = buildCollectionFilter(configuration)!;
  const changed = buildCollectionFilter({ ...configuration, productWords: ["NewProduct"] })!;
  assert.equal(changed.version, original.version);
  assert.deepEqual(changed.query, original.query);
  assert.notEqual(changed.signature, original.signature);
  assert.equal(buildCollectionFilter({ ...configuration, queryGroups: { ...configuration.queryGroups, reason: "Updated description" } })!.signature, original.signature);
  assert.equal(buildCollectionFilter(original.configuration)!.signature, original.signature);
});
