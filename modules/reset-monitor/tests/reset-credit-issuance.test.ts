import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { inMonitor } from "../backend/context.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { loadActionInput, storeCollectedPost } from "../backend/action-store.ts";
import { applyRecognitionGroup } from "../backend/assemble.ts";
import { threadOutputSchema, type ActionRecognitionBody } from "../backend/recognize.ts";
import { projectRawV2 } from "../backend/public-v2.ts";
import { defaultScopeLabel } from "../backend/scope-labels.ts";
import { reduceEvent } from "../actions.ts";

const localized = (text: string) => ({ en: text, zh: text, "zh-Hant": text, ja: text, ko: text, ru: text, es: text });
after(closeDb);

test("a thread accepts available reset credits without treating their usage deadline as issuance", async () => inMonitor(claude, async () => {
  const ids = ["801", "802", "803", "804", "805"];
  const text = "We're giving Pro users two resets. Team users receive one reset. Use them anytime by March 8.";
  const publishedAt = "2026-11-09T19:04:19Z";
  for (const [index, id] of ids.entries()) await storeCollectedPost({ id, author: claude.authors[0]!.handle,
    publishedAt, text: id === "805" ? text : "A new product feature is available.", url: `https://x.com/ClaudeDevs/status/${id}`, receiptId: null,
    replyTo: index ? { postId: ids[index - 1]!, author: null } : null });
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,status) VALUES('synthetic-card-issuance','synthetic','reset_monitor.claude.recognize','received') RETURNING id`;
  const body = threadOutputSchema(ids).parse({ type: "json_object", posts: ids.map(postId => ({ postId, relevant: postId === "805", needsReview: false,
    reviewReason: null, title: localized(postId === "805" ? "Reset credits available" : "Product feature"), summary: null,
    actions: postId === "805" ? [{ eventId: null, localEventKey: "card-issuance", existingActionId: null, kind: "reset_credit", kindExplicit: true,
      action: "confirm", invalidatesEvent: false, real: true, role: "action", excerpt: text, title: localized("Reset credits available"),
      summary: localized("Pro and Team users receive one or two resets, usable by March 8."), timeExcerpt: "by March 8",
      rawScope: { audienceSource: "Pro users; Team users", plans: ["Pro", "Team"], audienceZh: null, productsZh: null },
      scope: { type: "unknown", productCodes: [], planCodes: ["pro", "team"], quotaWindowCodes: [], note: localized("Paid users") }, scopeExcerpt: "Pro users; Team users" }] : [] })) });
  const before = await loadActionInput();
  const result = await applyRecognitionGroup(ids.map(id => before.posts.find(post => post.id === id)!), [], { ...before, events: [], actions: [] },
    { ...body, receiptId: receipt!.id, model: "synthetic", promptVersion: "synthetic", reused: false });
  assert.equal(result.eventIds.length, 1);
  const after = await loadActionInput(), event = after.events.find(event => event.id === result.eventIds[0])!;
  assert.equal(event.type, "reset_credit"); assert.equal(reduceEvent(event, after)?.status, "completed");
  assert.ok(after.posts.filter(post => ids.includes(post.id)).every(post => post.title && post.model_receipt_id === receipt!.id));
  assert.ok(after.posts.filter(post => ids.slice(0, -1).includes(post.id)).every(post => post.processing_status === "processed"));
  const reviewed = after.posts.find(post => post.id === "805")!;
  assert.equal(reviewed.processing_status, "needs_attention");
  assert.match(reviewed.review_reason!, /使用或领取截止/);
  const actions = after.actions.filter(action => action.event_id === event.id);
  assert.equal(actions.length, 1); assert.equal(actions[0]!.action, "confirm");
  assert.deepEqual(actions[0]!.time, { kind: "instant", at: new Date(publishedAt).toISOString() });
  assert.deepEqual(actions[0]!.sources, [{ postId: "805" }]);
  assert.match(actions[0]!.summary!.en!, /March 8/);
  assert.deepEqual(event.scope!.planCodes, ["pro", "team"]);
}));

type Claim = ActionRecognitionBody["actions"][number];
const scopeCases: Array<{ name: string; patch: Partial<Claim>; reason: RegExp; verified?: boolean }> = [
  { name: "invalid scope quotation", patch: { scopeExcerpt: "all Enterprise users",
    rawScope: { audienceSource: "paid users on Pro", audienceZh: "付费 Pro 用户", productsZh: null, plans: ["Pro", "Enterprise"] } }, reason: /范围不在本帖中/ },
  { name: "missing scope quotation", patch: { scopeExcerpt: null }, reason: /明确范围缺少来源引文/ },
  { name: "conflicting audience mapping", patch: { scope: { type: "all_users", productCodes: [], planCodes: ["pro"], quotaWindowCodes: [], note: localized("All users") } },
    reason: /公开范围与原帖明确限制不一致/ },
  { name: "duplicate catalog mapping", patch: { scope: { type: "paid_users", productCodes: [], planCodes: ["pro", "pro"], quotaWindowCodes: [], note: localized("Paid users") } },
    reason: /影响范围含重复的目录代码/ },
  { name: "verified scope despite invalid action quotation", patch: { excerpt: "The model supplied a different issuance statement." },
    reason: /动作缺少本帖明确依据/, verified: true },
];

for (const [index, scenario] of scopeCases.entries()) test(`paid fallback preserves eligibility for ${scenario.name}`, async () => inMonitor(claude, async () => {
  const postId = `scope-fallback-${index}`, text = "We issued reset credits to paid users on Pro.", publishedAt = "2026-11-10T01:00:00Z";
  await storeCollectedPost({ id: postId, author: claude.authors[0]!.handle, publishedAt, text,
    url: `https://x.com/ClaudeDevs/status/${postId}`, receiptId: null });
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,status)
    VALUES(${postId},'synthetic','reset_monitor.claude.recognize','received') RETURNING id`;
  const claim: Claim = { eventId: null, localEventKey: postId, existingActionId: null, kind: "reset_credit", kindExplicit: true,
    action: "confirm", invalidatesEvent: false, real: true, role: "action", excerpt: text,
    title: localized("Reset credits issued"), summary: localized("Reset credits issued."), timeExcerpt: null,
    rawScope: { audienceSource: "paid users on Pro", audienceZh: "付费 Pro 用户", productsZh: null, plans: ["Pro"] },
    scope: { type: "paid_users", productCodes: [], planCodes: ["pro"], quotaWindowCodes: [], note: defaultScopeLabel("paid_users") },
    scopeExcerpt: "paid users on Pro", ...scenario.patch };
  const before = await loadActionInput();
  const body = threadOutputSchema([postId]).parse({ posts: [{ postId, relevant: true, needsReview: index === 0, reviewReason: index === 0 ? "模型范围需人工修订" : null,
    title: localized("Reset credits issued"), summary: null, actions: [claim] }] });
  const result = await applyRecognitionGroup([before.posts.find(post => post.id === postId)!], [], { ...before, events: [], actions: [] },
    { ...body, receiptId: receipt!.id, model: "synthetic", promptVersion: "synthetic", reused: false });
  assert.equal(result.eventIds.length, 1);
  const after = await loadActionInput(), event = after.events.find(event => event.id === result.eventIds[0])!;
  const post = after.posts.find(post => post.id === postId)!;
  assert.equal(post.processing_status, "needs_attention");
  assert.match(post.review_reason!, scenario.reason);
  if (index === 0) assert.match(post.review_reason!, /模型范围需人工修订/);
  assert.equal(post.model_receipt_id, receipt!.id);
  assert.equal(reduceEvent(event, after)?.status, "completed");
  const actions = after.actions.filter(action => action.event_id === event.id);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0]!.sources, [{ postId }]);
  assert.equal(actions[0]!.action, "confirm");
  assert.deepEqual(actions[0]!.time, { kind: "instant", at: new Date(publishedAt).toISOString() });
  if (scenario.verified) {
    assert.equal(event.scope!.type, "paid_users");
    assert.deepEqual(event.scope!.planCodes, ["pro"]);
  } else {
    assert.deepEqual(event.scope, { type: "unknown", productCodes: [], planCodes: [], quotaWindowCodes: [], note: defaultScopeLabel("unknown") });
    for (const summary of [event.summary, actions[0]!.summary]) for (const language of Object.keys(localized(""))) {
      assert.match(summary![language as keyof typeof summary], /付费 Pro 用户/);
      assert.doesNotMatch(summary![language as keyof typeof summary], /Enterprise/);
    }
  }
  const published = projectRawV2(after, claude).events.find(candidate => candidate.id === event.id)!;
  assert.ok(published, "reviewed model action stays publicly visible");
  assert.equal(published.status, "completed");
  assert.deepEqual(published.scope, event.scope);
  assert.equal(published.updates[0]!.id, actions[0]!.id);
}));
