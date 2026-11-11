import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { paidThreadOutputSchema, threadOutputSchema, type ThreadRecognitionInput } from "../backend/recognize.ts";

const title = { en: "Quota reset", zh: "额度重置", "zh-Hant": "額度重置", ja: "リセット", ko: "초기화", ru: "Сброс", es: "Reinicio" };
const claim = {
  kind: "direct_reset", kindExplicit: true, action: "confirm", role: "action", real: true, invalidatesEvent: false,
  eventId: null, localEventKey: "new-1", existingActionId: null, excerpt: "We reset quotas.", title, summary: null,
  timeExcerpt: null, scopeExcerpt: null,
  scope: { type: "unknown", note: null },
};
const unrelated = (postId: string) => ({ postId, title, summary: null, relevant: false, needsReview: false, reviewReason: null, actions: [] });
const related = (postId: string, ...actions: unknown[]) => ({ ...unrelated(postId), relevant: true, actions });
const material = (id: string): ThreadRecognitionInput["targets"][number] => ({
  id, author: "official", text: "We reset quotas.", publishedAt: "2026-11-10T00:00:00Z", replyTo: null, quotedPostId: null, version: "v1",
});
const input = (...ids: string[]): ThreadRecognitionInput => ({ targets: ids.map(material), context: [material("context")], events: [] });

test("paid parsing repairs formatting without changing valid results or loosening offline validation", () => {
  const clean = related("101", claim);
  const dirty = { ...clean, scope: null, actions: { ...claim, real: "true", timeExcerpt: "  ", title: { ...title, de: "Reset" }, transport: true } };
  const source = { type: "json_object", posts: [dirty, unrelated("102")] };
  assert.deepEqual(paidThreadOutputSchema(input("101", "102")).parse(source), { posts: [clean, unrelated("102")] });
  assert.equal(threadOutputSchema(["101", "102"]).safeParse(source).success, false);
  assert.equal(dirty.actions.timeExcerpt, "  ");
  assert.equal(dirty.actions.real, "true");
});

test("missing title and unknown scope go to review without erasing the supported action or the next post", () => {
  const damaged = { ...related("101", {
    ...claim, title: { zh: title.zh }, scope: { ...claim.scope, type: "paid" },
  }), title: null, needsReview: true, reviewReason: "已有疑问" };
  const clean = related("102", { ...claim, localEventKey: "new-2" });
  const result = paidThreadOutputSchema(input("101", "102")).parse({ posts: [damaged, clean] });
  assert.equal(result.failedPostIds, undefined);
  assert.deepEqual(result.posts[1], clean);
  const repaired = result.posts[0]!;
  assert.equal(repaired.needsReview, true);
  assert.match(repaired.reviewReason!, /已有疑问.*动作范围无法确认.*动作标题不完整.*帖子标题不完整/);
  assert.ok(repaired.title.en);
  assert.deepEqual(repaired.actions[0], {
    ...claim, title: { ...repaired.title, zh: title.zh }, scopeExcerpt: null,
  });
});

test("only unrecognizable types are omitted; malformed details do not erase a recognizable action", () => {
  const result = paidThreadOutputSchema(input("101")).parse({ posts: [related("101",
    { ...claim, kind: undefined }, { ...claim, action: "complete" }, { ...claim, invalidatesEvent: true },
    { ...claim, eventId: "outside", localEventKey: null }, { ...claim, eventId: 42 }, claim,
    { kind: "reset_credit", action: "progress" })] });
  assert.equal(result.failedPostIds, undefined);
  assert.deepEqual(result.posts[0]!.actions.map(action => [action.kind, action.action, action.eventId, action.invalidatesEvent]), [
    ["direct_reset", "confirm", null, false], ["direct_reset", "confirm", "outside", false], ["reset_credit", "progress", null, false],
  ]);
  assert.equal(result.posts[0]!.needsReview, true);
  assert.match(result.posts[0]!.reviewReason!, /部分动作/);
});

test("unverified associations are passed to the saving layer without inventing a target", () => {
  const facts = input("101", "102");
  const event = (id: string): ThreadRecognitionInput["events"][number] => ({
    id, kind: "direct_reset", status: "completed", publishedAt: material(id).publishedAt, title: title.zh,
    summary: null, time: null, scope: { type: "unknown", note: null }, sourcePostIds: [], actions: [],
  });
  facts.events = [event("event-a"), { ...event("event-b"), actions: [{
    id: "action-b", action: "confirm", sequence: 1, invalidatesEvent: false, title: title.zh, summary: null,
  }] }];
  const repeat = { ...claim, eventId: "event-b", localEventKey: null, existingActionId: "action-b" };
  const mismatched = related("101", { ...repeat, eventId: "event-a" });
  assert.deepEqual(paidThreadOutputSchema(facts).parse({ posts: [mismatched, related("102", repeat)] }), { posts: [mismatched, related("102", repeat)] });
});

test("only exact unique targets with a recognizable result are returned", () => {
  const result = paidThreadOutputSchema(input("101", "102", "103", "104", "105", "106", "107")).parse({ posts: [
    related("context", claim), related("unknown", claim), null, { ...related("101", claim), postId: 101 },
    related(" 101", claim), related("102", claim), { postId: "102" },
    related("103", { ...claim, action: "unknown" }), { ...unrelated("104"), actions: null },
    unrelated("105"), related("106"), { ...unrelated("107"), relevant: undefined },
  ] });
  assert.deepEqual(result, { posts: [unrelated("105"), related("106")], failedPostIds: ["101", "102", "103", "104", "107"] });
});

test("an empty posts list is a target-level failure; an unreadable envelope fails the schema", () => {
  const schema = paidThreadOutputSchema(input("101"));
  assert.deepEqual(schema.parse({ posts: [] }), { posts: [], failedPostIds: ["101"] });
  for (const value of [null, [], {}, { posts: null }, { posts: {} }, { posts: "[]" }]) {
    assert.equal(schema.safeParse(value).success, false);
  }
});
