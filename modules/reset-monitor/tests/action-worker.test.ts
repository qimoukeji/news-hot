import { listEvents } from "./admin-fixture.ts";
import { stub, Reply, gate } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { createMonitorServer } from "../server.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { applyRecognition as acceptRecognition } from "../backend/assemble.ts";
import { storeCollectedPost, sourcePost, loadActionInput, writePostActions } from "../backend/action-store.ts";
import { processPending, collectPosts, monitorTick, openEvents } from "../backend/scan.ts";
import { cursorKey } from "../config.ts";
import { recognizeThread, type ActionRecognition } from "../backend/recognize.ts";
import { processPublicV2Pending } from "../backend/public-v2-generate.ts";
import { publicV2Snapshot } from "../backend/public-v2.ts";
import { updateMonitorEvent, updateMonitorPost } from "../backend/admin.ts";
import { monitorEventDetail, previewMonitorEventReview, submitMonitorEventReview } from "../backend/manual-review.ts";
import type { QuotedPost } from "../actions.ts";

async function applyRecognition(postId: string, recognition: ActionRecognition, expectedVersion?: string) {
  const post = await sourcePost(postId);
  return acceptRecognition(postId, recognition, expectedVersion ?? post!.version);
}
type Claim = ActionRecognition["actions"][number];
const local = (text: string) => ({ en: text, zh: text, "zh-Hant": text, ja: text, ko: text, ru: text, es: text });
const at = "2026-10-23T12:00:00.000Z";
const scope: Claim["scope"] = { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null };
function claim(text: string, patch: Partial<Claim> = {}): Claim {
  return { eventId: null, localEventKey: "new-1", existingActionId: null, kind: "direct_reset", kindExplicit: true,
    action: "confirm", invalidatesEvent: false, real: true, role: "action", excerpt: text, title: local("Usage reset"), summary: local("Usage restored."),
    timeExcerpt: null, rawScope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null },
    scope: structuredClone(scope), scopeExcerpt: null, ...patch };
}
function recognition(text: string, receiptId: number, actions = [claim(text)]): ActionRecognition {
  return { relevant: true, needsReview: false, title: local("Quota update"), summary: local("Quota update summary"), actions,
    model: "synthetic", promptVersion: "synthetic", receiptId };
}
async function addPost(definition: ResetMonitorBackendDefinition, text: string, options: { id?: string; service?: string; publishedAt?: string; author?: string; quotedPost?: QuotedPost; replyTo?: { postId: string | null; author: string | null } } = {}) {
  const id = options.id ?? randomUUID(), author = options.author ?? definition.authors[0]!.handle, publishedAt = options.publishedAt ?? at;
  const tweet = options.service === "twitterapi_io" ? { id, text, createdAt: publishedAt, author: { name: author, userName: author } }
    : { id_str: id, full_text: text, tweet_created_at: publishedAt, user: { name: author, screen_name: author } };
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,response)
    VALUES(${randomUUID()},${options.service ?? "socialdata"},${`${definition.names.purposePrefix}.scan`},${`x:${author}`},'completed',${sql.json({ tweets: [tweet] })}) RETURNING id`;
  const [model] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,response)
    VALUES(${randomUUID()},'synthetic',${`${definition.names.purposePrefix}.recognize`},${`x:${id}`},'received','{}'::jsonb) RETURNING id`;
  await inMonitor(definition, () => storeCollectedPost({ id, author, publishedAt, text, quotedPost: options.quotedPost ?? null, replyTo: options.replyTo ?? null, url: `https://x.com/${author}/status/${id}`, receiptId: receipt!.id }));
  return { id, receiptId: receipt!.id, modelReceiptId: model!.id, text };
}
const answers = new Map<string, ActionRecognition>();
const modelInputs = new Map<string, any>();
const editorialInputs: Record<string, unknown>[] = [];
const collectionQueries: URL[] = [];
let collectionFailure = false;
const collector = await stub((_hit, request) => {
  const url = new URL(request.url, "http://localhost"); collectionQueries.push(url);
  const handle = /from:(\w+)/.exec(url.searchParams.get("query")!)![1]!;
  if (collectionFailure && handle === grok.authors[1]!.handle.toLowerCase()) return new Reply(429, { error: "Synthetic page refusal" });
  const id = handle === "bot" ? "900101" : "900201";
  const root = { id_str: id, full_text: "We reset usage.", tweet_created_at: at, user: { name: handle, screen_name: handle } };
  return { tweets: [root], next_cursor: null };
});
let transportFailure = false, invalidOutput = false;
let beforeModelReply: (() => Promise<void>) | null = null;
let translationRace: (() => Promise<void>) | null = null;
let invalidTranslation = false;
const model = await stub(async (_hit, request) => {
  if (beforeModelReply) await beforeModelReply();
  if (transportFailure) return new Reply(429, { error: "Synthetic definite refusal" });
  const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content);
  assert.doesNotMatch(body.messages[0].content, /translationZh|contextZh|expectedLanding|statedTime|duplicateOf|"propositions"/);
  let content: unknown;
  if (input.targets) {
    content = invalidOutput ? { invalid: true } : { posts: input.targets.map((post: { id: string }) => {
      modelInputs.set(post.id, input);
      const saved = answers.get(post.id);
      return saved ? { postId: post.id, relevant: saved.relevant, needsReview: saved.needsReview, reviewReason: null, title: saved.title, summary: saved.summary, actions: saved.actions } : { postId: post.id };
    }) };
  }
  else if (input.post) {
    modelInputs.set(input.post.id, input);
    const saved = answers.get(input.post.id);
    content = invalidOutput ? { invalid: true } : saved ? { relevant: saved.relevant, needsReview: saved.needsReview, title: saved.title, summary: saved.summary, actions: saved.actions } : null;
  }
  else {
    assert.match(body.messages[0].content, /Return a JSON object/);
    assert.match(body.messages[0].content, /Each non-null field must be an object with exactly seven string keys/);
    editorialInputs.push(input);
    if (translationRace) { const change = translationRace; translationRace = null; await change(); }
    content = Object.fromEntries(["title", "summary", "note"].map(key => [key, input[key] ? { ...local(Object.values(input[key])[0] as string), ...input[key] } : null]));
    if (invalidTranslation && input.title) (content as { title: Record<string, string> }).title.zh = "不允许覆盖人工中文";
  }
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] };
});
Object.assign(process.env, { MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "synthetic", LLM_MODEL: "synthetic-actions",
  SOCIALDATA_BASE_URL: collector.url, SOCIALDATA_API_KEY: "synthetic", GROK_RESET_PROVIDER: "socialdata" });
config.allowPrivateNetworkFetch = true;
installModules([codex, claude, grok].map(createMonitorServer));
beforeEach(async () => {
 await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`; await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`; await sql`DELETE FROM receipts`; await sql`DELETE FROM budgets`;
  answers.clear(); modelInputs.clear(); transportFailure = false; invalidOutput = false; translationRace = null;
  editorialInputs.length = 0;
  invalidTranslation = false;
  beforeModelReply = null;
  collectionFailure = false; collectionQueries.length = 0;
  config.modelCallsEnabled = true; process.env.COLLECT_ENABLED = "true";
});
after(async () => { await model.close(); await collector.close(); installModules([]); await closeDb(); });
afterEach(() => mock.timers.reset());

