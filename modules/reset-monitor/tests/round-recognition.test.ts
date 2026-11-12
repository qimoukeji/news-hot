import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { inMonitor } from "../backend/context.ts";
import { applyOfflineRecognition } from "../backend/assemble.ts";
import { loadActionInput, sourcePost, storeCollectedPost, writePostActions } from "../backend/action-store.ts";
import { processPending } from "../backend/thread-processing.ts";
import { reduceEvent, type ActionInput } from "../actions.ts";
import type { ActionRecognitionBody, ThreadRecognitionInput } from "../backend/recognize.ts";

const author = codex.authors[0]!.handle;
const localized = (value: string) => ({ en: value, zh: value, "zh-Hant": value, ja: value, ko: value, ru: value, es: value });
const original = { id: "2116405414921384099", at: "2026-10-31T05:42:26.000Z", text: "Day 26/ You can now easily switch between multiple accounts on mobile, and coming soon to desktop too. Next two days will be resets… banked… do with this what you may 👀.\n\nhttps://help.openai.com/en/articles/20001068-using-multiple-chatgpt-accounts-on-web-and-mobile" };
const firstRound = { id: "2116692529970311254", at: "2026-11-01T00:43:20.000Z", text: "Banked 1/2" };
const secondRound = { id: "2117035794678546764", at: "2026-11-01T23:27:20.000Z", text: "Day 28/ Banked 2/2" };
const unrelated = [
  { id: "unrelated-before-first-round", at: "2026-10-31T12:00:00.000Z", text: "The editor now has a new monochrome theme." },
  { id: "unrelated-before-second-round", at: "2026-11-01T12:00:00.000Z", text: "Our website now has a redesigned navigation menu." },
];
const competing = { id: "competing-banked-announcement", at: "2026-10-31T07:00:00.000Z", text: "We will grant two banked resets over the next two days for another campaign." };
type Fixture = typeof original;
type Claim = ActionRecognitionBody["actions"][number];
const inputs: ThreadRecognitionInput[] = [];
let ambiguous = false;
let answerMode: "normal" | "review-first-round" | "extra-final-round" | "wrong-final-target" | "review-final-round" = "normal";
let forcedFirstEventId: string | null = null;
let beforeReply: ((input: ThreadRecognitionInput) => Promise<void>) | null = null;

function claim(excerpt: string, patch: Partial<Claim> = {}): Claim {
  return { eventId: null, localEventKey: "first-round", existingActionId: null, kind: "reset_credit", kindExplicit: true,
    action: "announce", invalidatesEvent: false, real: true, role: "action", excerpt,
    title: localized("Banked reset"), summary: localized("A banked reset is planned."), timeExcerpt: null,
    scope: { type: "unknown", note: null }, scopeExcerpt: null, ...patch };
}
function body(actions: Claim[], relevant = true): ActionRecognitionBody {
  return { relevant, needsReview: false, title: localized("Quota update"), summary: null, actions };
}
function answer(postId: string, input: ThreadRecognitionInput): ActionRecognitionBody & { postId: string; reviewReason: string | null } {
  let result: ActionRecognitionBody;
  if (postId === original.id) result = body([claim(original.text)]);
  else if (unrelated.some(post => post.id === postId)) result = body([], false);
  else if (ambiguous) return { postId, ...body([]), needsReview: true, reviewReason: "Two campaigns could match this numbered banked update." };
  else if (postId === firstRound.id) {
    const firstId = forcedFirstEventId ?? input.events.find(event => event.sourcePostIds.includes(original.id))?.id;
    assert.ok(firstId, "the first-round event is available to the recognizer");
    result = body([
      claim(firstRound.text, { eventId: firstId, localEventKey: null, action: "confirm", summary: localized("The first of two banked resets is delivered.") }),
      claim(firstRound.text, { localEventKey: "second-round", summary: localized("The second banked reset is still planned.") }),
    ]);
    if (answerMode === "review-first-round") return { postId, ...result, needsReview: true, reviewReason: "The numbered update might refer to a different campaign." };
  } else {
    assert.equal(postId, secondRound.id);
    const second = input.events.find(event => event.sourcePostIds.includes(firstRound.id) && !event.sourcePostIds.includes(original.id));
    const newInGroup = input.targets.some(post => post.id === firstRound.id);
    assert.ok(second || newInGroup, "the second round is saved or announced by an earlier target in this group");
    const targetId = answerMode === "wrong-final-target" ? input.events.find(event => event.sourcePostIds.includes(original.id))!.id : second?.id ?? null;
    result = body([claim("Banked 2/2", { eventId: targetId, localEventKey: targetId ? null : "second-round", action: "confirm", summary: localized("The second of two banked resets is delivered.") })]);
    if (answerMode === "extra-final-round") result.actions.push(claim("Banked 2/2", { localEventKey: "third-round", summary: localized("An unsupported additional round is planned.") }));
    if (answerMode === "review-final-round") return { postId, ...result, needsReview: true, reviewReason: "The final delivery's target is uncertain." };
  }
  return { postId, ...result, reviewReason: null };
}
const model = await stub(async (_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages[1].content) as ThreadRecognitionInput;
  inputs.push(input);
  const posts = input.targets.map(post => answer(post.id, input));
  if (beforeReply) await beforeReply(input);
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ posts }) } }] };
});
Object.assign(process.env, { MONITOR_MODEL: "default", LLM_MODEL: "synthetic-banked-rounds", LLM_API_KEY: "synthetic", LLM_BASE_URL: `${model.url}/v1` });
config.allowPrivateNetworkFetch = true;
installModules([createMonitorServer(codex)]);

beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts`;
  await sql`DELETE FROM budgets`;
  inputs.length = 0; ambiguous = false; answerMode = "normal"; forcedFirstEventId = null; beforeReply = null;
  config.modelCallsEnabled = true; process.env.COLLECT_ENABLED = "true";
});
after(async () => { await model.close(); installModules([]); await closeDb(); });

async function seed(posts: Fixture[], relation?: "reply" | "quote") {
  for (const post of posts) await storeCollectedPost({ id: post.id, author, publishedAt: post.at, text: post.text,
    url: `https://x.com/${author}/status/${post.id}`, receiptId: null,
    replyTo: post.id === secondRound.id && relation === "reply" ? { postId: firstRound.id, author } : null,
    quotedPost: post.id === secondRound.id && relation === "quote" ? { id: firstRound.id, author, publishedAt: firstRound.at, text: firstRound.text,
      relation: "quote", url: `https://x.com/${author}/status/${firstRound.id}` } : null });
}
async function acceptOriginal(post = original, patch?: Partial<Claim>) {
  await seed([post]);
  const saved = (await sourcePost(post.id))!;
  await applyOfflineRecognition(saved.id, body([claim(post.text, patch)]), saved.version);
  const input = await loadActionInput();
  return { event: input.events.find(event => input.actions.some(action => action.event_id === event.id && action.sources.some(source => source.postId === post.id)))!,
    action: input.actions.find(action => action.sources.some(source => source.postId === post.id))! };
}
function assertHistory(input: ActionInput) {
  assert.equal(input.events.length, 2);
  assert.equal(input.actions.length, 4);
  const first = input.events.find(event => input.actions.some(action => action.event_id === event.id && action.sources.some(source => source.postId === original.id)))!;
  const second = input.events.find(event => event.id !== first.id)!;
  const firstActions = input.actions.filter(action => action.event_id === first.id).sort((a, b) => a.sequence - b.sequence);
  const secondActions = input.actions.filter(action => action.event_id === second.id).sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(firstActions.map(action => ({ action: action.action, sources: action.sources })), [
    { action: "announce", sources: [{ postId: original.id }] }, { action: "confirm", sources: [{ postId: firstRound.id }] },
  ]);
  assert.deepEqual(secondActions.map(action => ({ action: action.action, sources: action.sources })), [
    { action: "announce", sources: [{ postId: firstRound.id }] }, { action: "confirm", sources: [{ postId: secondRound.id }] },
  ]);
  assert.deepEqual(secondActions[0]!.time, { kind: "instant", at: "2026-11-01T23:59:00.000Z" }, "the remaining round uses its own publication date default");
  assert.equal(second.scope!.type, "unknown");
  assert.deepEqual(reduceEvent(first, input)!.confirmedTime, { kind: "instant", at: firstRound.at });
  assert.deepEqual(reduceEvent(second, input)!.confirmedTime, { kind: "instant", at: secondRound.at });
  assert.ok(input.posts.every(post => post.processing_status === "processed"));
  for (const post of [firstRound, secondRound]) {
    const request = inputs.find(input => input.targets.some(target => target.id === post.id))!;
    assert.ok(request.context.some(source => source.id === original.id && source.text === original.text), "numbered follow-ups receive the original campaign text");
    if (post.id === secondRound.id) assert.ok([...request.context, ...request.targets].some(source => source.id === firstRound.id && source.text === firstRound.text), "the final round receives the first delivery text");
    for (const other of unrelated) assert.equal(request.context.some(source => source.id === other.id || source.text === other.text), false, "intervening unrelated text is excluded from candidate context");
  }
}

