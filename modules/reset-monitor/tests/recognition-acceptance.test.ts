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
import { publicV2Snapshot } from "../backend/public-v2.ts";

const localized = (value: string) => ({ en: value, zh: value, "zh-Hant": value, ja: value, ko: value, ru: value, es: value });
const at = "2026-10-23T12:00:00.000Z";
const definitions = [codex, claude, grok];
function response(excerpt: string): ActionRecognitionBody {
  return { relevant: true, needsReview: false, title: localized("Quota update"), summary: localized("A quota action"), actions: [{
    eventId: null, localEventKey: "initial", existingActionId: null, kind: "direct_reset", kindExplicit: true,
    action: "confirm", invalidatesEvent: false, real: true, role: "action", excerpt, title: localized("Usage reset"), summary: null,
    timeExcerpt: null, rawScope: { audienceSource: null, audienceZh: null, plans: null, productsZh: null },
    scope: { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: localized("All users") }, scopeExcerpt: null,
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
  test(`${definition.monitorId}: an adjacent question does not block an explicit completed reset`, async () => inMonitor(definition, async () => {
    const text = "What would you like with your side of reset? It's done.";
    const saved = await post(definition, text);
    await applyOfflineRecognition(saved.id, response(text), saved.version);
    assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
    assert.equal((await publicV2Snapshot()).events[0]!.status, "completed");
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
    initial.actions[0]!.rawScope = { audienceSource: "all paid users", audienceZh: "付费用户", productsZh: null, plans: null };
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

  test(`${definition.monitorId}: unsupported product mapping retains the action and literal restrictions`, async () => inMonitor(definition, async () => {
    const text = "We reset usage for all paid users of Unlisted Studio.", saved = await post(definition, text), answer = response(text), claim = answer.actions[0]!;
    claim.rawScope = { audienceSource: "all paid users", audienceZh: "付费用户", productsZh: "Unlisted Studio", plans: null };
    claim.scope.type = "paid_users";
    claim.scope.productCodes = ["unlisted-studio"];
    claim.scope.note = localized("Paid users");
    claim.scopeExcerpt = text;
    await applyOfflineRecognition(saved.id, answer, saved.version);
    const event = (await publicV2Snapshot()).events[0]!;
    assert.equal(event.status, "completed");
    assert.equal(event.scope.type, "paid_users");
    assert.deepEqual(event.scope.productCodes, []);
    assert.match(event.scope.note!.zh, /unknown 所有产品/);
    assert.match(event.summary!.zh, /Unlisted Studio/);
    assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
  }));
}

test("relative forecasts keep interval precision; vague forecasts keep the action without inventing a clock", async () => inMonitor(codex, async () => {
  for (const [expression, expected] of [["in the next hour", `${at}/2026-10-23T13:00:00.000Z`], ["in a few minutes", null]] as const) {
    const text = `We will reset usage ${expression}.`, saved = await post(codex, text), answer = response(text);
    answer.actions[0]!.action = "announce";
    answer.actions[0]!.timeExcerpt = expression;
    await applyOfflineRecognition(saved.id, answer, saved.version);
    const input = await loadActionInput(), action = input.actions.find(action => action.sources.some(source => source.postId === saved.id))!;
    assert.equal(action.time, expected);
    assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
  }
}));

test("unknown audience and hourly coverage do not become all-users evidence or a five-hour quota", async () => inMonitor(codex, async () => {
  const text = "We reset weekly and hourly usage.", saved = await post(codex, text), answer = response(text), claim = answer.actions[0]!;
  claim.scope.quotaWindowCodes = ["weekly", "five-hour", "hourly"];
  claim.scopeExcerpt = text;
  await applyOfflineRecognition(saved.id, answer, saved.version);
  const event = (await publicV2Snapshot()).events[0]!;
  assert.equal(event.scope.type, "unknown");
  assert.match(event.scope.note!.zh, /unknown 所有用户/);
  assert.deepEqual(event.scope.quotaWindowCodes, ["weekly"]);
  assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
}));

test("audience-only scope evidence cannot hide a quota cycle explicitly named by the same action", async () => inMonitor(codex, async () => {
  const text = "We reset weekly usage for all paid users.", saved = await post(codex, text), answer = response(text), claim = answer.actions[0]!;
  claim.rawScope.audienceSource = "all paid users";
  claim.rawScope.audienceZh = "付费用户";
  claim.scope.type = "paid_users";
  claim.scope.quotaWindowCodes = ["weekly"];
  claim.scopeExcerpt = "all paid users";
  await applyOfflineRecognition(saved.id, answer, saved.version);
  assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
  assert.deepEqual((await publicV2Snapshot()).events[0]!.scope.quotaWindowCodes, ["weekly"]);
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