test("model candidates retain official state and fallback titles after public inference", async () => inMonitor(codex, async () => {
  const post = await addPost(codex, "Synthetic planned reset.");
  await sql.begin(async db => writePostActions(db, (await sourcePost(post.id, db))!, [
    { eventId: "planned", action: "announce", title: { zh: "预告重置" }, summary: null, time: at },
  ], { events: [{ id: "planned", type: "direct_reset" }] }));
  await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,summary,time,sources)
    VALUES('codex','inferred-confirmation','planned',2,'confirm',${sql.json({ zh: "已到预告时间" })},NULL,${at},'[]'::jsonb)`;
  const snapshot = await publicV2Snapshot();
  assert.equal(snapshot.events[0]!.status, "completed");
  assert.equal(snapshot.events[0]!.updates.find(action => action.id === "inferred-confirmation")!.sources.length, 0);
  const candidates = await openEvents(new Date("2026-10-27T00:00:00Z"), []);
  assert.equal(candidates[0]!.status, "announced");
  assert.equal(candidates[0]!.actions[0]!.title, "预告重置", "model facts use one readable language, including Chinese-only manual titles");
  assert.match(candidates[0]!.title, /announced/i);
  assert.doesNotMatch(candidates[0]!.title, /completed/i);
  assert.equal("confirmation" in candidates[0]!, false);
  assert.deepEqual(candidates[0]!.actions!.map(action => action.id), [(await loadActionInput()).actions.find(action => action.action === "announce")!.id]);
}));

test("post-backed worker accepts a first confirmation and keeps original bodies outside actions and public responses", async () => {
  for (const definition of [codex, claude, grok]) {
    const post = await addPost(definition, "We reset usage for everyone.");
    await inMonitor(definition, () => applyRecognition(post.id, recognition(post.text, post.modelReceiptId)));
    const input = await inMonitor(definition, () => loadActionInput());
    const snapshot = await inMonitor(definition, () => publicV2Snapshot());
    assert.equal(snapshot.events[0]!.status, "completed"); assert.equal(snapshot.events[0]!.time, at);
    assert.equal(snapshot.events[0]!.updates[0]!.sources[0]!.postId, post.id);
    assert.equal(input.posts[0]!.processing_status, "processed");
    assert.deepEqual(input.events[0]!.summary, input.actions[0]!.summary);
    assert.equal(input.posts[0]!.text, post.text);
    assert.equal("bindings" in input, false);
    assert.deepEqual(input.actions[0]!.sources, [{ postId: post.id }]);
    for (const object of [...input.actions, ...input.events, ...snapshot.events]) {
      assert.equal("text" in object || "raw" in object || "recognition" in object || "excerpt" in object, false);
    }
    assert.doesNotMatch(JSON.stringify(snapshot), /"(?:text|quoted_post|translation)":/);
    const [receipt] = await sql`SELECT status FROM receipts WHERE id=${post.modelReceiptId}`;
    assert.equal(receipt!.status, "completed");
  }
});

test("keyword false positives are hidden only when the platform filter is enabled", async () => {
  for (const [index, resetOnly] of [false, true].entries()) {
    const definition = { ...codex, collection: { ...codex.collection, resetOnly } };
    const post = await addPost(definition, "My credit card arrived.", { id: `unrelated-${index}` });
    const answer = recognition(post.text, post.modelReceiptId, []); answer.relevant = false;
    await inMonitor(definition, () => applyRecognition(post.id, answer));
    const saved = await inMonitor(definition, () => sourcePost(post.id));
    assert.equal(saved!.filtered_out, resetOnly);
    assert.equal(saved!.processing_status, "processed");
    assert.equal(saved!.text, post.text);
    assert.equal(saved!.model_receipt_id, post.modelReceiptId);
    assert.equal((await inMonitor(definition, () => loadActionInput())).events.length, 0);
  }
});

test("related explanations, uncertain results and failed recognition are never hidden", async () => {
  const definition = { ...codex, collection: { ...codex.collection, resetOnly: true } };
  const related = await addPost(definition, "This reset credit follows the announced eligibility rules.");
  await inMonitor(definition, () => applyRecognition(related.id, recognition(related.text, related.modelReceiptId, [])));
  assert.equal((await inMonitor(definition, () => sourcePost(related.id)))!.filtered_out, false);
  const uncertain = await addPost(definition, "A reset might happen.");
  const answer = recognition(uncertain.text, uncertain.modelReceiptId, []); answer.relevant = false; answer.needsReview = true;
  await inMonitor(definition, () => applyRecognition(uncertain.id, answer));
  const saved = (await inMonitor(definition, () => sourcePost(uncertain.id)))!;
  assert.equal(saved.filtered_out, false); assert.equal(saved.processing_status, "needs_attention");
  const invalid = await addPost(definition, "We reset usage.");
  answers.set(invalid.id, recognition(invalid.text, 0)); invalidOutput = true;
  await inMonitor(definition, () => processPending());
  const failed = (await inMonitor(definition, () => sourcePost(invalid.id)))!;
  assert.equal(failed.filtered_out, false); assert.equal(failed.processing_status, "needs_attention");
});

for (const definition of [codex, claude, grok]) test(`${definition.monitorId}: reviewable recognition preserves post title and summary without accepting actions`, async () => {
  const post = await addPost(definition, "A reset might happen.");
  const answer = recognition(post.text, 0, []); answer.needsReview = true;
  answer.title = local("Quota announcement needs verification"); answer.summary = local("The source describes a possible quota update.");
  answers.set(post.id, answer);
  const before = model.hits();
  await inMonitor(definition, () => processPending());
  const saved = (await inMonitor(definition, () => sourcePost(post.id)))!;
  assert.equal(saved.processing_status, "needs_attention"); assert.equal(saved.filtered_out, false);
  assert.deepEqual(saved.title, answer.title); assert.deepEqual(saved.summary, answer.summary);
  assert.equal(Object.keys(saved.title!).length, 7); assert.equal(Object.keys(saved.summary!).length, 7);
  const input = await inMonitor(definition, () => loadActionInput());
  assert.equal(input.events.length, 0); assert.equal(input.actions.length, 0);
  await inMonitor(definition, () => processPending());
  assert.equal(model.hits() - before, 1, "saving review text must not buy another recognition");
});

for (const definition of [codex, claude, grok]) test(`${definition.monitorId}: rejected action evidence retains the recognized post text`, async () => {
  const post = await addPost(definition, "We will reset usage.");
  const answer = recognition(post.text, post.modelReceiptId, [claim("We reset usage for everyone.")]);
  await inMonitor(definition, () => applyRecognition(post.id, answer));
  const saved = (await inMonitor(definition, () => sourcePost(post.id)))!;
  assert.equal(saved.processing_status, "needs_attention"); assert.match(saved.review_reason!, /本帖明确依据/);
  assert.deepEqual(saved.title, answer.title); assert.deepEqual(saved.summary, answer.summary);
  const input = await inMonitor(definition, () => loadActionInput());
  assert.equal(input.events.length, 0); assert.equal(input.actions.length, 0);
});

test("duplicate scope codes retain recognized post text for review without writing actions", async () => {
  const post = await addPost(codex, "We reset monthly usage.");
  const answer = recognition(post.text, 0, [claim(post.text, { scope: { ...scope, quotaWindowCodes: ["monthly", "monthly"] } })]);
  answer.title = local("Monthly usage update"); answer.summary = local("A monthly reset was reported, but its scope needs review.");
  answers.set(post.id, answer);
  const before = model.hits();
  await inMonitor(codex, () => processPending());
  const saved = (await inMonitor(codex, () => sourcePost(post.id)))!;
  assert.equal(saved.processing_status, "needs_attention"); assert.match(saved.review_reason!, /重复的目录代码/);
  assert.deepEqual(saved.title, answer.title); assert.deepEqual(saved.summary, answer.summary);
  const input = await inMonitor(codex, () => loadActionInput());
  assert.equal(input.events.length, 0); assert.equal(input.actions.length, 0);
  const [receipt] = await sql`SELECT status FROM receipts WHERE id=${saved.model_receipt_id}`;
  assert.equal(receipt!.status, "completed"); assert.equal(model.hits() - before, 1);
});

test("pending posts use current filter settings without reclassifying already processed posts", async () => {
  const post = await addPost(codex, "My credit card arrived.");
  const answer = recognition(post.text, 0, []); answer.relevant = false; answers.set(post.id, answer);
  const filtered = { ...codex, collection: { ...codex.collection, resetOnly: true } };
  await inMonitor(filtered, () => processPending());
  assert.equal((await inMonitor(codex, () => sourcePost(post.id)))!.filtered_out, true);
  const calls = model.hits();
  await inMonitor(codex, () => processPending());
  assert.equal(model.hits(), calls);
  assert.equal((await inMonitor(codex, () => sourcePost(post.id)))!.filtered_out, true);
});

test("saved direct reply parents reach the model with their event and can identify an official answer", async () => {
  const definition = { ...codex, collection: { ...codex.collection, includeSelfReplies: true } };
  const parent = await addPost(definition, "We will issue a banked reset.", { publishedAt: "2026-10-23T11:00:00Z" });
  await inMonitor(definition, () => applyRecognition(parent.id, recognition(parent.text, parent.modelReceiptId, [claim(parent.text, { action: "announce", kind: "reset_credit" })])));
  const eventId = (await inMonitor(definition, () => loadActionInput())).events[0]!.id;
  const reply = await addPost(definition, "All done", { replyTo: { postId: parent.id, author: definition.authors[0]!.handle } });
  answers.set(reply.id, recognition(reply.text, 0, [claim(reply.text, { eventId, localEventKey: null, kind: "reset_credit" })]));
  beforeModelReply = async () => {
    // The stub receives the real model request; parent originals remain internal to that request.
    const input = await inMonitor(definition, () => loadActionInput());
    assert.equal(input.posts.find(row => row.id === reply.id)!.reply_to!.postId, parent.id);
  };
  await inMonitor(definition, () => processPending());
  const snapshot = await inMonitor(definition, () => publicV2Snapshot());
  assert.deepEqual(modelInputs.get(reply.id).targets.find((target: { id: string }) => target.id === reply.id).replyTo, { postId: parent.id, author: definition.authors[0]!.handle });
  assert.equal(modelInputs.get(reply.id).context[0].text, parent.text);
  assert.ok(modelInputs.get(reply.id).events.some((event: { id: string }) => event.id === eventId));
  assert.equal(snapshot.events[0]!.status, "completed");
  assert.equal(snapshot.events[0]!.updates[0]!.sources[0]!.postId, reply.id);
  assert.equal((await inMonitor(definition, () => sourcePost(reply.id)))!.processing_status, "processed");
});

test("bare replies without parents are reviewed, while explicit independent quota facts remain usable", async () => {
  const definition = { ...codex, collection: { ...codex.collection, includeReplies: true, resetOnly: true } };
  const reply = await addPost(definition, "OK fine", { replyTo: { postId: "missing", author: "SomeoneElse" } });
  const noContext = recognition(reply.text, reply.modelReceiptId, []); noContext.relevant = false;
  await inMonitor(definition, () => applyRecognition(reply.id, noContext));
  const saved = (await inMonitor(definition, () => sourcePost(reply.id)))!;
  assert.equal(saved.processing_status, "needs_attention"); assert.equal(saved.filtered_out, false);
  const explicit = await addPost(definition, "We reset usage for everyone.", { replyTo: { postId: null, author: null } });
  await inMonitor(definition, () => applyRecognition(explicit.id, recognition(explicit.text, explicit.modelReceiptId)));
  assert.equal((await inMonitor(definition, () => publicV2Snapshot())).events[0]!.status, "completed");
});

test("reply context can identify an object but cannot supply the reply's missing action evidence", async () => {
  const parent = await addPost(codex, "We reset usage.", { publishedAt: "2026-10-23T11:00:00Z" });
  const reply = await addPost(codex, "That is the plan.", { replyTo: { postId: parent.id, author: codex.authors[0]!.handle } });
  await inMonitor(codex, () => applyRecognition(reply.id, recognition(reply.text, reply.modelReceiptId, [claim(parent.text)])));
  assert.equal((await inMonitor(codex, () => sourcePost(reply.id)))!.processing_status, "needs_attention");
  assert.equal((await inMonitor(codex, () => publicV2Snapshot())).events.length, 0);
});

test("a saved direct reply verifies cross-author association and prioritizes old parent events", async () => {
  const definition = { ...codex, authors: [...codex.authors, { handle: "OtherOfficial", name: "Other official" }], collection: { ...codex.collection, includeReplies: true } };
  const parent = await addPost(definition, "We will reset usage.", { publishedAt: "2026-10-10T11:00:00Z" });
  await inMonitor(definition, () => applyRecognition(parent.id, recognition(parent.text, parent.modelReceiptId, [claim(parent.text, { action: "announce" })])));
  const eventId = (await inMonitor(definition, () => loadActionInput())).events[0]!.id;
  const reply = await addPost(definition, "All done", { author: "OtherOfficial", replyTo: { postId: parent.id, author: definition.authors[0]!.handle } });
  answers.set(reply.id, recognition(reply.text, 0, [claim(reply.text, { eventId, localEventKey: null })]));
  await inMonitor(definition, () => processPending());
  assert.ok(modelInputs.get(reply.id).events.some((event: { id: string }) => event.id === eventId));
  assert.equal((await inMonitor(definition, () => sourcePost(reply.id)))!.processing_status, "processed");
  assert.equal((await inMonitor(definition, () => publicV2Snapshot())).events[0]!.status, "completed");
});

test("a bare reply cannot be attached to another event merely because the author matches", async () => {
  const first = await addPost(codex, "We will reset usage.", { publishedAt: "2026-10-23T10:00:00Z" });
  await inMonitor(codex, () => applyRecognition(first.id, recognition(first.text, first.modelReceiptId, [claim(first.text, { action: "announce" })])));
  const firstId = (await inMonitor(codex, () => loadActionInput())).events[0]!.id;
  const other = await addPost(codex, "We will issue a banked reset.", { publishedAt: "2026-10-23T11:00:00Z" });
  await inMonitor(codex, () => applyRecognition(other.id, recognition(other.text, other.modelReceiptId, [claim(other.text, { action: "announce", kind: "reset_credit" })])));
  const reply = await addPost(codex, "All done", { replyTo: { postId: other.id, author: codex.authors[0]!.handle } });
  await inMonitor(codex, () => applyRecognition(reply.id, recognition(reply.text, reply.modelReceiptId, [claim(reply.text, { eventId: firstId, localEventKey: null })])));
  assert.equal((await inMonitor(codex, () => sourcePost(reply.id)))!.processing_status, "needs_attention");
  assert.equal((await inMonitor(codex, () => publicV2Snapshot())).events.find(event => event.id === firstId)!.status, "announced");
});

test("an official reply can announce a new reset when its saved parent supplies a unique object", async () => {
  const parent = await addPost(codex, "Please grant a banked reset.", { publishedAt: "2026-10-23T11:00:00Z" });
  await inMonitor(codex, () => applyRecognition(parent.id, recognition(parent.text, parent.modelReceiptId, [])));
  const reply = await addPost(codex, "OK fine", { replyTo: { postId: parent.id, author: codex.authors[0]!.handle } });
  await inMonitor(codex, () => applyRecognition(reply.id, recognition(reply.text, reply.modelReceiptId, [claim(reply.text, { action: "announce", kind: "reset_credit", role: "answer" })])));
  const snapshot = await inMonitor(codex, () => publicV2Snapshot());
  assert.equal(snapshot.events[0]!.status, "announced");
  assert.equal(snapshot.events[0]!.type, "reset_credit");
  assert.deepEqual(snapshot.events[0]!.updates[0]!.sources.map(source => source.postId), [reply.id]);
});

test("one post creates announce and confirm actions for one local event and discards forecast time on completion", async () => {
  const text = "We will reset usage at 15:00 UTC. All done.";
  const post = await addPost(codex, text);
  const actions = [claim("We will reset usage at 15:00 UTC", { action: "announce", timeExcerpt: "at 15:00 UTC" }), claim("All done")];
  await inMonitor(codex, () => applyRecognition(post.id, recognition(text, post.modelReceiptId, actions)));
  const input = await inMonitor(codex, () => loadActionInput()), snapshot = await inMonitor(codex, () => publicV2Snapshot());
  assert.equal(input.events.length, 1); assert.equal(input.actions.length, 2);
  assert.equal(snapshot.events[0]!.updates.length, 2); assert.equal(snapshot.events[0]!.status, "completed");
  assert.equal(snapshot.events[0]!.time, at); assert.equal(snapshot.announcedResetTime, null); assert.equal(snapshot.resetTime, at);
});

test("a repeated accepted action adds its source and does not overwrite accepted facts", async () => {
  const first = await addPost(codex, "We reset usage.");
  await inMonitor(codex, () => applyRecognition(first.id, recognition(first.text, first.modelReceiptId)));
  const input = await inMonitor(codex, () => loadActionInput()), original = input.actions[0]!;
  const second = await addPost(codex, "We reset usage for everyone.", { publishedAt: "2026-10-23T13:00:00Z" });
  await inMonitor(codex, () => applyRecognition(second.id, recognition(second.text, second.modelReceiptId,
    [claim(second.text, { eventId: original.event_id, localEventKey: null, existingActionId: original.id, title: local("New phrasing") })])));
  const after = await inMonitor(codex, () => loadActionInput()), event = (await inMonitor(codex, () => publicV2Snapshot())).events[0]!;
  assert.equal(after.actions.length, 1); assert.deepEqual(after.actions[0]!.title, original.title);
  assert.equal(after.actions[0]!.sequence, original.sequence);
  assert.equal(event.updates[0]!.sources.length, 2); assert.equal(event.updates[0]!.publishedAt, at);
});

test("valid facts survive review flags and catalog gaps while fabricated evidence and widened scope stay blocked", async () => {
  const cases: Array<{ text: string; patch: Partial<Claim>; needsReview?: boolean; accepted: boolean; review: boolean }> = [
    { text: "We reset usage.", patch: {}, needsReview: true, accepted: true, review: true },
    { text: "We will reset usage.", patch: { excerpt: "We reset usage for everyone." }, accepted: false, review: true },
    { text: "We will reset usage soon.", patch: { action: "announce", timeExcerpt: "soon" }, accepted: true, review: false },
    { text: "We reset usage for paid users.", patch: { rawScope: { audienceSource: "paid users", plans: null, audienceZh: "付费用户", productsZh: null }, scopeExcerpt: "paid users" }, accepted: false, review: true },
    { text: "We reset usage.", patch: { scope: { ...scope, productCodes: ["unconfigured-product"] } }, accepted: true, review: false },
  ];
  for (const value of cases) {
    const post = await addPost(codex, value.text), rec = recognition(value.text, post.modelReceiptId, [claim(value.text, value.patch)]);
    rec.needsReview = value.needsReview ?? false;
    await inMonitor(codex, () => applyRecognition(post.id, rec));
    const saved = (await inMonitor(codex, () => sourcePost(post.id)))!;
    assert.equal(saved.processing_status, value.review ? "needs_attention" : "processed");
    assert.deepEqual(saved.title, rec.title); assert.deepEqual(saved.summary, rec.summary);
    const input = await inMonitor(codex, () => loadActionInput());
    assert.equal(input.actions.some(action => action.sources.some(source => source.postId === post.id)), value.accepted);
  }
  assert.equal((await inMonitor(codex, () => loadActionInput())).actions.length, 3);
});

test("recognition reads saved original text even when the collection receipt no longer contains a body", async () => {
  const post = await addPost(codex, "We reset usage.");
  answers.set(post.id, recognition(post.text, 0));
  await sql`UPDATE receipts SET response=NULL WHERE id=${post.receiptId}`;
  assert.equal((await inMonitor(codex, () => processPending())).processed, 1);
  assert.equal((await inMonitor(codex, () => sourcePost(post.id)))!.processing_status, "processed");
});

test("a missing saved body requires review instead of reading the collection receipt", async () => {
  const post = await addPost(codex, "We reset usage.");
  const title = local("Previously saved title"), summary = local("Previously saved summary");
  await sql`UPDATE monitor_source_posts SET text=NULL,title=${sql.json(title)},summary=${sql.json(summary)} WHERE monitor_id='codex' AND id=${post.id}`;
  const before = model.hits();
  assert.equal((await inMonitor(codex, () => processPending())).processed, 1);
  const saved = (await inMonitor(codex, () => sourcePost(post.id)))!;
  assert.equal(saved.processing_status, "needs_attention");
  assert.deepEqual(saved.title, title); assert.deepEqual(saved.summary, summary);
  assert.equal(model.hits(), before);
});

test("a saved quote cannot supply the outer post's action evidence", async () => {
  const post = await addPost(codex, "No update today.", { quotedPost: { id: "quoted-1", author: "thsottiaux", relation: "quote", text: "We reset usage.", publishedAt: at, url: "https://x.com/thsottiaux/status/quoted-1" } });
  await inMonitor(codex, () => applyRecognition(post.id, recognition(post.text, post.modelReceiptId, [claim("We reset usage.")])));
  assert.equal((await inMonitor(codex, () => sourcePost(post.id)))!.processing_status, "needs_attention");
  assert.equal((await inMonitor(codex, () => loadActionInput())).actions.length, 0);
});

test("received model answers are reused after a worker interruption and manual review wins", async () => {
  const post = await addPost(codex, "We reset usage.");
  answers.set(post.id, recognition(post.text, 0));
  const saved = (await inMonitor(codex, () => sourcePost(post.id)))!;
  const input = { targets: [{ id: post.id, author: codex.authors[0]!.handle, text: post.text, publishedAt: at, replyTo: null, quotedPostId: null, version: saved.version }], context: [], events: [] };
  const before = model.hits();
  const first = await inMonitor(codex, () => recognizeThread(input, "same-work"));
  const second = await inMonitor(codex, () => recognizeThread(input, "same-work"));
  assert.equal(first.receiptId, second.receiptId); assert.equal(model.hits() - before, 1);
  await sql`UPDATE monitor_source_posts SET processing_status='processed' WHERE monitor_id='codex' AND id=${post.id}`;
  assert.deepEqual(await inMonitor(codex, () => applyRecognition(post.id, { ...second.posts[0]!, receiptId: second.receiptId, model: second.model, promptVersion: second.promptVersion })), { eventIds: [], notify: [] });
  assert.equal((await inMonitor(codex, () => loadActionInput())).actions.length, 0);
});

test("definite failed processing does not automatically buy another response", async () => {
  const post = await addPost(codex, "We reset usage."); answers.set(post.id, recognition(post.text, 0));
  transportFailure = true; const before = model.hits();
  await assert.rejects(inMonitor(codex, () => processPending()), /429|failed/);
  transportFailure = false;
  assert.equal((await inMonitor(codex, () => processPending())).processed, 0);
  assert.equal(model.hits() - before, 1);
  assert.equal((await inMonitor(codex, () => sourcePost(post.id)))!.processing_status, "failed");
});

test("an already in-flight receipt leaves the post pending and reuses its original answer", async () => {
  const post = await addPost(codex, "We reset usage.");
  answers.set(post.id, recognition(post.text, 0));
  const entered = gate(), release = gate(), before = model.hits();
  beforeModelReply = async () => { entered.open(); await release.promise; };
  const processing = inMonitor(codex, () => processPending());
  try {
    await entered.promise;
    await assert.rejects(inMonitor(codex, () => processPending()), /in flight/);
    assert.equal((await inMonitor(codex, () => sourcePost(post.id)))!.processing_status, "pending");
  } finally { release.open(); }
  await processing;
  assert.equal((await inMonitor(codex, () => sourcePost(post.id)))!.processing_status, "processed");
  assert.equal(model.hits() - before, 1);
});

test("invalid model schema is rejected with review state in the same recovery path", async () => {
  const post = await addPost(codex, "We reset usage."); invalidOutput = true;
  const title = local("Existing title"), summary = local("Existing summary");
  await sql`UPDATE monitor_source_posts SET title=${sql.json(title)},summary=${sql.json(summary)} WHERE monitor_id='codex' AND id=${post.id}`;
  assert.equal((await inMonitor(codex, () => processPending())).processed, 1);
  const saved = (await inMonitor(codex, () => sourcePost(post.id)))!;
  assert.equal(saved.processing_status, "needs_attention");
  assert.deepEqual(saved.title, title); assert.deepEqual(saved.summary, summary);
  const [receipt] = await sql`SELECT status FROM receipts WHERE id=${saved.model_receipt_id}`;
  assert.equal(receipt!.status, "failed");
});

test("editorial translation preserves manual text and cannot write status or time", async () => {
  const post = await addPost(codex, "We reset usage.");
  await inMonitor(codex, () => applyRecognition(post.id, recognition(post.text, post.modelReceiptId)));
  const input = await inMonitor(codex, () => loadActionInput()), eventId = input.events[0]!.id;
  await sql`UPDATE monitor_event_records SET title='{"zh":"人工标题"}'::jsonb,summary='{"en":"Manual summary"}'::jsonb WHERE monitor_id='codex' AND id=${eventId}`;
  const before = (await inMonitor(codex, () => publicV2Snapshot())).events[0]!;
  assert.equal((await inMonitor(codex, () => processPublicV2Pending())).enriched, 1);
  const after = (await inMonitor(codex, () => publicV2Snapshot())).events[0]!;
  assert.equal(after.title.zh, "人工标题"); assert.equal(after.summary!.en, "Manual summary");
  assert.equal(Object.keys(after.title).length, 7); assert.equal(after.status, before.status); assert.equal(after.time, before.time);
  assert.deepEqual((await inMonitor(codex, () => loadActionInput())).actions, input.actions);
});

test("event edits translate title, summary and scope independently of collection, including withdrawn events", async () => {
  const post = await addPost(codex, "We reset usage.");
  await inMonitor(codex, () => applyRecognition(post.id, recognition(post.text, post.modelReceiptId)));
  await inMonitor(codex, async () => {
    const event = (await listEvents()).events[0]!;
    await updateMonitorEvent(event.id, { version: event.version, patch: { title: { zh: "人工标题" }, summary: { zh: "人工摘要" },
      scope: { ...scope, note: { zh: "仅适用明确范围" } } } }, "reviewer");
    const edited = (await loadActionInput()).events[0]!;
    assert.deepEqual(edited.title, { zh: "人工标题" });
    assert.deepEqual(edited.summary, { zh: "人工摘要" });
    assert.deepEqual(edited.scope!.note, { zh: "仅适用明确范围" });
    await sql`UPDATE monitor_event_records SET withdrawn=true WHERE monitor_id='codex' AND id=${event.id}`;
    process.env.COLLECT_ENABLED = "false";
    const scheduled = createMonitorServer(codex).schedules!.find(item => item.name === "codex-reset.translate")!;
    assert.equal(scheduled.cron, "* * * * *");
    assert.equal(scheduled.when!(), true);
    config.modelCallsEnabled = false;
    const before = model.hits();
    assert.equal(scheduled.when!(), false);
    assert.deepEqual(await processPublicV2Pending(), { enriched: 0 });
    assert.equal(model.hits(), before);
    config.modelCallsEnabled = true;
    assert.deepEqual(await scheduled.run(), { enriched: 1 });
    const translated = (await loadActionInput()).events[0]!;
    assert.equal(translated.title!.zh, "人工标题");
    assert.equal(translated.summary!.zh, "人工摘要");
    assert.equal(translated.scope!.note!.zh, "仅适用明确范围");
    assert.equal(Object.keys(translated.scope!.note!).length, 7);
    assert.equal(translated.withdrawn, true);
    assert.deepEqual(translated.scope!.productCodes, edited.scope!.productCodes);
    assert.deepEqual((await publicV2Snapshot()).events, []);
  });
});

test("a concurrent manual edit prevents an old translation from replacing the new content", async () => {
  const post = await addPost(codex, "We reset usage.");
  await inMonitor(codex, () => applyRecognition(post.id, recognition(post.text, post.modelReceiptId)));
  const event = (await inMonitor(codex, () => loadActionInput())).events[0]!;
  await sql`UPDATE monitor_event_records SET title='{"zh":"旧标题"}'::jsonb,scope=${sql.json({ ...scope, note: { zh: "旧范围" } })} WHERE monitor_id='codex' AND id=${event.id}`;
  translationRace = async () => { await sql`UPDATE monitor_event_records SET title='{"zh":"新标题"}'::jsonb,scope=${sql.json({ ...scope, note: { zh: "新范围" } })},updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${event.id}`; };
  assert.equal((await inMonitor(codex, () => processPublicV2Pending())).enriched, 0);
  assert.deepEqual((await inMonitor(codex, () => loadActionInput())).events[0]!.title, { zh: "新标题" });
  assert.deepEqual((await inMonitor(codex, () => loadActionInput())).events[0]!.scope!.note, { zh: "新范围" });
});

test("an unsent editorial translation resumes after its budget is restored", async () => {
  const post = await addPost(codex, "We reset usage.");
  await inMonitor(codex, () => applyRecognition(post.id, recognition(post.text, post.modelReceiptId)));
  const event = (await inMonitor(codex, () => loadActionInput())).events[0]!;
  await sql`UPDATE monitor_event_records SET title='{"zh":"人工标题"}'::jsonb WHERE monitor_id='codex' AND id=${event.id}`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('llm',0,100,100)`;
  const before = model.hits();
  await assert.rejects(inMonitor(codex, () => processPublicV2Pending()), /Budget for llm exhausted/);
  assert.equal(model.hits(), before);
  assert.equal((await sql`SELECT 1 FROM monitor_state WHERE monitor_id='codex' AND key=${`public_v2:translation:event:${event.id}`}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE service='llm'`).length, 0);
  await sql`UPDATE budgets SET per_minute=100 WHERE service='llm'`;
  assert.equal((await inMonitor(codex, () => processPublicV2Pending())).enriched, 1);
  assert.equal(model.hits() - before, 1);
  assert.equal(Object.keys((await inMonitor(codex, () => loadActionInput())).events[0]!.title!).length, 7);
});