for (const timing of ["together", "separately"] as const) test(`independent banked round posts processed ${timing} preserve the accepted first event and complete two rounds`, async () => inMonitor(codex, async () => {
  const initial = await acceptOriginal();
  if (timing === "together") {
    await seed([secondRound, unrelated[1]!, firstRound, unrelated[0]!]);
    await processPending();
  } else {
    await seed([firstRound, unrelated[0]!]);
    await processPending();
    const midway = await loadActionInput();
    assert.equal(midway.events.length, 2);
    const pending = midway.events.find(event => event.id !== initial.event.id)!;
    assert.equal(reduceEvent(pending, midway)!.status, "announced");
    assert.deepEqual(reduceEvent(pending, midway)!.time, { kind: "instant", at: "2026-11-01T23:59:00.000Z" });
    assert.deepEqual(midway.actions.find(action => action.event_id === pending.id)!.time, { kind: "instant", at: "2026-11-01T23:59:00.000Z" });
    await seed([secondRound, unrelated[1]!]);
    await processPending();
  }
  const saved = await loadActionInput();
  assertHistory(saved);
  assert.deepEqual(saved.events.find(event => event.id === initial.event.id)!.scope, initial.event.scope);
  assert.deepEqual(saved.actions.find(action => action.id === initial.action.id), initial.action, "accepted announcement ID and fact remain unchanged");
  const hits = model.hits();
  await processPending();
  assert.equal(model.hits(), hits);
  assert.deepEqual((await loadActionInput()).actions, saved.actions);
}));

test("one pending batch observes newly accepted numbered-round facts between independent groups", async () => inMonitor(codex, async () => {
  await seed([secondRound, unrelated[1]!, firstRound, unrelated[0]!, original]);
  await processPending();
  assertHistory(await loadActionInput());
  const hits = model.hits();
  await processPending();
  assert.equal(model.hits(), hits);
}));

for (const relation of ["reply", "quote"] as const) test(`a final-round ${relation} to a dual-action source confirms only the uniquely pending next round`, async () => inMonitor(codex, async () => {
  await acceptOriginal(); await seed([firstRound]); await processPending();
  await seed([secondRound], relation); await processPending();
  assertHistory(await loadActionInput());
}));

for (const relation of ["reply", "quote"] as const) test(`pending numbered ${relation} targets share a new local event within one recognition group`, async () => inMonitor(codex, async () => {
  const originalFact = await acceptOriginal(), beforeHits = model.hits();
  await seed([secondRound, firstRound], relation);
  const result = await processPending(), saved = await loadActionInput();
  assert.equal(result.groups, 1); assert.equal(result.modelCalls, 1); assert.equal(result.processed, 2);
  assert.equal(model.hits() - beforeHits, 1);
  assert.deepEqual(inputs[0]!.targets.map(post => post.id), [firstRound.id, secondRound.id]);
  assert.equal(inputs[0]!.events.some(event => !event.sourcePostIds.includes(original.id)), false, "the second event does not exist before this group's answer");
  const completion = answer(secondRound.id, inputs[0]!);
  assert.equal(completion.actions[0]!.eventId, null); assert.equal(completion.actions[0]!.localEventKey, "second-round");
  assertHistory(saved);
  assert.ok(saved.events.some(event => event.id === originalFact.event.id));
  assert.deepEqual(saved.actions.find(action => action.id === originalFact.action.id), originalFact.action);
  assert.equal(saved.posts.find(post => post.id === firstRound.id)!.model_receipt_id, saved.posts.find(post => post.id === secondRound.id)!.model_receipt_id);
  const hits = model.hits(); await processPending();
  assert.equal(model.hits(), hits); assert.deepEqual((await loadActionInput()).actions, saved.actions);
}));

