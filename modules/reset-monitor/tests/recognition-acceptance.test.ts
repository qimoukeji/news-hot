import { bt } from "./business-time-fixture.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { applyOfflineRecognition, applyRecognition } from "../backend/assemble.ts";
import { storeCollectedPost, sourcePost, loadActionInput } from "../backend/action-store.ts";
import type { ActionRecognitionBody } from "../backend/recognize.ts";
import { projectPublicV2, publicV2Snapshot } from "../backend/public-v2.ts";
import { inferredConfirmation, inferenceBoundary } from "../backend/confirmation.ts";

const localized = (value: string) => ({ en: value, zh: value, "zh-Hant": value, ja: value, ko: value, ru: value, es: value });
const at = "2026-10-23T12:00:00.000Z";
const definitions = [codex, claude, grok];
function response(excerpt: string): ActionRecognitionBody {
  return { relevant: true, needsReview: false, title: localized("Quota update"), summary: localized("A quota action"), actions: [{
    eventId: null, localEventKey: "initial", existingActionId: null, kind: "direct_reset", kindExplicit: true,
    action: "confirm", invalidatesEvent: false, real: true, role: "action", excerpt, title: localized("Usage reset"), summary: null,
    timeExcerpt: null,
    scope: { type: "unknown", note: null }, scopeExcerpt: null,
  }] };
}
async function post(definition: typeof codex, text: string, quotedPost?: Parameters<typeof storeCollectedPost>[0]["quotedPost"]) {
  const id = randomUUID();
  await storeCollectedPost({ id, author: definition.authors[0]!.handle, publishedAt: at, url: `https://x.com/${definition.authors[0]!.handle}/status/${id}`, text, receiptId: null, quotedPost });
  return (await sourcePost(id))!;
}
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts`;
});
after(closeDb);

for (const definition of definitions) {
  test(`${definition.monitorId}: unusable time metadata does not block a clear retrospective completion`, async () => inMonitor(definition, async () => {
    for (const timeExcerpt of [null, "", "2026-10-24T10:00:00Z", "earlier"]) {
      const text = "We reset usage earlier.", saved = await post(definition, text), answer = response(text);
      answer.actions[0]!.timeExcerpt = timeExcerpt;
      await applyOfflineRecognition(saved.id, answer, saved.version);
      const input = await loadActionInput(), action = input.actions.find(action => action.sources.some(source => source.postId === saved.id));
      assert.deepEqual(action?.time, bt(at));
      assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
    }
  }));

  test(`${definition.monitorId}: a future deadline does not reject an already completed reset`, async () => inMonitor(definition, async () => {
    const timeExcerpt = "before Oct 24, 2026 at 3pm UTC", text = `We reset usage ${timeExcerpt}.`;
    const saved = await post(definition, text), answer = response(text);
    answer.actions[0]!.timeExcerpt = timeExcerpt;
    await applyOfflineRecognition(saved.id, answer, saved.version);
    assert.deepEqual((await loadActionInput()).actions[0]!.time, bt(at));
    assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
  }));

  test(`${definition.monitorId}: an adjacent question does not block an explicit completed reset`, async () => inMonitor(definition, async () => {
    const text = "What would you like with your side of reset? It's done.";
    const saved = await post(definition, text);
    await applyOfflineRecognition(saved.id, response(text), saved.version);
    assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
    assert.equal((await publicV2Snapshot()).events[0]!.status, "completed");
    const input = await loadActionInput();
    assert.deepEqual(input.actions[0]!.time, bt(at));
    assert.deepEqual(input.events[0]!.scope, { type: "unknown", note: null });
  }));

  test(`${definition.monitorId}: a valid action survives another fact requiring review and is not retried`, async () => inMonitor(definition, async () => {
    const valid = "We reset usage for everyone.", invalid = "We will reset usage tomorrow.";
    const saved = await post(definition, `${valid} ${invalid}`), answer = response(valid);
    answer.needsReview = true;
    answer.actions.push({ ...structuredClone(answer.actions[0]!), localEventKey: "unresolved", excerpt: invalid });
    const applied = await applyOfflineRecognition(saved.id, answer, saved.version);
    let input = await loadActionInput();
    assert.equal(input.actions.length, 1);
    assert.equal(input.events.length, 1);
    assert.equal(applied.eventIds.length, 1);
    assert.equal(input.posts[0]!.processing_status, "needs_attention");
    assert.match(input.posts[0]!.review_reason!, /预期或否定/);
    assert.equal(input.posts[0]!.title!.zh, answer.title.zh);
    await applyOfflineRecognition(saved.id, answer, saved.version);
    input = await loadActionInput();
    assert.equal(input.actions.length, 1);
    assert.equal(input.events.length, 1);
  }));

  test(`${definition.monitorId}: verified quotation supplies a unique event and unchanged scope for Done`, async () => inMonitor(definition, async () => {
    const original = "We will reset usage for all paid users.", initial = response(original);
    initial.actions[0]!.action = "announce";
    initial.actions[0]!.scope.type = "paid_users";
    initial.actions[0]!.scope.note = localized("Paid users");
    initial.actions[0]!.scopeExcerpt = "all paid users";
    const parent = await post(definition, original);
    await applyOfflineRecognition(parent.id, initial, parent.version);
    const before = await loadActionInput(), event = before.events[0]!;
    const child = await post(definition, "Done.", { id: parent.id, author: parent.author, text: original, publishedAt: at, relation: "quote", url: parent.url });
    const answer = response("Done.");
    answer.actions[0]!.kindExplicit = false;
    await applyOfflineRecognition(child.id, answer, child.version);
    const input = await loadActionInput();
    assert.equal(input.events.length, 1);
    assert.equal(input.actions.length, 2);
    assert.equal(input.actions.find(action => action.action === "confirm")!.event_id, event.id);
    assert.deepEqual(input.events[0]!.scope, event.scope);
    assert.equal((await sourcePost(child.id))!.processing_status, "processed");
  }));

  test(`${definition.monitorId}: new product, plan and quota window need no configuration`, async () => inMonitor(definition, async () => {
    const text = "We reset the rolling 36-hour quota in Aurora Desk for Campus Pilot users, except trial seats.";
    const saved = await post(definition, text), answer = response(text), claim = answer.actions[0]!;
    claim.scope = { type: "selected_users", note: localized("Eligible users") };
    claim.scopeExcerpt = "Campus Pilot users, except trial seats";
    claim.summary = { ...localized("Aurora Desk's rolling 36-hour quota was reset for Campus Pilot users, except trial seats."),
      zh: "Aurora Desk 的滚动 36 小时额度已为 Campus Pilot 用户重置，试用席位除外。" };
    await applyOfflineRecognition(saved.id, answer, saved.version);
    const stored = await loadActionInput();
    assert.deepEqual(stored.events[0]!.summary, claim.summary);
    const event = (await publicV2Snapshot()).events[0]!;
    assert.equal(event.status, "completed");
    assert.deepEqual(event.scope, claim.scope);
    assert.deepEqual(event.updates[0]!.summary, claim.summary);
    assert.equal(event.summary, null, "event overview is pending");
    assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
    assert.equal((await sourcePost(saved.id))!.text, text);
  }));

}

for (const [expression, expected, confirmedAt] of [
    ["in the next hour", `${at}/2026-10-23T13:00:00.000Z`, "2026-10-23T13:00:00.000Z"],
    ["in a few minutes", null, null],
    ["soon", null, null],
    ["at an unspecified time", null, null],
  ] as const) test(`relative forecast '${expression}' saves a concrete time and blocks inference when parsing needs review`, async () => inMonitor(codex, async () => {
    const text = `We will reset usage ${expression}.`, saved = await post(codex, text), answer = response(text);
    answer.actions[0]!.action = "announce";
    answer.actions[0]!.timeExcerpt = expression;
    await applyOfflineRecognition(saved.id, answer, saved.version);
    const input = await loadActionInput(), action = input.actions.find(action => action.sources.some(source => source.postId === saved.id))!;
    const event = input.events.find(event => event.id === action.event_id)!;
    if (expected === null) {
      assert.deepEqual(action.time, bt("2026-10-23T18:00:00Z"));
      assert.equal((await sourcePost(saved.id))!.processing_status, "needs_attention");
      assert.equal(inferredConfirmation(event, input, Date.parse("2027-01-01T00:00:00Z")), null);
      const snapshot = projectPublicV2(input, codex, Date.parse(at));
      assert.equal(snapshot.events.find(row => row.id === event.id)!.status, "announced");
      assert.deepEqual(snapshot.events.find(row => row.id === event.id)!.time, action.time);
      assert.equal(snapshot.hasAnnouncement, true);
      assert.deepEqual(snapshot.announcedResetTime, action.time);
      return;
    }
    assert.deepEqual(action.time, bt(expected));
    assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
    const boundary = inferenceBoundary(bt(expected));
    assert.equal(inferredConfirmation(event, input, boundary - 1), null);
    const confirmation = inferredConfirmation(event, input, boundary)!;
    assert.deepEqual(confirmation.time, bt(confirmedAt));
    input.actions.push(confirmation);
    const completed = projectPublicV2(input, codex, boundary).events.find(row => row.id === event.id)!;
    assert.deepEqual(completed.time, bt(confirmedAt));
    assert.deepEqual(completed.updates.find(update => update.id === action.id)!.time, bt(expected));
}));

test("a weekly reset and a five-hour cap increase remain distinct facts", async () => inMonitor(codex, async () => {
  const reset = "We reset weekly usage.", text = reset + " We also raised the five-hour cap.";
  const saved = await post(codex, text), answer = response(reset), claim = answer.actions[0]!;
  claim.summary = { ...localized("Weekly usage was reset; the five-hour cap was raised."), zh: "每周额度已重置，五小时上限已提高。" };
  answer.actions.push({ ...claim, real: false, role: "explanation", localEventKey: "limit-change",
    excerpt: "We also raised the five-hour cap.", summary: localized("The five-hour cap was raised.") });
  await applyOfflineRecognition(saved.id, answer, saved.version);
  const [event, ...extra] = (await publicV2Snapshot()).events;
  assert.equal(extra.length, 0);
  assert.deepEqual(event!.updates.map(update => [update.action, update.summary]), [["confirm", claim.summary]]);
  assert.deepEqual(event!.time, bt(at), "the five-hour window is not a time of issuance");
  assert.equal(event!.scope.type, "unknown");
  assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
}));

test("supplemental sources keep accepted facts; a sourced amendment changes the audience", async () => inMonitor(codex, async () => {
  const text = "We reset usage for all paid users.", initial = response(text), first = await post(codex, text);
  const claim = initial.actions[0]!;
  claim.scope = { type: "paid_users", note: localized("Paid users") };
  claim.scopeExcerpt = "all paid users";
  claim.summary = localized("Usage was reset for all paid users.");
  const [eventId] = (await applyOfflineRecognition(first.id, initial, first.version)).eventIds;
  const [prior] = (await loadActionInput()).actions;

  const repeatText = "We reset usage. Free users are eligible for a different program.";
  const repeat = await post(codex, repeatText), repeated = response("We reset usage.");
  Object.assign(repeated.actions[0]!, {
    eventId, localEventKey: null, existingActionId: prior!.id,
    scope: { type: "all_users", note: localized("All users") },
    scopeExcerpt: "Free users are eligible for a different program",
    summary: localized("Everyone got a reset."),
  });
  assert.deepEqual((await applyOfflineRecognition(repeat.id, repeated, repeat.version)).eventIds, [eventId]);
  const afterRepeat = await loadActionInput();
  assert.equal(afterRepeat.events.length, 1);
  assert.deepEqual(afterRepeat.events[0]!.scope, claim.scope);
  assert.equal(afterRepeat.actions.length, 1);
  assert.equal(afterRepeat.actions[0]!.id, prior!.id);
  assert.deepEqual(afterRepeat.actions[0]!.summary, claim.summary);
  assert.deepEqual(new Set(afterRepeat.actions[0]!.sources.map(source => source.postId)), new Set([first.id, repeat.id]));

  const correction = "Correction: the usage reset was only for affected paid users.";
  const changed = await post(codex, correction), revised = response(correction);
  const amendment = revised.actions[0]!;
  Object.assign(amendment, {
    eventId, localEventKey: null, action: "amend",
    scope: { type: "selected_users", note: localized("Affected users") },
    scopeExcerpt: "only for affected paid users", summary: localized("Only affected paid users received the reset."),
  });
  assert.deepEqual((await applyOfflineRecognition(changed.id, revised, changed.version)).eventIds, [eventId]);
  const afterAmendment = await loadActionInput();
  assert.deepEqual(afterAmendment.events[0]!.scope, amendment.scope);
  const added = afterAmendment.actions.find(action => action.id !== prior!.id)!;
  assert.equal(added.action, "amend");
  assert.deepEqual(added.sources, [{ postId: changed.id }]);
  assert.deepEqual(added.summary, amendment.summary);
  assert.equal((await publicV2Snapshot()).events[0]!.status, "completed");
}));

test("a partially accepted paid response completes its receipt in the same transaction", async () => inMonitor(codex, async () => {
  const text = "We reset usage for everyone.", saved = await post(codex, text), answer = response(text);
  answer.needsReview = true;
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,response)
    VALUES(${randomUUID()},'synthetic','monitor.recognize',${`x:${saved.id}`},'received','{}'::jsonb) RETURNING id`;
  await applyRecognition(saved.id, { ...answer, receiptId: receipt!.id, model: "synthetic", promptVersion: "synthetic" }, saved.version);
  assert.equal((await sourcePost(saved.id))!.processing_status, "needs_attention");
  assert.equal((await loadActionInput()).actions.length, 1);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipt!.id}`)[0]!.status, "completed");
}));

test("ambiguous context and relevance contradictions cannot establish guessed events", async () => inMonitor(codex, async () => {
  const text = "We reset usage for everyone.";
  const parents = [];
  for (let index = 0; index < 2; index++) {
    const parent = await post(codex, text);
    await applyOfflineRecognition(parent.id, response(text), parent.version);
    parents.push(parent);
  }
  const child = await post(codex, `Done. ${parents.map(parent => parent.url).join(" ")}`), answer = response("Done.");
  await applyOfflineRecognition(child.id, answer, child.version);
  assert.equal((await sourcePost(child.id))!.processing_status, "needs_attention");
  assert.equal((await loadActionInput()).actions.length, 2);
  const explicit = await post(codex, `All reset. ${parents.map(parent => parent.url).join(" ")}`), chosen = response("All reset.");
  const selectedEvent = (await loadActionInput()).events[0]!;
  chosen.actions[0]!.eventId = selectedEvent.id;
  chosen.actions[0]!.localEventKey = null;
  chosen.needsReview = true;
  await applyOfflineRecognition(explicit.id, chosen, explicit.version);
  assert.equal((await sourcePost(explicit.id))!.processing_status, "needs_attention");
  assert.equal((await loadActionInput()).actions.length, 2);
  const contradictory = await post(codex, text), unrelated = response(text);
  unrelated.relevant = false;
  await applyOfflineRecognition(contradictory.id, unrelated, contradictory.version);
  assert.equal((await loadActionInput()).actions.length, 2);
}));

test("different event kinds cannot share a local group and a rejected initial action cannot leave an orphan", async () => inMonitor(codex, async () => {
  const text = "We will reset usage. We added one banked reset for everyone.";
  const saved = await post(codex, text), answer = response("We will reset usage.");
  answer.actions[0]!.action = "announce";
  answer.actions.push({ ...structuredClone(answer.actions[0]!), kind: "reset_credit", action: "confirm", excerpt: "We added one banked reset for everyone." });
  await applyOfflineRecognition(saved.id, answer, saved.version);
  const input = await loadActionInput();
  assert.equal(input.events.length, 1);
  assert.equal(input.events[0]!.type, "direct_reset");
  assert.equal(input.actions.length, 1);
  assert.equal((await sourcePost(saved.id))!.processing_status, "needs_attention");
  const rejected = await post(codex, "It is done. The event changed."), bad = response("It is done.");
  bad.actions.push({ ...structuredClone(bad.actions[0]!), action: "progress", excerpt: "The event changed." });
  await applyOfflineRecognition(rejected.id, bad, rejected.version);
  assert.equal((await loadActionInput()).events.length, 1);
  assert.equal((await loadActionInput()).actions.length, 1);
}));