test("an in-flight editorial response is not marked failed and is reused without another purchase", async () => {
  const post = await addPost(codex, "We reset usage.");
  await inMonitor(codex, () => applyRecognition(post.id, recognition(post.text, post.modelReceiptId)));
  const event = (await inMonitor(codex, () => loadActionInput())).events[0]!;
  await sql`UPDATE monitor_event_records SET title='{"zh":"人工标题"}'::jsonb WHERE monitor_id='codex' AND id=${event.id}`;
  const entered = gate(), release = gate(), before = model.hits();
  beforeModelReply = async () => { entered.open(); await release.promise; };
  const processing = inMonitor(codex, () => processPublicV2Pending());
  try {
    await entered.promise;
    assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 0, enrichmentPending: 1 });
    assert.equal((await sql`SELECT 1 FROM monitor_state WHERE monitor_id='codex' AND key=${`public_v2:translation:event:${event.id}`}`).length, 0);
  } finally { release.open(); }
  assert.equal((await processing).enriched, 1);
  assert.equal(model.hits() - before, 1);
  assert.equal(Object.keys((await inMonitor(codex, () => loadActionInput())).events[0]!.title!).length, 7);
});

test("an in-flight translation does not block a different post's missing languages", async () => {
  const original = await addPost(codex, "We reset usage.");
  await inMonitor(codex, () => applyRecognition(original.id, recognition(original.text, original.modelReceiptId)));
  const event = (await inMonitor(codex, () => loadActionInput())).events[0]!;
  await sql`UPDATE monitor_event_records SET title='{"zh":"正在翻译的事件"}'::jsonb WHERE monitor_id='codex' AND id=${event.id}`;
  const entered = gate(), release = gate(), before = model.hits();
  beforeModelReply = async () => { beforeModelReply = null; entered.open(); await release.promise; };
  const processing = inMonitor(codex, () => processPublicV2Pending());
  try {
    await entered.promise;
    const other = await addPost(codex, "Unrelated saved original.");
    await sql`UPDATE monitor_source_posts SET title='{"zh":"独立帖子文案"}'::jsonb,summary=NULL,processing_status='needs_attention',review_reason='保留原因' WHERE monitor_id='codex' AND id=${other.id}`;
    assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 1, enrichmentPending: 1 });
    const saved = (await inMonitor(codex, () => sourcePost(other.id)))!;
    assert.equal(Object.keys(saved.title!).length, 7);
    assert.equal(saved.processing_status, "needs_attention"); assert.equal(saved.review_reason, "保留原因");
  } finally { release.open(); }
  assert.equal((await processing).enriched, 1);
  assert.equal(model.hits() - before, 2);
});

