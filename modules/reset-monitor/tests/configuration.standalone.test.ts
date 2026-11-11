import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";
import { RESET_EVENT_KINDS } from "../definition.ts";
import { buildResetMonitorPrompt } from "../prompt.ts";
import { excludeNonEvent } from "../backend/recognition-policy.ts";
import type { Proposition } from "../backend/recognize.ts";
import codex from "../../codex-reset/definition.ts";
import claude from "../../claude-reset/definition.ts";
import grok from "../../grok-reset/definition.ts";
import { excludeProposition as excludeClaude } from "../../claude-reset/recognition-policy.ts";
import { buildPrompt as buildCodexPrompt } from "../../codex-reset/prompt.ts";

const proposition = (excerpt: string, kind: Proposition["kind"] = "direct_reset"): Proposition => ({
  kind, kindExplicit: true, action: "confirm", real: true, eventId: null, excerpt, timeExcerpt: null,
});

test("the three monitors share event kinds and configure authors without credentials", () => {
  for (const definition of [codex, claude, grok]) {
    assert.equal(definition.eventKinds, RESET_EVENT_KINDS);
    assert.deepEqual(definition.authors, RESET_MONITORS[definition.monitorId as keyof typeof RESET_MONITORS].authors);
    assert.equal("collection" in definition, false, "browser definition must not carry collection policy");
  }
  const collection = RESET_MONITORS.codex.collection;
  assert.throws(() => validateResetMonitorConfig({ collection, authors: [{ handle: "one", name: "One" }, { handle: "ONE", name: "Two" }] }), /Invalid X/);
  assert.throws(() => validateResetMonitorConfig({ collection, authors: [] }), /Invalid X/);
});

test("platform collection defaults are independent and keyword validation rejects empty enabled filters", () => {
  for (const config of Object.values(RESET_MONITORS)) {
    assert.equal(config.collection.includeReplies, false);
    assert.equal(config.collection.includeSelfReplies, true);
    assert.equal(config.collection.resetOnly, false);
    assert.deepEqual(config.collection.keywords, ["reset", "resets", "resetting", "banked", "credit", "credits", "重置", "额度", "額度"]);
  }
  assert.notEqual(RESET_MONITORS.codex.collection, RESET_MONITORS.claude.collection);
  assert.notEqual(RESET_MONITORS.codex.collection.keywords, RESET_MONITORS.grok.collection.keywords);
  const base = { ...RESET_MONITORS.codex, collection: { includeReplies: true, includeSelfReplies: true, resetOnly: true, keywords: ["reset"] } };
  assert.equal(validateResetMonitorConfig(base).collection.includeReplies, true);
  for (const keywords of [[], ["reset", "RESET"], ["reset", ""], ["from:other"], ['reset" OR "all']]) {
    assert.throws(() => validateResetMonitorConfig({ ...base, collection: { ...base.collection, keywords } }), /Invalid reset monitor collection/);
  }
  assert.doesNotThrow(() => validateResetMonitorConfig({ ...base, collection: { ...base.collection, resetOnly: false, keywords: [] } }));
  assert.equal(RESET_MONITORS.grok.collection.maxPagesPerRun, 5);
  assert.equal("maxPagesPerRun" in RESET_MONITORS.codex.collection, false);
  assert.equal("maxPagesPerRun" in RESET_MONITORS.claude.collection, false);
  for (const maxPagesPerRun of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateResetMonitorConfig({ ...base, collection: { ...base.collection, maxPagesPerRun } }), /maxPagesPerRun/);
  }
});

test("prompt generation uses configured authors with one action contract", () => {
  const configured = { ...codex, authors: [{ handle: "NewOfficial", name: "New Name" }] };
  const prompt = buildCodexPrompt(configured);
  assert.match(prompt, /@NewOfficial/);
  assert.match(prompt, /New Name/);
  assert.doesNotMatch(prompt, /@thsottiaux|16:30–21:30/);
  assert.match(prompt, /bonus_credit/);
  assert.match(prompt, /OK fine/);
  assert.doesNotMatch(buildCodexPrompt(codex), /expectedLanding|translationZh|contextZh|duplicateOf|statedTime|16:30–21:30/);
  assert.match(prompt, /existingActionId/);
  assert.match(prompt, /localEventKey/);
  assert.match(prompt, /invalidatesEvent/);
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
