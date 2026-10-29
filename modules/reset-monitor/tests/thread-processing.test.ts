import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { inMonitor } from "../backend/context.ts";
import { storeCollectedPost, sourcePost, loadActionInput } from "../backend/action-store.ts";
import { applyOfflineRecognition, applyRecognitionGroup } from "../backend/assemble.ts";
import { processPending } from "../backend/thread-processing.ts";
import type { ActionRecognitionBody, ThreadRecognitionInput } from "../backend/recognize.ts";
import { threadOutputSchema } from "../backend/recognize.ts";

const author = codex.authors[0]!.handle;
const local = (value: string) => ({ en: value, zh: value, "zh-Hant": value, ja: value, ko: value, ru: value, es: value });
const posts = {
  "101": { text: "We will reset usage.", at: "2026-10-29T08:00:00Z" },
  "102": { text: "The usage reset lands Oct 29 at 10:00 UTC.", at: "2026-10-29T08:01:00Z" },
  "103": { text: "The usage reset is completed.", at: "2026-10-29T09:00:00Z" },
  "104": { text: "A new website is available.", at: "2026-10-29T09:30:00Z" },
};
function bodyFor(id: string, existingEventId: string | null = null): ActionRecognitionBody {
  const post = posts[id as keyof typeof posts];
  return { relevant: id !== "104", needsReview: false, title: local(`Post ${id}`), summary: local(`Summary ${id}`),
    actions: id === "104" ? [] : [{ eventId: existingEventId, localEventKey: existingEventId ? null : "reset-group", existingActionId: null,
      kind: "direct_reset", kindExplicit: true, action: id === "103" ? "confirm" : "announce", invalidatesEvent: false,
      real: true, role: "action", excerpt: post.text, title: local(`Reset ${id}`), summary: local(`Reset summary ${id}`),
      timeExcerpt: id === "102" ? "Oct 29 at 10:00 UTC" : null,
      rawScope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null },
      scope: { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null }, scopeExcerpt: null }] };
}
const inputs: ThreadRecognitionInput[] = [];
let beforeReply: ((input: ThreadRecognitionInput) => Promise<void>) | null = null;
let omitLastTarget = false;
let reviewFirstTarget = false;
let outputEventId: string | null = null;
let postScope: null | Record<string, unknown> | undefined;
const model = await stub(async (_hit, request) => {
  const input = JSON.parse(JSON.parse(request.body).messages[1].content) as ThreadRecognitionInput;
  inputs.push(input);
  if (beforeReply) await beforeReply(input);
  const targets = omitLastTarget ? input.targets.slice(0, -1) : input.targets;
  const existingEventId = outputEventId ?? input.events[0]?.id ?? null;
  const content = { posts: targets.map(post => ({ postId: post.id, ...bodyFor(post.id, existingEventId),
    ...(postScope === undefined ? {} : { scope: postScope }),
    ...(reviewFirstTarget && post.id === "101" ? { needsReview: true, reviewReason: "A separate unsupported detail needs review" } : { reviewReason: null }) })) };
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] };
});
Object.assign(process.env, { MONITOR_MODEL: "default", LLM_MODEL: "synthetic-thread", LLM_API_KEY: "synthetic", LLM_BASE_URL: `${model.url}/v1` });
config.allowPrivateNetworkFetch = true;
installModules([createMonitorServer(codex)]);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM receipts`;
  await sql`DELETE FROM budgets`;
  inputs.length = 0; beforeReply = null; omitLastTarget = false; reviewFirstTarget = false; outputEventId = null;
  postScope = undefined;
  process.env.LLM_MODEL = "synthetic-thread";
  config.modelCallsEnabled = true; process.env.COLLECT_ENABLED = "true";
});
after(async () => { await model.close(); installModules([]); await closeDb(); });

async function seed(ids: Array<keyof typeof posts>) {
  for (const id of ids) {
    const post = posts[id];
    await storeCollectedPost({ id, author, publishedAt: post.at, text: post.text, url: `https://x.com/${author}/status/${id}`, receiptId: null,
      replyTo: id === "102" ? { postId: "101", author: null } : null,
      quotedPost: id === "103" ? { id: "102", author, publishedAt: posts["102"].at, text: posts["102"].text,
        relation: "quote", url: `https://x.com/${author}/status/102`, replyTo: { postId: "101", author: null } } : null });
  }
}

