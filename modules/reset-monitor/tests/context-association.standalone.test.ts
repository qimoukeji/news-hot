import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextEventCandidates, relatedContextEvents, uniqueContextEvent } from "../backend/context-association.ts";
import type { ActionInput, SourcePostRow } from "../actions.ts";
import { fixture } from "./action-fixture.ts";

function followup(input: ActionInput): SourcePostRow {
  const source = input.posts[0]!;
  return { ...source, id: "latest", text: "It's done.", published_at: "2026-10-11T00:00:00Z", reply_to: { postId: source.id, author: source.author } };
}

test("a verified saved ancestry selects the unique event for all three event kinds", () => {
  for (const kind of ["direct_reset", "reset_credit", "bonus_credit"] as const) {
    const input = fixture(kind), post = followup(input);
    const middle = { ...post, id: "middle", published_at: "2026-10-10T12:00:00Z" };
    input.posts.push(middle);
    post.reply_to = { postId: middle.id, author: middle.author };
    assert.equal(uniqueContextEvent(post, input, kind)?.id, input.events[0]!.id);
    assert.deepEqual(contextEventCandidates(post, input, kind).map(event => event.id), [input.events[0]!.id]);
  }
});

test("quotations resolve through saved originals while mismatched identities cannot associate", () => {
  const input = fixture(), post = followup(input), source = input.posts[0]!;
  post.reply_to = null;
  post.quoted_post = { id: source.id, author: source.author, relation: "quote", text: source.text!,
    publishedAt: new Date(source.published_at).toISOString(), url: source.url };
  assert.equal(uniqueContextEvent(post, input, "direct_reset")?.id, input.events[0]!.id);
  assert.equal(uniqueContextEvent({ ...post, quoted_post: { ...post.quoted_post, author: "forged" } }, input, "direct_reset"), null);
  assert.equal(uniqueContextEvent({ ...post, quoted_post: { ...post.quoted_post, publishedAt: "2026-10-10T09:00:00Z" } }, input, "direct_reset"), null);
});

test("explicit original-post links identify a source but similar URLs, authors and dates do not", () => {
  const input = fixture(), post = followup(input), source = input.posts[0]!;
  post.reply_to = null;
  post.text = `It's done. ${source.url}?s=20`;
  assert.equal(uniqueContextEvent(post, input, "direct_reset")?.id, input.events[0]!.id);
  for (const text of ["It's done.", `It's done. ${source.url}-other`, `It's done. https://evil.example/${source.url}`, `It's done. https://attacker@x.com/thsottiaux/status/post-1`]) {
    assert.equal(uniqueContextEvent({ ...post, text }, input, "direct_reset"), null, text);
  }
});

test("links in verified saved ancestors can identify an earlier source", () => {
  const input = fixture(), post = followup(input), source = input.posts[0]!;
  const middle = { ...source, id: "middle", text: `This event: ${source.url}`, published_at: "2026-10-10T12:00:00Z" };
  input.posts.push(middle);
  post.reply_to = { postId: middle.id, author: middle.author };
  assert.equal(uniqueContextEvent(post, input, "direct_reset")?.id, input.events[0]!.id);
});

test("multiple same-kind event relationships stay ambiguous, while kinds remain distinct", () => {
  const input = fixture(), post = followup(input), initial = input.events[0]!;
  input.events.push({ ...initial, id: "event-2" });
  input.actions.push({ ...input.actions[0]!, id: "action-2", event_id: "event-2" });
  assert.equal(contextEventCandidates(post, input, "direct_reset").length, 2);
  assert.equal(uniqueContextEvent(post, input, "direct_reset"), null);
  input.events[1]!.type = "reset_credit";
  assert.equal(uniqueContextEvent(post, input, "direct_reset")?.id, initial.id);
  assert.equal(uniqueContextEvent(post, input, "reset_credit")?.id, "event-2");
});

test("withdrawn, cancelled and source-free inferred facts never form automatic targets", () => {
  for (const excluded of ["withdrawn", "cancelled", "inferred", "missing_source", "no_initial"] as const) {
    const input = fixture(), post = followup(input), action = input.actions[0]!;
    if (excluded === "withdrawn") input.events[0]!.withdrawn = true;
    if (excluded === "cancelled") input.actions.push({ ...action, id: "cancel", sequence: 2, action: "amend", invalidates_event: true });
    if (excluded === "inferred") { action.sources = []; action.time = "2026-10-10T10:00:00Z"; }
    if (excluded === "missing_source") action.sources = [{ postId: "missing" }];
    if (excluded === "no_initial") action.action = "progress";
    assert.equal(uniqueContextEvent(post, input, "direct_reset"), null, excluded);
    assert.equal(relatedContextEvents(post, input, "direct_reset").length, ["withdrawn", "cancelled", "no_initial"].includes(excluded) ? 1 : 0, excluded);
  }
});

test("future and missing parents, cycles and empty evidence do not invent a relation", () => {
  const input = fixture(), post = followup(input);
  input.posts[0]!.published_at = "2026-10-12T00:00:00Z";
  assert.equal(uniqueContextEvent(post, input, "direct_reset"), null);
  input.posts[0]!.published_at = "2026-10-10T10:00:00Z";
  assert.equal(uniqueContextEvent({ ...post, reply_to: { postId: "missing", author: null } }, input, "direct_reset"), null);
  assert.equal(uniqueContextEvent({ ...post, reply_to: { postId: post.id, author: post.author } }, { ...input, posts: [...input.posts, post] }, "direct_reset"), null);
  input.posts[0]!.text = " ";
  assert.equal(uniqueContextEvent(post, input, "direct_reset"), null);
});
