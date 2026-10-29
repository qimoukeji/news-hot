import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { applyOfflineRecognition, applyRecognition } from "../backend/assemble.ts";
import { storeCollectedPost, sourcePost, loadActionInput } from "../backend/action-store.ts";
import { recognitionPrompt, type ActionRecognitionBody } from "../backend/recognize.ts";
import { publicV2Snapshot } from "../backend/public-v2.ts";

const localized = (text: string) => ({ en: text, zh: text, "zh-Hant": text, ja: text, ko: text, ru: text, es: text });
const at = "2026-10-23T12:00:00.000Z";
function response(excerpt = "We reset usage for everyone."): ActionRecognitionBody {
  return { relevant: true, needsReview: false, title: localized("Quota update"), summary: null,
    actions: [{ eventId: null, localEventKey: "new-1", existingActionId: null, kind: "direct_reset", kindExplicit: true,
      action: "confirm", invalidatesEvent: false, real: true, role: "action", excerpt, title: localized("Usage reset"), summary: null,
      timeExcerpt: null, rawScope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null },
      scope: { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: localized("All users") }, scopeExcerpt: null }] };
}
async function post(text = "We reset usage for everyone.", replyTo: { postId: string | null; author: string | null } | null = null) {
  const id = randomUUID();
  await storeCollectedPost({ id, author: codex.authors[0]!.handle, publishedAt: at, url: `https://x.com/thsottiaux/status/${id}`,
    text, replyTo, receiptId: null });
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

test("offline acceptance stores real source facts with no paid receipts and is resumable", async () => inMonitor(codex, async () => {
  const saved = await post();
  await applyOfflineRecognition(saved.id, response(), saved.version);
  const input = await loadActionInput(), snapshot = await publicV2Snapshot();
  assert.equal(input.posts[0]!.source_receipt_id, null);
  assert.equal(input.posts[0]!.model_receipt_id, null);
  assert.equal(input.posts[0]!.processing_status, "processed");
  assert.equal(input.events.length, 1);
  assert.equal(input.actions.length, 1);
  assert.equal(snapshot.events[0]!.status, "completed");
  assert.equal(snapshot.events[0]!.time, at);
  assert.equal((await sql`SELECT 1 FROM receipts`).length, 0);
  await applyOfflineRecognition(saved.id, response(), saved.version);
  assert.equal((await loadActionInput()).actions.length, 1);
  assert.equal((await sql`SELECT 1 FROM monitor_state WHERE key LIKE '%cursor%' OR key LIKE '%watermarks%'`).length, 0);
}));

test("offline and paid acceptance share identical action, scope and time checks", async () => inMonitor(codex, async () => {
  const free = await post();
  await applyOfflineRecognition(free.id, response(), free.version);
  const paid = await post();
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,response)
    VALUES(${randomUUID()},'synthetic',${`${codex.names.purposePrefix}.recognize`},${`x:${paid.id}`},'received','{}'::jsonb) RETURNING id`;
  await applyRecognition(paid.id, { ...response(), receiptId: receipt!.id, model: "synthetic", promptVersion: "synthetic" }, paid.version);
  const snapshot = await publicV2Snapshot();
  assert.equal(snapshot.events.length, 2);
  const facts = snapshot.events.map(event => ({ type: event.type, status: event.status, time: event.time, scope: event.scope,
    actions: event.updates.map(action => ({ action: action.action, title: action.title, summary: action.summary })) }));
  assert.deepEqual(facts[0], facts[1]);
  assert.equal((await sql`SELECT status FROM receipts`)[0]!.status, "completed");
}));

test("offline fabricated excerpts remain visible for review", async () => inMonitor(codex, async () => {
  const saved = await post("We will reset usage tomorrow.");
  await applyOfflineRecognition(saved.id, response(), saved.version);
  const row = await sourcePost(saved.id);
  assert.equal(row!.processing_status, "needs_attention");
  assert.match(row!.review_reason!, /本帖明确依据/);
  assert.equal(row!.model_receipt_id, null);
  assert.equal((await loadActionInput()).events.length, 0);
}));

test("a concise paid-user note preserves the original product and paid-only scope", async () => inMonitor(codex, async () => {
  const source = "We reset usage for all paid ChatGPT accounts.";
  const saved = await post(source), answer = response(source), claim = answer.actions[0]!;
  claim.rawScope = { audienceSource: "all paid ChatGPT accounts", audienceZh: "所有 ChatGPT 付费账号", productsZh: "ChatGPT", plans: null };
  claim.scope = { type: "paid_users", productCodes: ["chatgpt"], planCodes: [], quotaWindowCodes: [], note: { ...localized("Paid users"), zh: "付费用户" } };
  claim.scopeExcerpt = "all paid ChatGPT accounts";
  await applyOfflineRecognition(saved.id, answer, saved.version);
  assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
  const event = (await publicV2Snapshot()).events[0]!;
  assert.deepEqual(event.scope, claim.scope);
  assert.equal((await sourcePost(saved.id))!.text, source);
}));

test("a paid-user label for multiple paid plans retains every exact plan code", async () => inMonitor(codex, async () => {
  const source = "We reset usage for all Plus and Pro users.";
  const saved = await post(source), answer = response(source), claim = answer.actions[0]!;
  claim.rawScope = { audienceSource: "all Plus and Pro users", audienceZh: "所有 Plus 和 Pro 用户", productsZh: null, plans: ["Plus", "Pro"] };
  claim.scope = { type: "all_users", productCodes: [], planCodes: ["plus", "pro"], quotaWindowCodes: [], note: { ...localized("Paid users"), zh: "付费用户" } };
  claim.scopeExcerpt = "all Plus and Pro users";
  await applyOfflineRecognition(saved.id, answer, saved.version);
  assert.equal((await sourcePost(saved.id))!.processing_status, "processed");
  const scope = (await publicV2Snapshot()).events[0]!.scope;
  assert.deepEqual({ ...scope, note: claim.scope.note }, claim.scope);
  assert.match(scope.note!.zh, /付费用户.*unknown 所有产品/);
}));

test("a short paid-user label requires selected eligibility to remain in the action summary", async () => inMonitor(codex, async () => {
  const source = "We reset usage for eligible paid users who signed up before 8pm PT.";
  for (const keepCondition of [true, false]) {
    const saved = await post(source), answer = response(source), claim = answer.actions[0]!;
    const condition = "PT 晚上 8 点前注册的付费用户";
    claim.rawScope = { audienceSource: "eligible paid users who signed up before 8pm PT", audienceZh: condition, productsZh: null, plans: null };
    claim.scope = { type: "selected_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: { ...localized("Paid users"), zh: "付费用户" } };
    claim.scopeExcerpt = "eligible paid users who signed up before 8pm PT";
    claim.summary = keepCondition ? { ...localized("Usage was reset for paid users who signed up before 8pm PT."), zh: `已为${condition}重置额度。` } : null;
    await applyOfflineRecognition(saved.id, answer, saved.version);
    assert.equal((await sourcePost(saved.id))!.processing_status, keepCondition ? "processed" : "needs_attention");
  }
  const [event] = (await publicV2Snapshot()).events;
  assert.match(event!.scope.note!.zh, /付费用户.*unknown 所有产品/);
  assert.match(event!.summary!.zh, /PT 晚上 8 点前注册的付费用户/);
  assert.equal((await loadActionInput()).events.length, 1);
}));

test("plural resets explicitly propagated can confirm, while a future reset remains review", async () => inMonitor(codex, async () => {
  const completed = await post("Resets all propagated. Have a fantastic weekend.");
  await applyOfflineRecognition(completed.id, response("Resets all propagated."), completed.version);
  assert.equal((await sourcePost(completed.id))!.processing_status, "processed");
  assert.equal((await publicV2Snapshot()).events[0]!.status, "completed");
  const future = await post("Resets will land tomorrow.");
  await applyOfflineRecognition(future.id, response("Resets will land tomorrow."), future.version);
  assert.equal((await sourcePost(future.id))!.processing_status, "needs_attention");
  assert.equal((await loadActionInput()).events.length, 1);
}));

test("a completed reset-card grant uses verified usage instructions for weekly and monthly scope without making the grant future", async () => inMonitor(codex, async () => {
  const grant = "We have added a banked reset to everyone's account.";
  for (const cycle of ["weekly", "monthly"]) for (const mode of ["offline", "online"]) {
    const text = `${grant} You can apply the reset in the desktop app or on web and it will replenish the ${cycle} usage for you.`;
    const saved = await post(text), answer = response(grant), action = answer.actions[0]!;
    action.kind = "reset_credit";
    action.scope.quotaWindowCodes = [cycle];
    action.scopeExcerpt = text;
    if (mode === "offline") await applyOfflineRecognition(saved.id, answer, saved.version);
    else {
      const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,response)
        VALUES(${randomUUID()},'synthetic',${`${codex.names.purposePrefix}.recognize`},${`x:${saved.id}`},'received','{}'::jsonb) RETURNING id`;
      await applyRecognition(saved.id, { ...answer, receiptId: receipt!.id, model: "synthetic", promptVersion: "synthetic" }, saved.version);
      assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipt!.id}`)[0]!.status, "completed");
    }
    assert.equal((await sourcePost(saved.id))!.processing_status, "processed", `${mode} ${cycle}`);
    const event = (await publicV2Snapshot()).events.find(event => event.updates.some(update => update.sources.some(source => source.postId === saved.id)))!;
    assert.equal(event.type, "reset_credit");
    assert.equal(event.status, "completed");
    assert.equal(event.time, at);
    assert.deepEqual(event.scope.quotaWindowCodes, [cycle]);
  }
}));

test("an adjacent five-hour limit increase cannot supply the reset card's quota cycle", async () => inMonitor(codex, async () => {
  const grant = "We have added one banked reset to every account.";
  const text = `We increased five-hour usage limits by 20%. ${grant}`;
  const saved = await post(text), answer = response(grant), action = answer.actions[0]!;
  action.kind = "reset_credit";
  action.scope.quotaWindowCodes = ["five-hour"];
  action.scopeExcerpt = text;
  await applyOfflineRecognition(saved.id, answer, saved.version);
  assert.equal((await sourcePost(saved.id))!.processing_status, "needs_attention");
  assert.match((await sourcePost(saved.id))!.review_reason!, /范围/);
  assert.equal((await loadActionInput()).events.length, 0);

  const correct = await post(text);
  action.scope.quotaWindowCodes = [];
  await applyOfflineRecognition(correct.id, answer, correct.version);
  assert.equal((await sourcePost(correct.id))!.processing_status, "processed");
  assert.deepEqual((await publicV2Snapshot()).events[0]!.scope.quotaWindowCodes, []);
}));

test("quoted usage instructions cannot replace the outer post's own scope evidence", async () => inMonitor(codex, async () => {
  const grant = "We have added one banked reset to every account.", borrowed = "This reset replenishes weekly usage.";
  const saved = await post(grant);
  await sql`UPDATE monitor_source_posts SET quoted_post=${sql.json({ id: "quoted-scope", author: "another_author", relation: "quote",
    text: borrowed, publishedAt: at, url: "https://x.com/another_author/status/quoted-scope" })},updated_at=clock_timestamp()
    WHERE monitor_id=${codex.monitorId} AND id=${saved.id}`;
  const answer = response(grant), action = answer.actions[0]!;
  action.kind = "reset_credit";
  action.scope.quotaWindowCodes = ["weekly"];
  action.scopeExcerpt = borrowed;
  await applyOfflineRecognition(saved.id, answer, (await sourcePost(saved.id))!.version);
  assert.equal((await sourcePost(saved.id))!.processing_status, "needs_attention");
  assert.match((await sourcePost(saved.id))!.review_reason!, /范围不在本帖中/);
  assert.equal((await loadActionInput()).events.length, 0);
}));

test("offline bare reply without saved parent cannot establish a reset", async () => inMonitor(codex, async () => {
  const saved = await post("Done.", { postId: "missing-parent", author: "another_author" });
  const answer = response("Done.");
  answer.actions[0]!.role = "answer";
  answer.actions[0]!.kindExplicit = false;
  await applyOfflineRecognition(saved.id, answer, saved.version);
  assert.equal((await sourcePost(saved.id))!.processing_status, "needs_attention");
  assert.equal((await loadActionInput()).actions.length, 0);
}));

test("offline input rejects extra receipt metadata and preserves stale post edits", async () => inMonitor(codex, async () => {
  const saved = await post();
  await assert.rejects(applyOfflineRecognition(saved.id, { ...response(), receiptId: 123 }, saved.version));
  assert.equal((await sourcePost(saved.id))!.processing_status, "pending");
  await sql`UPDATE monitor_source_posts SET text='An edited source',updated_at=clock_timestamp() WHERE monitor_id=${codex.monitorId} AND id=${saved.id}`;
  await applyOfflineRecognition(saved.id, response(), saved.version);
  assert.equal((await loadActionInput()).actions.length, 0);
  assert.equal((await sourcePost(saved.id))!.text, "An edited source");
}));

test("offline instructions contain the bound product rules and strict formal contract", () => inMonitor(codex, () => {
  const prompt = recognitionPrompt();
  assert.match(prompt, /Every action must quote a literal excerpt from the CURRENT post/);
  assert.match(prompt, /invalidatesEvent/);
  assert.match(prompt, /Codex/i);
  assert.match(prompt, /"localEventKey"/);
}));