test("ABC form one recognition group and independent D forms another, with source-bound actions", async () => inMonitor(codex, async () => {
  await seed(["103", "104", "101", "102"]);
  const result = await processPending();
  assert.equal(result.processed, 4); assert.equal(result.groups, 2); assert.equal(result.modelCalls, 2);
  assert.deepEqual(inputs.map(input => input.targets.map(post => post.id)), [["101", "102", "103"], ["104"]]);
  const saved = await loadActionInput();
  assert.ok(saved.posts.every(post => post.processing_status === "processed"));
  assert.equal(saved.events.length, 1);
  assert.deepEqual(saved.actions.sort((a, b) => a.sequence - b.sequence).map(action => ({ action: action.action, sources: action.sources })), [
    { action: "announce", sources: [{ postId: "101" }] }, { action: "announce", sources: [{ postId: "102" }] }, { action: "confirm", sources: [{ postId: "103" }] },
  ]);
  const receipts = new Set(saved.posts.filter(post => post.id !== "104").map(post => post.model_receipt_id));
  assert.equal(receipts.size, 1, "one model receipt is shared by all targets of a group");
  const before = model.hits(); await processPending(); assert.equal(model.hits(), before);
}));

test("accepted A is read-only context while B and C share one new model response and the same existing event", async () => inMonitor(codex, async () => {
  await seed(["101", "102", "103", "104"]);
  const first = (await sourcePost("101"))!;
  await applyOfflineRecognition(first.id, bodyFor(first.id), first.version);
  await sql`UPDATE monitor_source_posts SET processing_status='processed',title=${sql.json(local("Already handled"))} WHERE monitor_id='codex' AND id='104'`;
  const before = await loadActionInput(), eventId = before.events[0]!.id, firstActionId = before.actions[0]!.id;
  const firstVersion = (await sourcePost("101"))!.version, independentVersion = (await sourcePost("104"))!.version;
  const result = await processPending();
  assert.equal(result.processed, 2); assert.equal(result.modelCalls, 1);
  assert.deepEqual(inputs[0]!.targets.map(post => post.id), ["102", "103"]);
  assert.deepEqual(inputs[0]!.context.map(post => post.id), ["101"]);
  assert.equal(inputs[0]!.events[0]!.id, eventId);
  const saved = await loadActionInput();
  assert.equal(saved.events.length, 1); assert.equal(saved.events[0]!.id, eventId);
  assert.ok(saved.actions.some(action => action.id === firstActionId));
  assert.equal((await sourcePost("101"))!.version, firstVersion);
  assert.equal((await sourcePost("104"))!.version, independentVersion);
}));

