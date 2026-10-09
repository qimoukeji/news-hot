import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { applyRecognition } from "../backend/assemble.ts";
import { actionEvidence } from "../backend/evidence.ts";
import type { ContextInput, Proposition, Recognition } from "../backend/recognize.ts";

interface Sample {
  id: string; publishedAt: string; text: string; context: ContextInput[];
  originalPropositions: Proposition[]; propositions: Proposition[];
  decision: "related" | "unrelated" | "event" | "review";
  expectedReview: boolean; reason: string;
}
const samples: Sample[] = JSON.parse(await readFile(new URL("./fixtures/review-posts.json", import.meta.url), "utf8"));
after(closeDb);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
});

test("the frozen review corpus contains all 17 distinct posts and explicit decision coverage", () => {
  assert.equal(samples.length, 17);
  assert.equal(new Set(samples.map((sample) => sample.id)).size, 17);
  assert.deepEqual(Object.fromEntries(["related", "unrelated", "event", "review"].map((decision) =>
    [decision, samples.filter((sample) => sample.decision === decision).length])),
  { related: 10, unrelated: 2, event: 3, review: 2 });
});

for (const sample of samples) test(`historical ${sample.id}: ${sample.reason}`, async () => {
  await sql`INSERT INTO monitor_posts (id,author,published_at,text,url,raw)
    VALUES (${sample.id},'thsottiaux',${new Date(sample.publishedAt)},${sample.text},${`https://x.com/i/status/${sample.id}`},
      ${sql.json({ context: sample.context } as never)})`;
  const recognition: Recognition = {
    relevant: sample.decision !== "unrelated", translationZh: sample.decision === "unrelated" ? null : sample.text,
    contextZh: [], outage: null, needsReview: true, propositions: structuredClone(sample.propositions),
    model: "offline-human-annotation", promptVersion: "frozen-review-policy", receiptId: 0,
  };
  const applied = await applyRecognition(sample.id, recognition);
  const [row] = await sql`SELECT recognition,activity FROM monitor_posts WHERE id=${sample.id}`;
  assert.equal(row!.recognition.needsReview, sample.expectedReview);
  assert.equal(row!.recognition.modelResult.needsReview, true, "retain the original global flag without using it to block valid claims");
  if (sample.decision === "event") {
    assert.equal(applied.eventIds.length, 1);
    const [event] = await sql`SELECT status,confirmed_at,confirmation_basis,schedule FROM monitor_events`;
    assert.equal(event!.status, "announced");
    assert.equal(event!.confirmed_at, null);
    assert.equal(event!.confirmation_basis, null);
    assert.equal(event!.schedule, null, "do not invent an exact date or inherit an unrelated Tuesday");
  } else {
    assert.equal(applied.eventIds.length, 0);
    assert.equal((await sql`SELECT id FROM monitor_events`).length, 0);
  }
  if (sample.expectedReview) assert.ok(row!.recognition.held[0].reason.length > 0);
  if (sample.decision === "related") assert.equal(row!.activity.kind, "related");
  if (sample.decision === "unrelated") assert.equal(row!.activity, null);
});

test("an ambiguous explicit Yes remains review even when its old role was uncertain", () => {
  const sample = samples.find((sample) => sample.id === "2105173168281506088")!;
  assert.equal(actionEvidence(sample.originalPropositions[0]!, sample.context), "review");
});