test("collection, recognition and translation safety valves prevent external calls", async () => {
  const before = model.hits();
  process.env.COLLECT_ENABLED = "false";
  const collected = await inMonitor(codex, () => collectPosts());
  assert.equal(collected.stored, 0); assert.equal(collected.pages, 0);
  assert.equal((await inMonitor(codex, () => processPending())).processed, 0);
  config.modelCallsEnabled = false;
  assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 0 });
  process.env.COLLECT_ENABLED = "true";
  assert.equal((await inMonitor(codex, () => processPending())).processed, 0);
  assert.equal(model.hits(), before);
});

test("all authors use the fixed collection window, replies are excluded and only a successful round advances the checkpoint", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T13:00:00Z") });
  const since = "2026-10-23T11:00:00.000Z";
  await inMonitor(grok, async () => {
    await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('grok',${cursorKey()},${sql.json({ checkpointVersion: 2, scannedThrough: since })})`;
    const collected = await collectPosts({ startedAt: new Date("2026-10-23T12:30:00Z"), roundId: "fixed-round" });
    assert.equal(collected.stored, 2); assert.equal(collected.pages, 2);
    assert.deepEqual((await loadActionInput()).posts.map(post => post.id).sort(), ["900101", "900201"]);
    assert.equal(collectionQueries.length, 2);
    for (const query of collectionQueries) {
      assert.match(query.searchParams.get("query")!, /-filter:replies/);
      assert.match(query.searchParams.get("query")!, new RegExp(`since_time:${Date.parse(since) / 1000}`));
    }
    collectionFailure = true;
    await assert.rejects(monitorTick(), /429/);
    const [state] = await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key=${cursorKey()}`;
    assert.equal(state!.value.scannedThrough, since);
    collectionFailure = false;
    for (const post of (await loadActionInput()).posts) answers.set(post.id, recognition("We reset usage.", 0));
    const result = await monitorTick();
    assert.ok("pending" in result && result.pending === 0);
    const [advanced] = await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key=${cursorKey()}`;
    assert.ok(Date.parse(advanced!.value.scannedThrough) > Date.parse(since));
  });
});

test("pending editorial translation never blocks a completed collection checkpoint", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T13:00:00Z") });
  const checkpointKey = inMonitor(grok, () => cursorKey());
  const post = await addPost(grok, "We reset usage.", { id: "existing-editorial-post" });
  await inMonitor(grok, () => applyRecognition(post.id, recognition(post.text, post.modelReceiptId)));
  const event = (await inMonitor(grok, () => loadActionInput())).events[0]!;
  await sql`UPDATE monitor_event_records SET title='{"zh":"待翻译标题"}'::jsonb WHERE monitor_id='grok' AND id=${event.id}`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('grok',${checkpointKey},${sql.json({ checkpointVersion: 2, scannedThrough: "2026-10-23T11:00:00Z" })})`;
  for (const id of ["900101", "900201"]) answers.set(id, recognition("We reset usage.", 0));
  const result = await inMonitor(grok, () => monitorTick());
  assert.ok("pending" in result && result.pending === 0);
  assert.equal("enriched" in result, false);
  assert.deepEqual((await inMonitor(grok, () => loadActionInput())).events.find(item => item.id === event.id)!.title, { zh: "待翻译标题" });
  const [advanced] = await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key=${checkpointKey}`;
  assert.equal(advanced!.value.scannedThrough, "2026-10-23T13:00:00.000Z");
  transportFailure = true;
  await assert.rejects(inMonitor(grok, () => processPublicV2Pending()));
  const [unchanged] = await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key=${checkpointKey}`;
  assert.deepEqual(unchanged!.value, advanced!.value);
});

test("a preflight model budget refusal stays pending and resumes after the window resets", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T13:00:00Z") });
  const since = "2026-10-23T11:00:00.000Z", before = model.hits();
  for (const id of ["900101", "900201"]) answers.set(id, recognition("We reset usage.", 0));
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('llm',1,100,100)`;
  await inMonitor(grok, async () => {
    await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('grok',${cursorKey()},${sql.json({ checkpointVersion: 2, scannedThrough: since })})`;
    await assert.rejects(monitorTick(), /Budget for llm exhausted \(minute\)/);
    const first = await loadActionInput();
    assert.equal(first.posts.filter(post => post.processing_status === "processed").length, 1);
    assert.equal(first.posts.filter(post => post.processing_status === "pending").length, 1);
    assert.equal(first.posts.some(post => post.processing_status === "failed"), false);
    assert.equal(model.hits() - before, 1);
    const [blocked] = await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key=${cursorKey()}`;
    assert.equal(blocked!.value.scannedThrough, since);
    const [reserved] = await sql`SELECT count(*)::int AS count FROM receipt_attempts WHERE service='llm'`;
    assert.equal(reserved!.count, 1, "budget refusal creates no paid attempt");
    await sql`UPDATE receipt_attempts SET started_at=now()-interval '2 minutes' WHERE service='llm'`;
    const resumed = await monitorTick();
    assert.ok("pending" in resumed && resumed.pending === 0);
    assert.equal((await loadActionInput()).posts.every(post => post.processing_status === "processed"), true);
    assert.equal(model.hits() - before, 2, "only the unsent pending post buys its first answer");
    const [advanced] = await sql`SELECT value FROM monitor_state WHERE monitor_id='grok' AND key=${cursorKey()}`;
    assert.equal(advanced!.value.scannedThrough, "2026-10-23T13:00:00.000Z");
  });
});

test("official cancellation is terminal across later announcements and confirmations", async () => {
  const initial = await addPost(codex, "We will reset usage.");
  await inMonitor(codex, () => applyRecognition(initial.id, recognition(initial.text, initial.modelReceiptId, [claim(initial.text, { action: "announce" })])));
  const eventId = (await inMonitor(codex, () => loadActionInput())).events[0]!.id;
  const update = async (text: string, action: Claim["action"], time: string, invalidatesEvent = false) => {
    const post = await addPost(codex, text, { publishedAt: time });
    await inMonitor(codex, () => applyRecognition(post.id, recognition(text, post.modelReceiptId,
      [claim(text, { eventId, localEventKey: null, action, invalidatesEvent })])));
    return (await inMonitor(codex, () => publicV2Snapshot())).events[0]!;
  };
  assert.equal((await update("The reset has been cancelled.", "amend", "2026-10-23T13:00:00Z", true)).status, "cancelled");
  assert.equal((await update("We reset usage.", "confirm", "2026-10-23T14:00:00Z")).status, "cancelled");
  assert.equal((await update("We will reset usage tomorrow.", "announce", "2026-10-23T15:00:00Z")).status, "cancelled");
  assert.equal((await update("We reset usage.", "confirm", "2026-10-23T16:00:00Z")).status, "cancelled");
  assert.equal((await update("Usage reset is still propagating for some accounts.", "progress", "2026-10-23T17:00:00Z")).status, "cancelled");
});

test("future/conditional confirmation and account-specific campaign closure do not change event state", async () => {
  for (const text of ["We will reset usage tomorrow.", "We have not yet reset usage.", "My usage has reset.", "If usage has reset, try it again.", "Has usage reset?"]) {
    const post = await addPost(codex, text);
    await inMonitor(codex, () => applyRecognition(post.id, recognition(text, post.modelReceiptId)));
    assert.equal((await inMonitor(codex, () => sourcePost(post.id)))!.processing_status, "needs_attention");
  }
  const text = "My one-time bonus credit for cloud sessions has expired.";
  const post = await addPost(claude, text);
  await inMonitor(claude, () => applyRecognition(post.id, recognition(text, post.modelReceiptId,
    [claim(text, { kind: "bonus_credit", action: "progress" })])));
  assert.equal((await inMonitor(claude, () => sourcePost(post.id)))!.processing_status, "needs_attention");
  assert.equal((await inMonitor(claude, () => loadActionInput())).events.length, 0);
});

test("cross-author follow-ups require the event's exact saved source link", async () => {
  const initial = await addPost(grok, "We will reset usage.", { id: "991001" });
  await inMonitor(grok, () => applyRecognition(initial.id, recognition(initial.text, initial.modelReceiptId, [claim(initial.text, { action: "announce" })])));
  const event = (await inMonitor(grok, () => loadActionInput())).events[0]!;
  for (const [url, accepted] of [[`https://x.com/bot/status/9910019`, false], [`https://x.com/bot/status/991001?ref=test`, true]] as const) {
    const post = await addPost(grok, `All done. ${url}`, { author: grok.authors[1]!.handle, publishedAt: "2026-10-23T13:00:00Z" });
    await inMonitor(grok, () => applyRecognition(post.id, recognition(post.text, post.modelReceiptId,
      [claim("All done", { eventId: event.id, localEventKey: null })])));
    assert.equal((await inMonitor(grok, () => sourcePost(post.id)))!.processing_status, accepted ? "processed" : "needs_attention");
  }
  assert.equal((await inMonitor(grok, () => publicV2Snapshot())).events[0]!.status, "completed");
});

