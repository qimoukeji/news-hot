import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { threadOutputSchema, threadRecognitionPrompt } from "../backend/recognize.ts";
import { inMonitor } from "../backend/context.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";

const title = { en: "Dot texting tips", zh: "短信技巧", "zh-Hant": "簡訊技巧", ja: "ヒント", ko: "팁", ru: "Советы", es: "Consejos" };
const post = { postId: "101", relevant: false, needsReview: false, reviewReason: null, title, summary: null, actions: [] };

test("the observed empty post-level scope is removed without changing a valid unrelated result", () => {
  const source = { posts: [{ ...post, scope: null }] };
  assert.deepEqual(threadOutputSchema(["101"]).parse(source), { posts: [post] });
  assert.equal(source.posts[0]!.scope, null, "normalization does not mutate the saved paid response");
});

test("nonempty post scopes and arbitrary extra fields remain invalid", () => {
  for (const extra of [{ scope: {} }, { scope: { type: "all_users" } }, { time: null }, { arbitrary: null }]) {
    assert.equal(threadOutputSchema(["101"]).safeParse({ posts: [{ ...post, ...extra }] }).success, false);
  }
});

test("target identity and required content remain strict after normalization", () => {
  for (const posts of [[], [{ ...post, postId: "context", scope: null }], [post, post], [{ ...post, title: { zh: "Incomplete" }, scope: null }]]) {
    assert.equal(threadOutputSchema(["101"]).safeParse({ posts }).success, false);
  }
});

test("the paid thread prompt supplies the complete schema with strict post and action boundaries", () => inMonitor(codex, () => {
  const prompt = threadRecognitionPrompt();
  const shape = JSON.parse(prompt.split("Required JSON Schema (field types, enum values and required keys are authoritative):\n")[1]!.split("\nReturn no extra keys.")[0]!);
  const post = shape.properties.posts.items;
  assert.equal(shape.additionalProperties, false);
  assert.equal(post.additionalProperties, false);
  assert.equal(post.required.includes("postId"), true);
  assert.equal(post.required.includes("reviewReason"), true);
  assert.equal("scope" in post.properties, false);
  assert.ok(post.properties.actions.items.properties.scope);
  assert.doesNotMatch(prompt, /eventScope|single-post result shape above/);
}));