function assertIndependentReview(before: ActionInput, after: ActionInput, postId: string, kinds: string[]) {
  const known = new Set(before.events.map(event => event.id));
  assert.deepEqual(after.events.filter(event => known.has(event.id)), [...before.events]);
  assert.deepEqual(after.actions.filter(action => known.has(action.event_id)), [...before.actions]);
  const saved = after.actions.filter(action => !known.has(action.event_id));
  assert.deepEqual(saved.map(action => action.action).sort(), [...kinds].sort());
  assert.equal(new Set(saved.map(action => action.event_id)).size, kinds.length);
  assert.ok(saved.every(action => action.sources.length === 1 && action.sources[0]!.postId === postId));
  assert.equal(after.posts.find(post => post.id === postId)!.processing_status, "needs_attention");
}

for (const mode of ["wrong-final-target", "review-final-round"] as const) test(`a ${mode} response preserves the confirmation independently of both existing rounds`, async () => inMonitor(codex, async () => {
  await acceptOriginal(); await seed([firstRound]); await processPending();
  const before = await loadActionInput(); answerMode = mode;
  await seed([secondRound], "reply"); await processPending();
  const after = await loadActionInput();
  assertIndependentReview(before, after, secondRound.id, ["confirm"]);
}));

test("two pending rounds attached to the same numbered source remain genuinely ambiguous", async () => inMonitor(codex, async () => {
  const initial = await acceptOriginal(); await seed([firstRound]); await processPending();
  const input = await loadActionInput(), second = input.events.find(event => event.id !== initial.event.id)!;
  await sql.begin(async tx => writePostActions(tx, (await sourcePost(firstRound.id, tx))!, [{ eventId: "competing-round", action: "announce",
    title: localized("A competing pending round"), summary: null, time: { kind: "instant", at: "2026-11-01T23:59:00Z" } }], { events: [{ id: "competing-round", type: "reset_credit", scope: second.scope }] }));
  const before = await loadActionInput();
  await seed([secondRound], "quote"); await processPending();
  const after = await loadActionInput();
  assertIndependentReview(before, after, secondRound.id, ["confirm"]);
}));

test("a remaining round does not borrow the previous round's audience or schedule", async () => inMonitor(codex, async () => {
  const audience = "affected subscribers", timeExcerpt = "tomorrow at 6pm UTC";
  const first = { ...original, text: "We will grant banked resets to affected subscribers tomorrow at 6pm UTC." };
  const initial = await acceptOriginal(first, {
    scope: { type: "selected_users", note: localized("Affected subscribers") }, scopeExcerpt: audience, timeExcerpt,
  });
  assert.equal(initial.event.scope!.type, "selected_users");
  assert.notEqual(initial.action.time, null);
  await seed([firstRound]); await processPending();
  const input = await loadActionInput(), next = input.events.find(event => event.id !== initial.event.id)!;
  assert.deepEqual(next.scope, { type: "unknown", note: null });
  assert.deepEqual(reduceEvent(next, input)!.time, { kind: "instant", at: "2026-11-01T23:59:00.000Z" });
  assert.deepEqual(input.events.find(event => event.id === initial.event.id)!.scope, initial.event.scope);
}));