test("reward closure, reopening and expiry are progress and preserve confirmation", async () => {
  const initial = await addPost(claude, "One-time bonus credit for cloud sessions is now available.");
  await inMonitor(claude, () => applyRecognition(initial.id, recognition(initial.text, initial.modelReceiptId, [claim(initial.text, { kind: "bonus_credit" })])));
  const eventId = (await inMonitor(claude, () => loadActionInput())).events[0]!.id;
  for (const [index, text] of ["Bonus credit claim window has closed.", "Bonus credit claiming has reopened.", "The bonus credit has expired on Oct 23 at 14:45 UTC."].entries()) {
    const post = await addPost(claude, text, { publishedAt: `2026-10-23T${13 + index}:00:00Z` });
    await inMonitor(claude, () => applyRecognition(post.id, recognition(text, post.modelReceiptId,
      [claim(text, { eventId, localEventKey: null, kind: "bonus_credit", action: "progress", timeExcerpt: index === 2 ? "expired on Oct 23 at 14:45 UTC" : null })])));
    const snapshot = await inMonitor(claude, () => publicV2Snapshot());
    assert.equal((await inMonitor(claude, () => sourcePost(post.id)))!.processing_status, "processed");
    assert.equal(snapshot.events[0]!.status, "completed");
    assert.equal(snapshot.events[0]!.time, at);
    assert.equal(snapshot.events[0]!.updates[0]!.action, "progress");
    assert.equal(snapshot.statistics.bonusesLast30Days, 1);
  }
  const futureText = "The bonus credit has expired on Oct 24 at 11:00 UTC.";
  const future = await addPost(claude, futureText, { publishedAt: "2026-10-23T16:00:00Z" });
  await inMonitor(claude, () => applyRecognition(future.id, recognition(futureText, future.modelReceiptId,
    [claim(futureText, { eventId, localEventKey: null, kind: "bonus_credit", action: "progress", timeExcerpt: "expired on Oct 24 at 11:00 UTC" })])));
  assert.equal((await inMonitor(claude, () => sourcePost(future.id)))!.processing_status, "needs_attention");
  const deadlineText = "Bonus credit claim window will close on Oct 24.";
  const deadline = await addPost(claude, deadlineText, { publishedAt: "2026-10-23T17:00:00Z" });
  await inMonitor(claude, () => applyRecognition(deadline.id, recognition(deadlineText, deadline.modelReceiptId,
    [claim(deadlineText, { eventId, localEventKey: null, kind: "bonus_credit", action: "progress", timeExcerpt: null })])));
  assert.equal((await inMonitor(claude, () => sourcePost(deadline.id)))!.processing_status, "processed");
  assert.equal((await inMonitor(claude, () => publicV2Snapshot())).events[0]!.status, "completed");
});

