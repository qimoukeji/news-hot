import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { uniqueRoundContextEvent } from "../backend/context-association.ts";
import { fixture, addAction } from "./action-fixture.ts";

function rounds() {
  const input = fixture("reset_credit");
  input.actions[0]!.action = "announce";
  addAction(input, "first-delivery", "confirm", "2026-10-11T10:00:00Z", { time: { kind: "instant", at: "2026-10-11T10:00:00Z" } });
  input.posts[1]!.text = "Banked 1/2";
  input.events.push({ ...input.events[0]!, id: "round-2", created_at: "2026-10-11T10:00:00Z" });
  input.actions.push({ ...input.actions[1]!, id: "next-announcement", event_id: "round-2", action: "announce", time: { kind: "instant", at: "2026-10-11T18:00:00Z" }, sequence: 1 });
  const post = { ...input.posts[0]!, id: "final-delivery", text: "Day 28/ Banked 2/2", published_at: "2026-10-12T10:00:00Z",
    reply_to: { postId: input.posts[1]!.id, author: "thsottiaux" } };
  input.posts.push(post);
  return { input, post };
}

test("a saved numbered bridge must prove a completed predecessor and the unique pending round", () => {
  const { input, post } = rounds();
  assert.equal(uniqueRoundContextEvent(post, input, "reset_credit")!.id, "round-2");
  input.actions[1]!.sources = [];
  assert.equal(uniqueRoundContextEvent(post, input, "reset_credit"), null);
});

test("round disambiguation rejects withdrawal, cancellation, changed totals, skipped rounds and cross-author bridges", () => {
  for (const mutation of [
    ({ input }: ReturnType<typeof rounds>) => { input.events[0]!.withdrawn = true; },
    ({ input }: ReturnType<typeof rounds>) => { input.events[1]!.withdrawn = true; },
    ({ input }: ReturnType<typeof rounds>) => { addAction(input, "cancel", "amend", "2026-10-11T11:00:00Z", { invalidates_event: true }); },
    ({ post }: ReturnType<typeof rounds>) => { post.text = "Banked 2/3"; },
    ({ post }: ReturnType<typeof rounds>) => { post.text = "Banked 3/3"; },
    ({ post }: ReturnType<typeof rounds>) => { post.author = "another-official"; },
  ]) {
    const value = rounds(); mutation(value);
    assert.equal(uniqueRoundContextEvent(value.post, value.input, "reset_credit"), null);
  }
});