test("a database failure on the second target rolls back the whole group and reuses the received answer", async () => inMonitor(codex, async () => {
  await seed(["101", "102", "103"]);
  await sql`ALTER TABLE monitor_source_posts ADD CONSTRAINT thread_test_second_write CHECK(id<>'102' OR processing_status<>'processed') NOT VALID`;
  const before = model.hits();
  try {
    await assert.rejects(processPending(), /thread_test_second_write/);
    const failed = await loadActionInput();
    assert.equal(failed.events.length, 0); assert.equal(failed.actions.length, 0);
    assert.ok(failed.posts.every(post => post.processing_status === "pending" && post.model_receipt_id === null));
    assert.equal((await sql`SELECT status FROM receipts WHERE purpose='monitor.recognize'`)[0].status, "received");
    assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_state WHERE key LIKE 'recognition:pending:%'`)[0].n, 1);
  } finally { await sql`ALTER TABLE monitor_source_posts DROP CONSTRAINT thread_test_second_write`; }
  const recovered = await processPending();
  assert.equal(recovered.processed, 3); assert.equal(recovered.modelCalls, 0);
  assert.equal(model.hits() - before, 1);
  assert.ok((await loadActionInput()).posts.every(post => post.processing_status === "processed"));
  assert.equal((await sql`SELECT status FROM receipts WHERE purpose='monitor.recognize'`)[0].status, "completed");
}));

test("manual edits while the model is running are preserved and no partial group facts are accepted", async () => inMonitor(codex, async () => {
  await seed(["101", "102", "103"]);
  beforeReply = async () => {
    await sql`UPDATE monitor_source_posts SET processing_status='processed',title=${sql.json({ zh: "Manual title" })},updated_at=clock_timestamp() WHERE monitor_id='codex' AND id='102'`;
    beforeReply = null;
  };
  await processPending();
  const saved = await loadActionInput();
  assert.equal(saved.events.length, 0); assert.equal(saved.actions.length, 0);
  assert.deepEqual(saved.posts.find(post => post.id === "102")!.title, { zh: "Manual title" });
  assert.equal(saved.posts.find(post => post.id === "102")!.processing_status, "processed");
  assert.ok(saved.posts.filter(post => post.id !== "102").every(post => post.processing_status === "needs_attention"));
  const before = model.hits(); await processPending(); assert.equal(model.hits(), before);
}));

test("an output missing one target reviews the entire group without accepting any action or repurchasing", async () => inMonitor(codex, async () => {
  await seed(["101", "102", "103"]); omitLastTarget = true;
  const before = model.hits();
  const result = await processPending();
  assert.equal(result.reviewed, 3);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.schemaFailures, 1);
  const saved = await loadActionInput();
  assert.equal(saved.events.length, 0); assert.equal(saved.actions.length, 0);
  assert.ok(saved.posts.every(post => post.processing_status === "needs_attention"));
  assert.equal((await sql`SELECT status FROM receipts WHERE purpose='monitor.recognize'`)[0].status, "failed");
  await processPending(); assert.equal(model.hits() - before, 1);
}));

test("the observed empty scope is accepted, while nonempty extra facts produce safe field diagnostics", async () => inMonitor(codex, async () => {
  await seed(["104"]); postScope = null;
  const accepted = await processPending();
  assert.equal(accepted.reviewed, 0); assert.equal(accepted.schemaFailures, 0);
  assert.equal((await sourcePost("104"))!.processing_status, "processed");
  const [receipt] = await sql`SELECT request FROM receipts WHERE purpose='monitor.recognize' ORDER BY id DESC LIMIT 1`;
  assert.ok(receipt.request.systemChars > 0);
  assert.equal(receipt.request.inputMetrics.contextChars, 2);
  assert.ok(receipt.request.inputMetrics.targetsChars > 0);
  await sql`UPDATE monitor_source_posts SET processing_status='pending',updated_at=clock_timestamp() WHERE monitor_id='codex' AND id='104'`;
  postScope = { confidential: "Do not leak this value into review reasons" };
  const rejected = await processPending();
  assert.equal(rejected.schemaFailures, 1);
  const saved = (await sourcePost("104"))!;
  assert.match(saved.review_reason!, /posts\.0\.scope.*unrecognized_keys/);
  assert.doesNotMatch(saved.review_reason!, /confidential|Do not leak/);
}));

test("an operator can atomically replay a saved answer while preserving its original paid receipt", async () => inMonitor(codex, async () => {
  const requestsBefore = model.hits();
  await seed(["104"]); await processPending();
  const [receipt] = await sql`SELECT * FROM receipts WHERE purpose='monitor.recognize'`;
  const answer = threadOutputSchema(["104"]).parse(JSON.parse(receipt.response.choices[0].message.content));
  const recognition = { ...answer, receiptId: receipt.id, model: "default", promptVersion: "saved-response", reused: true };
  await sql`UPDATE monitor_source_posts SET processing_status='needs_attention',updated_at=clock_timestamp() WHERE monitor_id='codex' AND id='104'`;
  const replay = async (rollback: boolean) => sql.begin(async db => {
    await db`UPDATE monitor_source_posts SET processing_status='pending' WHERE monitor_id='codex' AND id='104'`;
    const input = await loadActionInput(db);
    await applyRecognitionGroup(input.posts, [], { ...input, events: [], actions: [] }, recognition, { db, preserveReceipt: true });
    if (rollback) throw new Error("Replay transaction interrupted");
  });
  await assert.rejects(replay(true), /Replay transaction interrupted/);
  assert.equal((await sourcePost("104"))!.processing_status, "needs_attention");
  assert.deepEqual((await sql`SELECT * FROM receipts WHERE id=${receipt.id}`)[0], receipt);
  await replay(false);
  assert.equal((await sourcePost("104"))!.processing_status, "processed");
  assert.deepEqual((await sql`SELECT * FROM receipts WHERE id=${receipt.id}`)[0], receipt);
  assert.equal(model.hits(), requestsBefore + 1, "saved response replay makes no new model request");
}));

test("a target's partial review reason does not discard independently supported group facts", async () => inMonitor(codex, async () => {
  await seed(["101", "102", "103"]); reviewFirstTarget = true;
  await processPending();
  const saved = await loadActionInput();
  assert.equal(saved.events.length, 1); assert.equal(saved.actions.length, 3);
  assert.equal(saved.posts.find(post => post.id === "101")!.processing_status, "needs_attention");
  assert.match(saved.posts.find(post => post.id === "101")!.review_reason!, /unsupported detail/);
  assert.ok(saved.posts.filter(post => post.id !== "101").every(post => post.processing_status === "processed"));
}));

test("a changed model configuration retires received pending work without another purchase", async () => inMonitor(codex, async () => {
  await seed(["101", "102", "103"]);
  await sql`ALTER TABLE monitor_source_posts ADD CONSTRAINT thread_test_changed_model CHECK(id<>'102' OR processing_status<>'processed') NOT VALID`;
  const before = model.hits();
  try { await assert.rejects(processPending(), /thread_test_changed_model/); }
  finally { await sql`ALTER TABLE monitor_source_posts DROP CONSTRAINT thread_test_changed_model`; }
  process.env.LLM_MODEL = "another-synthetic-thread-model";
  await processPending();
  assert.equal(model.hits() - before, 1);
  assert.ok((await loadActionInput()).posts.every(post => post.processing_status === "needs_attention"));
  assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_state WHERE key LIKE 'recognition:pending:%'`)[0].n, 0);
}));