for (const kind of ["direct_reset", "reset_credit", "bonus_credit"] as const) {
  test(`${kind} cancellation requires a whole-event fact and invalidates all statistics`, async () => {
    const definition = kind === "bonus_credit" ? claude : codex;
    const initialText = kind === "bonus_credit" ? "One-time bonus credit for cloud sessions is now available." : "We reset usage.";
    const initial = await addPost(definition, initialText);
    await inMonitor(definition, () => applyRecognition(initial.id, recognition(initial.text, initial.modelReceiptId, [claim(initial.text, { kind })])));
    const eventId = (await inMonitor(definition, () => loadActionInput())).events[0]!.id;
    for (const text of ["My event has been cancelled.", "If the event is cancelled, contact support.", "The event will be cancelled tomorrow.", "The event was not cancelled."]) {
      const post = await addPost(definition, text);
      await inMonitor(definition, () => applyRecognition(post.id, recognition(text, post.modelReceiptId,
        [claim(text, { eventId, localEventKey: null, kind, action: "amend", invalidatesEvent: true })])));
      assert.equal((await inMonitor(definition, () => sourcePost(post.id)))!.processing_status, "needs_attention", text);
    }
    const text = "The event has been cancelled.";
    const post = await addPost(definition, text, { publishedAt: "2026-10-23T13:00:00Z" });
    await inMonitor(definition, () => applyRecognition(post.id, recognition(text, post.modelReceiptId,
      [claim(text, { eventId, localEventKey: null, kind, action: "amend", invalidatesEvent: true })])));
    const snapshot = await inMonitor(definition, () => publicV2Snapshot());
    assert.equal(snapshot.events[0]!.status, "cancelled");
    assert.equal(snapshot.events[0]!.updates[0]!.invalidatesEvent, true);
    assert.equal(snapshot.resetTime, null);
    assert.equal(snapshot.announcedResetTime, null);
    assert.equal(snapshot.statistics.resetsLast30Days, 0);
    assert.equal(snapshot.statistics.cardsLast30Days, 0);
    assert.equal(snapshot.statistics.bonusesLast30Days, 0);
  });
}