test("competing same-author campaigns keep numbered banked updates under review without choosing a target", async () => inMonitor(codex, async () => {
  await acceptOriginal();
  await acceptOriginal(competing);
  const initial = await loadActionInput();
  ambiguous = true;
  await seed([firstRound]);
  const result = await processPending();
  assert.equal(result.reviewed, 1);
  const saved = await loadActionInput();
  assert.deepEqual(saved.events, initial.events);
  assert.deepEqual(saved.actions, initial.actions);
  assert.equal((await sourcePost(firstRound.id))!.processing_status, "needs_attention");
  assert.match((await sourcePost(firstRound.id))!.review_reason!, /Two campaigns/);
  const request = inputs.find(input => input.targets.some(post => post.id === firstRound.id))!;
  assert.ok(request.context.some(source => source.id === original.id && source.text === original.text));
  assert.ok(request.context.some(source => source.id === competing.id && source.text === competing.text));
  const hits = model.hits();
  await processPending();
  assert.equal(model.hits(), hits);
}));

test("a reviewed first-round result retains both proposed actions without changing the known campaign", async () => inMonitor(codex, async () => {
  await acceptOriginal();
  const initial = await loadActionInput();
  answerMode = "review-first-round";
  await seed([firstRound]);
  await processPending();
  const saved = await loadActionInput();
  assertIndependentReview(initial, saved, firstRound.id, ["confirm", "announce"]);
}));

for (const target of ["nonexistent", "withdrawn"] as const) test(`a ${target} first-round target does not prevent saving both actions separately for correction`, async () => inMonitor(codex, async () => {
  const first = await acceptOriginal();
  forcedFirstEventId = target === "nonexistent" ? "missing-campaign-event" : first.event.id;
  if (target === "withdrawn") await sql`UPDATE monitor_event_records SET withdrawn=true,updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${first.event.id}`;
  const initial = await loadActionInput();
  await seed([firstRound]);
  await processPending();
  const saved = await loadActionInput();
  assertIndependentReview(initial, saved, firstRound.id, ["confirm", "announce"]);
}));

test("a completed final round retains an extra model announcement separately for review", async () => inMonitor(codex, async () => {
  await acceptOriginal();
  await seed([firstRound]);
  await processPending();
  const before = await loadActionInput();
  const second = before.events.find(event => !before.actions.some(action => action.event_id === event.id && action.sources.some(source => source.postId === original.id)))!;
  answerMode = "extra-final-round";
  await seed([secondRound]);
  await processPending();
  const saved = await loadActionInput();
  assert.equal(saved.events.length, 3); assert.equal(saved.actions.length, 5);
  const fromFinal = saved.actions.filter(action => action.sources.some(source => source.postId === secondRound.id));
  assert.deepEqual(fromFinal.map(action => action.action).sort(), ["announce", "confirm"]);
  assert.equal(fromFinal.find(action => action.action === "confirm")!.event_id, second.id);
  const extra = fromFinal.find(action => action.action === "announce")!;
  assert.deepEqual(extra.time, { kind: "instant", at: "2026-11-01T23:59:00.000Z" });
  assert.ok(!before.events.some(event => event.id === extra.event_id));
  assert.equal(reduceEvent(saved.events.find(event => event.id === second.id)!, saved)!.status, "completed");
  assert.equal((await sourcePost(secondRound.id))!.processing_status, "needs_attention", "the unsupported proposal remains visible for review");
}));

test("editing candidate source text during recognition discards the entire stale round result", async () => inMonitor(codex, async () => {
  await acceptOriginal();
  const initial = await loadActionInput();
  await seed([firstRound]);
  const revised = `${original.text}\nThe campaign details have changed.`;
  beforeReply = async input => {
    assert.ok(input.context.some(post => post.id === original.id && post.text === original.text));
    beforeReply = null;
    await sql`UPDATE monitor_source_posts SET text=${revised},updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${original.id}`;
  };
  await processPending();
  const saved = await loadActionInput();
  assert.deepEqual(saved.events, initial.events);
  assert.deepEqual(saved.actions, initial.actions);
  assert.equal((await sourcePost(original.id))!.text, revised);
  assert.equal((await sourcePost(firstRound.id))!.processing_status, "needs_attention");
  assert.match((await sourcePost(firstRound.id))!.review_reason!, /已变化|过期/);
  const hits = model.hits();
  await processPending();
  assert.equal(model.hits(), hits);
}));
