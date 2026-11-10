import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmsCompletedAction, quotedInPost, quotedScopeInPost } from "../backend/evidence.ts";

const completed = (source: string) => confirmsCompletedAction(source, false, "reset_credit");
const sample = "We're giving Ultra and Team Premium users Fable resets based on how long you've subscribed:\n\n<6 mo: 1\n6–12 mo: 2\n>12 mo: 3\n\nUse them anytime by March 8.";

test("a composed audience must match every literal span without relaxing action excerpts", () => {
  const source = "Pro users receive two resets. Team users receive one reset.";
  assert.equal(quotedScopeInPost("Pro users; Team users", source), true);
  assert.equal(quotedScopeInPost("Pro users；Team users", source), true);
  assert.equal(quotedInPost("Pro users; Team users", source), false);
  for (const excerpt of ["Pro users; Enterprise users", "Pro users;", "; Team users", "Pro users;;Team users"]) {
    assert.equal(quotedScopeInPost(excerpt, source), false, excerpt);
  }
});

test("current distribution plus current redemption confirms delivery of reset credits", () => {
  for (const source of [
    sample,
    "We’re giving users resets. Use them anytime by March 8.",
    "We are issuing reset credits to eligible users. You can redeem them now.",
    "We're granting users resets. You can use these any time before March 8.",
    "How many resets do you want? We're giving users resets. Use them anytime.",
  ]) assert.equal(completed(source), true, source);
  assert.equal(confirmsCompletedAction(sample), false, "the new combination requires reset_credit kind");
  for (const kind of ["direct_reset", "bonus_credit"] as const)
    assert.equal(confirmsCompletedAction(sample, false, kind), false, kind);
});

test("present giving without present usability cannot confirm completed distribution", () => {
  for (const source of [
    "We're giving users resets.",
    "We're giving users resets soon. Use them anytime by March 8.",
    "We're giving users resets next week. Use them anytime by March 8.",
    "We're giving users resets after approval. Use them anytime.",
    "We will give users resets. Use them anytime by March 8.",
    "We would be giving users resets. Use them anytime.",
    "We are going to give users resets. Use them anytime.",
    "We're giving users resets. You will be able to use them anytime.",
    "We're giving users resets. Use them anytime after March 1.",
    "We're giving users resets. Once activated, use them anytime.",
    "We're giving users resets. Use them anytime when the rollout finishes.",
    "We're giving users resets. Use them anytime starting March 1.",
    "We're giving users resets. You can use them soon.",
    "We're giving users resets. Use them anytime. They are not yet available.",
    "We're giving users resets. Use them anytime. They aren't available yet.",
    "We're giving users resets. Use them anytime. They will only be usable next week.",
    "We're giving users resets. Use them anytime. 尚未可用。",
    "We're giving users resets. Use them anytime. 尚未可使用。",
    "We're giving users resets. You cannot use them yet.",
  ]) assert.equal(completed(source), false, source);
});

test("conditions, questions and personal reports cannot confirm current reset-credit delivery", () => {
  for (const source of [
    "If approved, we're giving users resets. Use them anytime.",
    "We're giving users resets if the rollout succeeds. Use them anytime.",
    "We're giving users resets? Use them anytime.",
    "We're giving users resets. Can you use them anytime?",
    "We're giving users resets. If enabled, you can use them anytime.",
    "We're not giving users resets. Use them anytime.",
    "We're giving users no resets. Use them anytime.",
    "We're giving users zero reset credits. Use them anytime.",
    "We're giving users 0 resets. Use them anytime.",
    "My account is giving me resets. I can use them anytime.",
    "I received my resets. I can use them anytime.",
    "我的重置卡已领取，可以随时使用。",
  ]) assert.equal(completed(source), false, source);
});

test("explicit deliveries and availability keep their existing completion evidence", () => {
  for (const source of [
    "We have issued reset credits to users.", "Reset credits are available now.", "已发放重置卡。",
  ]) assert.equal(completed(source), true, source);
  assert.equal(confirmsCompletedAction("Banked 1/2", true, "reset_credit"), true);
  assert.equal(confirmsCompletedAction("Banked 1/2", false, "reset_credit"), false);
});