test("a generic Claude bonus cancellation still needs cross-author source evidence", async () => {
  const definition = { ...claude, authors: [...claude.authors, { handle: "OtherOfficial", name: "Other Official" }] };
  const initial = await addPost(definition, "One-time bonus credit for cloud sessions is now available.");
  await inMonitor(definition, () => applyRecognition(initial.id, recognition(initial.text, initial.modelReceiptId,
    [claim(initial.text, { kind: "bonus_credit" })])));
  const eventId = (await inMonitor(definition, () => loadActionInput())).events[0]!.id;
  for (const linked of [false, true]) {
    const text = "The event has been cancelled." + (linked ? ` https://x.com/${definition.authors[0]!.handle}/status/${initial.id}` : "");
    const post = await addPost(definition, text, { author: "OtherOfficial", publishedAt: "2026-10-23T13:00:00Z" });
    await inMonitor(definition, () => applyRecognition(post.id, recognition(text, post.modelReceiptId,
      [claim("The event has been cancelled.", { eventId, localEventKey: null, kind: "bonus_credit", action: "amend", invalidatesEvent: true })])));
    assert.equal((await inMonitor(definition, () => sourcePost(post.id)))!.processing_status, linked ? "processed" : "needs_attention");
    assert.equal((await inMonitor(definition, () => publicV2Snapshot())).events[0]!.status, linked ? "cancelled" : "completed");
  }
});

for (const status of ["processed", "pending"] as const) for (const outcome of ["success", "attention", "invalid", "failure"] as const) {
  test(`in-flight ${outcome} cannot overwrite a ${status} post edited after worker start`, async () => {
    const post = await addPost(codex, "We reset usage.");
    const answer = recognition(post.text, 0); answer.needsReview = outcome === "attention";
    answers.set(post.id, answer); invalidOutput = outcome === "invalid"; transportFailure = outcome === "failure";
    const entered = gate(), release = gate();
    beforeModelReply = async () => { entered.open(); await release.promise; };
    const processing = inMonitor(codex, () => processPending());
    try {
      await entered.promise;
      await sql`UPDATE monitor_source_posts SET processing_status=${status},title='{"zh":"人工编辑标题"}'::jsonb,summary='{"zh":"人工摘要"}'::jsonb,
        review_reason='保留人工原因',model_receipt_id=${post.modelReceiptId},updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${post.id}`;
    } finally { release.open(); }
    await processing;
    const saved = (await inMonitor(codex, () => sourcePost(post.id)))!;
    assert.equal(saved.processing_status, status); assert.deepEqual(saved.title, { zh: "人工编辑标题" }); assert.deepEqual(saved.summary, { zh: "人工摘要" });
    assert.equal(saved.review_reason, "保留人工原因"); assert.equal(saved.model_receipt_id, post.modelReceiptId);
    assert.equal((await inMonitor(codex, () => loadActionInput())).actions.length, 0);
    const [settled] = await sql`SELECT status FROM receipts WHERE subject LIKE 'thread:%' AND purpose=${`${codex.names.purposePrefix}.recognize`} AND id<>${post.modelReceiptId} ORDER BY id DESC LIMIT 1`;
    assert.equal(settled!.status, ["invalid", "failure"].includes(outcome) ? "failed" : "completed");
  });
}

test("successful recognition without any accepted facts is still processed", async () => {
  const post = await addPost(codex, "An ordinary unrelated update.");
  const answer = recognition(post.text, 0, []); answer.relevant = false; answers.set(post.id, answer);
  await inMonitor(codex, () => processPending());
  const saved = (await inMonitor(codex, () => sourcePost(post.id)))!;
  assert.equal(saved.processing_status, "processed"); assert.equal(saved.review_reason, null);
  assert.equal((await inMonitor(codex, () => loadActionInput())).actions.length, 0);
});

test("post translation fills missing languages in every recognition state without changing state or reason", async () => {
  const post = await addPost(codex, "Saved original.");
  const before = model.hits();
  process.env.COLLECT_ENABLED = "false";
  for (const status of ["pending", "needs_attention", "failed", "processed"] as const) {
    await sql`UPDATE monitor_source_posts SET title='{"zh":"待翻译文案"}'::jsonb,summary=NULL,processing_status=${status},review_reason='保留识别说明' WHERE monitor_id='codex' AND id=${post.id}`;
    const original = (await inMonitor(codex, () => sourcePost(post.id)))!;
    assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 1 });
    const translated = (await inMonitor(codex, () => sourcePost(post.id)))!;
    assert.equal(translated.processing_status, status); assert.equal(translated.review_reason, "保留识别说明");
    assert.equal(translated.title!.zh, "待翻译文案"); assert.equal(Object.keys(translated.title!).length, 7);
    const metadata = ({ title: _title, updated_at: _updated, version: _version, ...rest }: typeof translated) => rest;
    assert.deepEqual(metadata(translated), metadata(original), "translation preserves source identity, originals, status and recognition receipts");
    assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 0 });
  }
  assert.equal(model.hits() - before, 4);
});

