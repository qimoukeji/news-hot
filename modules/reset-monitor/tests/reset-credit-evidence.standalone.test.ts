import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { quotedInPost, quotedScopeInPost } from "../backend/evidence.ts";

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
