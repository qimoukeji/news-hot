import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmsCompletedAction } from "../backend/evidence.ts";

test("literal completed assertions include terse follow-ups and propagated resets", () => {
  for (const source of ["It's done.", "It is done.", "Done and dusted.", "Resets all propagated.", "It is all propagated.", "Confirmed landed across all accounts.", "It is now available.", "We have reset usage for all accounts.", "已完成额度重置。"])
    assert.equal(confirmsCompletedAction(source), true, source);
});

test("natural connectors preserve a literal completed follow-up without weakening factual boundaries", () => {
  for (const source of [
    "And it's done.", "And it’s done. See you tomorrow for some good news.", "Now, it is done.",
    "Well, done and dusted.", "So, all propagated.", "Yes, it is completed.", "But it's done.",
  ]) assert.equal(confirmsCompletedAction(source), true, source);
  for (const source of [
    "And it's not done.", "Now it will be available tomorrow.", "And if it's done, wait.",
    "And my usage was reset.", "And I am done.", "Well, I feel reset.",
    "And the website launch is done.", "And it's done?", "The reset is not done. And it's done.",
  ]) assert.equal(confirmsCompletedAction(source), false, source);
});

test("an adjacent question or your pronoun does not negate a separate completed assertion", () => {
  for (const source of [
    "What would you like with your side of reset? It's done.",
    "How is your week going? Resets all propagated.",
    "Your usage has been reset.",
    "We reset your usage. You can apply the reset and it will replenish your weekly usage.",
  ]) assert.equal(confirmsCompletedAction(source), true, source);
});

test("future and scheduled resets do not count as completed", () => {
  for (const source of [
    "We will reset usage tomorrow.", "The reset should land soon.", "The reset is coming.",
    "The reset is scheduled for tomorrow.", "The reset is scheduled.",
    "Rewards will be available tomorrow.", "将会完成额度重置。",
    "We will reset usage tomorrow. The fix is done.", "The reset is not done; the model launch is completed.",
    "We will reset usage tomorrow. It's done.",
  ]) assert.equal(confirmsCompletedAction(source), false, source);
});

test("negation, questions and conditional assertions cannot confirm a result", () => {
  for (const source of [
    "The reset is not done.", "We haven't reset usage.", "It isn't available.", "It never landed.",
    "If it is done, the reset is available.", "Unless the reset is completed, wait.",
    "Maybe resets all propagated.", "Is the reset completed?", "尚未完成额度重置。", "如果已完成重置，请重试。",
  ]) assert.equal(confirmsCompletedAction(source), false, source);
});

test("personal reset feelings and personal receipt reports cannot establish the official result", () => {
  for (const source of [
    "I feel reset.", "My usage was reset.", "My accounts have been reset.", "Feeling reset after a good night's sleep.",
    "Never slept better and feeling reseted. Brand new me and brand new usage for all ChatGPT Work and Codex users.",
    "我的额度已重置。",
  ]) assert.equal(confirmsCompletedAction(source), false, source);
});