for (const definition of [codex, claude, grok]) test(`${definition.monitorId}: independent translation completes event, action and all post states, then handles each later edit once`, async () => inMonitor(definition, async () => {
  const first = await addPost(definition, "We reset usage for everyone.");
  await applyRecognition(first.id, recognition(first.text, first.modelReceiptId));
  const postIds = [first.id];
  for (let index = 1; index < 4; index++) postIds.push((await addPost(definition, `Private original marker ${index}`)).id);
  const original = await loadActionInput(), eventId = original.events[0]!.id, actionId = original.actions[0]!.id;
  await sql`UPDATE monitor_event_records SET title='{"zh":"事件中文标题"}'::jsonb,summary='{"en":"Preserved event summary"}'::jsonb,scope=${sql.json({ ...scope, note: { zh: "明确范围说明" } })},updated_at=clock_timestamp() WHERE monitor_id=${definition.monitorId} AND id=${eventId}`;
  await sql`UPDATE monitor_event_actions SET title='{"zh":"动作中文标题"}'::jsonb,summary='{"zh":"动作中文摘要"}'::jsonb,updated_at=clock_timestamp() WHERE monitor_id=${definition.monitorId} AND id=${actionId}`;
  for (const [index, status] of ["pending", "processed", "needs_attention", "failed"].entries()) await sql`UPDATE monitor_source_posts
    SET title=${sql.json({ zh: `帖子中文标题 ${index}` })},summary=${sql.json({ en: `Preserved post summary ${index}` })},processing_status=${status},review_reason='保留识别原因',updated_at=clock_timestamp()
    WHERE monitor_id=${definition.monitorId} AND id=${postIds[index]!}`;
  const before = await loadActionInput(), calls = model.hits();
  process.env.COLLECT_ENABLED = "false";
  const scheduled = createMonitorServer(definition).schedules!.find(item => item.name === `${definition.monitorId}-reset.translate`)!;
  assert.equal(scheduled.when!(), true);
  assert.deepEqual(await scheduled.run(), { enriched: 6 });
  const after = await loadActionInput();
  assert.equal(after.events[0]!.title!.zh, "事件中文标题");
  assert.equal(after.events[0]!.summary!.en, "Preserved event summary");
  assert.equal(after.events[0]!.scope!.note!.zh, "明确范围说明");
  assert.equal(after.actions[0]!.title.zh, "动作中文标题");
  assert.equal(after.actions[0]!.summary!.zh, "动作中文摘要");
  const texts = [after.events[0]!.title, after.events[0]!.summary, after.events[0]!.scope!.note, after.actions[0]!.title, after.actions[0]!.summary,
    ...after.posts.flatMap(post => [post.title, post.summary])];
  assert.ok(texts.every(text => text && Object.keys(text).length === 7));
  const postMetadata = ({ title: _title, summary: _summary, updated_at: _updated, ...post }: typeof after.posts[number]) => post;
  assert.deepEqual(after.posts.map(postMetadata), before.posts.map(postMetadata), "translation preserves every post state, reason, original and recognition receipt");
  const actionMetadata = ({ title: _title, summary: _summary, updated_at: _updated, ...action }: typeof after.actions[number]) => action;
  assert.deepEqual(after.actions.map(actionMetadata), before.actions.map(actionMetadata), "translation does not change the action sequence, sources, time or kind");
  assert.equal(after.events[0]!.type, before.events[0]!.type);
  assert.deepEqual(after.events[0]!.scope!.productCodes, before.events[0]!.scope!.productCodes);
  assert.equal(after.events[0]!.withdrawn, before.events[0]!.withdrawn);
  assert.deepEqual(await scheduled.run(), { enriched: 0 });
  assert.equal(model.hits() - calls, 6);
  assert.ok(editorialInputs.every(input => Object.keys(input).sort().join(",") === "note,summary,title"));
  assert.equal(JSON.stringify(editorialInputs).includes("Private original marker"), false);

  const event = (await listEvents()).events[0]!;
  await updateMonitorEvent(event.id, { version: event.version, patch: { title: { zh: "再次编辑事件" } } }, "translation-test");
  const post = (await sourcePost(postIds[0]!))!;
  await updateMonitorPost(post.id, { version: post.version, patch: { title: { zh: "再次编辑帖子" } } }, "translation-test");
  const detail = (await monitorEventDetail(eventId))!, action = detail.actions.find(action => action.id === actionId)!;
  const body = { version: detail.version, versions: detail.versions, actions: { update: [{ id: action.id, action: action.action, invalidatesEvent: action.invalidatesEvent,
    title: { zh: "再次编辑动作" }, summary: action.summary, time: action.time }] } };
  const preview = (await previewMonitorEventReview(eventId, body))!;
  await submitMonitorEventReview(eventId, { ...body, previewToken: preview.previewToken }, "translation-test");
  const edited = await loadActionInput();
  assert.deepEqual(edited.events[0]!.title, { zh: "再次编辑事件" });
  assert.deepEqual(edited.actions[0]!.title, { zh: "再次编辑动作" });
  assert.deepEqual(edited.posts.find(post => post.id === postIds[0])!.title, { zh: "再次编辑帖子" });
  assert.deepEqual(await scheduled.run(), { enriched: 3 });
  const retranslated = await loadActionInput();
  assert.equal(retranslated.events[0]!.title!.zh, "再次编辑事件");
  assert.equal(retranslated.actions[0]!.title.zh, "再次编辑动作");
  assert.equal(retranslated.posts.find(post => post.id === postIds[0])!.title!.zh, "再次编辑帖子");
  assert.equal(retranslated.posts.find(post => post.id === postIds[0])!.processing_status, "pending");
  assert.deepEqual(await scheduled.run(), { enriched: 0 });
  assert.equal(model.hits() - calls, 9);
}));

test("a failed translation version is not purchased again, while editing the post allows new translation", async () => inMonitor(codex, async () => {
  const post = await addPost(codex, "Private original marker.");
  await sql`UPDATE monitor_source_posts SET title='{"zh":"人工中文标题"}'::jsonb,processing_status='needs_attention',review_reason='保留原因' WHERE monitor_id='codex' AND id=${post.id}`;
  const calls = model.hits(); invalidTranslation = true; process.env.COLLECT_ENABLED = "false";
  assert.deepEqual(await processPublicV2Pending(), { enriched: 0, enrichmentPending: 1 });
  assert.deepEqual(await processPublicV2Pending(), { enriched: 0, enrichmentPending: 1 });
  assert.equal(model.hits() - calls, 1);
  let current = (await sourcePost(post.id))!;
  assert.deepEqual(current.title, { zh: "人工中文标题" }); assert.equal(current.processing_status, "needs_attention"); assert.equal(current.review_reason, "保留原因");
  await updateMonitorPost(post.id, { version: current.version, patch: { title: { zh: "人工新标题" } } }, "translation-test");
  invalidTranslation = false;
  assert.deepEqual(await processPublicV2Pending(), { enriched: 1 });
  current = (await sourcePost(post.id))!;
  assert.equal(current.title!.zh, "人工新标题"); assert.equal(Object.keys(current.title!).length, 7);
  assert.equal(current.processing_status, "needs_attention"); assert.equal(current.review_reason, "保留原因");
  assert.deepEqual(await processPublicV2Pending(), { enriched: 0 });
  assert.equal(model.hits() - calls, 2);
}));

test("a concurrent post correction keeps the new text and recognition decision, then translates its new version", async () => inMonitor(codex, async () => {
  const post = await addPost(codex, "Private original marker.");
  await sql`UPDATE monitor_source_posts SET title='{"zh":"旧标题"}'::jsonb,processing_status='pending',review_reason='旧原因' WHERE monitor_id='codex' AND id=${post.id}`;
  process.env.COLLECT_ENABLED = "false";
  translationRace = async () => { await sql`UPDATE monitor_source_posts SET title='{"zh":"新标题"}'::jsonb,processing_status='failed',review_reason='人工保留的新原因',updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${post.id}`; };
  assert.deepEqual(await processPublicV2Pending(), { enriched: 0 });
  let current = (await sourcePost(post.id))!;
  assert.deepEqual(current.title, { zh: "新标题" }); assert.equal(current.processing_status, "failed"); assert.equal(current.review_reason, "人工保留的新原因");
  assert.deepEqual(await processPublicV2Pending(), { enriched: 1 });
  current = (await sourcePost(post.id))!;
  assert.equal(current.title!.zh, "新标题"); assert.equal(current.processing_status, "failed"); assert.equal(current.review_reason, "人工保留的新原因");
}));