test("an output cannot alter an existing event absent from the group's supplied facts", async () => inMonitor(codex, async () => {
  await storeCollectedPost({ id: "900", author, publishedAt: "2026-10-20T08:00:00Z", text: posts["103"].text,
    url: `https://x.com/${author}/status/900`, receiptId: null });
  const old = (await sourcePost("900"))!;
  await applyOfflineRecognition(old.id, bodyFor("103"), old.version);
  const baseline = await loadActionInput(); outputEventId = baseline.events[0]!.id;
  await seed(["101"]);
  await processPending();
  assert.ok(inputs[0]!.events.every(event => event.id !== outputEventId));
  const saved = await loadActionInput();
  assert.deepEqual(saved.events, baseline.events); assert.deepEqual(saved.actions, baseline.actions);
  assert.equal(saved.posts.find(post => post.id === "101")!.processing_status, "needs_attention");
  assert.equal((await sql`SELECT status FROM receipts WHERE purpose='monitor.recognize'`)[0].status, "failed");
  const before = model.hits(); await processPending(); assert.equal(model.hits(), before);
}));


test("oversized groups retain their originals for review without buying or truncating a model input", async () => inMonitor(codex, async () => {
  await seed(["101", "102", "103"]);
  const original = "We will reset usage. " + "Synthetic source paragraph. ".repeat(6000);
  await sql`UPDATE monitor_source_posts SET text=${original} WHERE monitor_id='codex' AND id='101'`;
  const before = model.hits();
  const result = await processPending();
  assert.equal(result.modelCalls, 0); assert.equal(result.reviewed, 3);
  assert.equal(model.hits(), before);
  const saved = await loadActionInput();
  assert.equal(saved.posts.find(post => post.id === "101")!.text, original);
  assert.ok(saved.posts.every(post => post.processing_status === "needs_attention"));
  assert.equal(saved.events.length, 0);
}));
