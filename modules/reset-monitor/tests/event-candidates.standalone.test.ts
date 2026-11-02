import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { openEvents } from "../backend/open-events.ts";
import { relevantFacts } from "../backend/thread-processing.ts";
import { fixture, addAction } from "./action-fixture.ts";

test("historical candidate facts and originals exclude later confirmations", async () => inMonitor(codex, async () => {
  const input = fixture("reset_credit");
  input.actions[0]!.action = "announce";
  input.posts[0]!.text = "Original banked reset promise";
  addAction(input, "future-confirmation", "confirm", "2026-10-11T10:00:00Z");
  input.posts.at(-1)!.text = "Future delivery that must not resolve an earlier post";
  const target = { ...input.posts[0]!, id: "target", text: "Banked 1/2", published_at: "2026-10-10T11:00:00Z", processing_status: "pending" as const };
  input.posts.push(target);
  const facts = await relevantFacts({ targets: [target], context: [], issues: [] }, input);
  assert.equal(facts.events[0]!.status, "announced");
  assert.deepEqual(facts.events[0]!.sourcePostIds, ["post-1"]);
  assert.deepEqual(facts.events[0]!.actions.map(action => action.id), ["action-1"]);
  assert.deepEqual(facts.context.map(post => post.id), ["post-1"]);
  assert.doesNotMatch(JSON.stringify(facts.events) + JSON.stringify(facts.context), /Future delivery/);
}));

test("an active same-author card promise survives many newer completed candidates", async () => inMonitor(codex, async () => {
  const input = fixture("reset_credit");
  input.actions[0]!.action = "announce";
  for (let index = 1; index <= 30; index++) {
    const id = `completed-${index}`, publishedAt = `2026-10-10T10:${String(index).padStart(2, "0")}:00Z`;
    input.events.push({ ...input.events[0]!, id, created_at: publishedAt });
    input.posts.push({ ...input.posts[0]!, id, published_at: publishedAt });
    input.actions.push({ ...input.actions[0]!, id, event_id: id, action: "confirm", sources: [{ postId: id }] });
  }
  const target = { ...input.posts[0]!, id: "target", text: "Banked 1/2", published_at: "2026-10-10T11:00:00Z" };
  const candidates = await openEvents(new Date(target.published_at), [], input, target);
  assert.equal(candidates.length, 24);
  assert.equal(candidates[0]!.id, "event-1");
  const facts = await relevantFacts({ targets: [target], context: [], issues: [] }, input);
  assert.equal(facts.events[0]!.id, "event-1", "the model input retains candidate priority");
}));
