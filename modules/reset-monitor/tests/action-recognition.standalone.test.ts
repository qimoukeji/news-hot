import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionRecognitionSchema, recognitionPrompt, type Proposition } from "../backend/recognize.ts";
import { inMonitor } from "../backend/context.ts";
import { quotedInPost } from "../backend/assemble.ts";
import { resolveEventExpression } from "../backend/public-v2-time.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { embeddedQuote } from "../backend/post-policy.ts";
import { tweetText, type Tweet } from "../backend/providers/collectors.ts";

const localized = (text: string) => ({ en: text, zh: text, "zh-Hant": text, ja: text, ko: text, ru: text, es: text });
const claim = { eventId: null, localEventKey: "new-1", existingActionId: null, kind: "direct_reset", kindExplicit: true,
  action: "confirm", invalidatesEvent: false, real: true, role: "action", excerpt: "We reset usage.", title: localized("Usage reset"), summary: null,
  timeExcerpt: null, rawScope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null },
  scope: { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null }, scopeExcerpt: null };
const response = () => ({ relevant: true, needsReview: false, title: localized("Usage reset"), summary: null, actions: [structuredClone(claim)] });
const proposition = (excerpt: string, kind: Proposition["kind"] = "direct_reset"): Proposition => ({ kind, kindExplicit: true, action: "confirm",
  real: true, role: "action", eventId: null, excerpt, timeExcerpt: null,
  scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null } });

test("recognition requires all seven languages and accepts multiple actions for a local event", () => {
  const value = response();
  value.actions.push({ ...structuredClone(claim), action: "announce" });
  assert.equal(actionRecognitionSchema.parse(value).actions.length, 2);
  const missing = structuredClone(value) as any;
  delete missing.actions[0].title.ja;
  assert.equal(actionRecognitionSchema.safeParse(missing).success, false);
  const blank = structuredClone(value); blank.title.ko = " ";
  assert.equal(actionRecognitionSchema.safeParse(blank).success, false);
});

test("all platform prompts default unspecified quota kinds and preserve verified follow-up types", () => {
  for (const definition of [codex, claude, grok]) inMonitor(definition, () => {
    const prompt = recognitionPrompt();
    assert.match(prompt, /事件类型未明确说明时，默认使用“额度重置” direct_reset/);
    assert.match(prompt, /Event kind defaults to direct_reset/);
    assert.match(prompt, /inherit the existing event kind before applying the default/);
    assert.match(prompt, /Missing subtype detail alone does not require needsReview/);
    assert.match(prompt, /it cannot establish an action, identify a missing target/);
  });
  const value = response(); value.actions[0]!.kindExplicit = false;
  assert.equal(actionRecognitionSchema.parse(value).actions[0]!.kind, "direct_reset");
  for (const kind of ["reset_credit", "bonus_credit"]) {
    const explicit = { ...value, actions: [{ ...value.actions[0], kind, kindExplicit: true }] };
    assert.equal(actionRecognitionSchema.parse(explicit).actions[0]!.kind, kind);
  }
  const missing = structuredClone(value) as any; delete missing.actions[0].kind;
  assert.equal(actionRecognitionSchema.safeParse(missing).success, false, "the model must return its chosen kind explicitly");
});

test("recognition requires explicit invalidation and rejects retired action types", () => {
  const value = response(); value.actions[0]!.action = "amend"; value.actions[0]!.invalidatesEvent = true;
  assert.equal(actionRecognitionSchema.parse(value).actions[0]!.invalidatesEvent, true);
  for (const action of ["announce", "confirm", "progress", "amend"]) {
    const input = response(); input.actions[0]!.action = action;
    assert.equal(actionRecognitionSchema.parse(input).actions[0]!.action, action);
  }
  for (const action of ["cancel", "close", "expire", "reopen", "restore"]) {
    assert.equal(actionRecognitionSchema.safeParse({ ...value, actions: [{ ...value.actions[0], action }] }).success, false);
  }
  for (const action of ["announce", "confirm", "progress", "restore"])
    assert.equal(actionRecognitionSchema.safeParse({ ...value, actions: [{ ...value.actions[0], action, invalidatesEvent: true }] }).success, false);
  const missing = structuredClone(value) as any; delete missing.actions[0].invalidatesEvent;
  assert.equal(actionRecognitionSchema.safeParse(missing).success, false);
  for (const retired of [{ translationZh: "old raw translation" }, { status: "completed" }])
    assert.equal(actionRecognitionSchema.safeParse({ ...value, ...retired }).success, false);
  assert.equal(actionRecognitionSchema.safeParse({ ...value, actions: [{ ...value.actions[0], result: "available" }] }).success, false);
});

test("literal evidence tolerates punctuation but cannot borrow another sentence or an empty quote", () => {
  assert.equal(quotedInPost("Usage…has been reset", "Usage — has been reset."), true);
  assert.equal(quotedInPost("We reset every account", "We will reset some accounts tomorrow."), false);
  assert.equal(quotedInPost("", "We reset usage."), false);
});

test("collection keeps the outer body and only one embedded quotation separate", () => {
  const post: Tweet = { id_str: "outer", full_text: "Outer statement", tweet_created_at: "2026-10-23T12:00:00Z", user: { screen_name: "official", name: "Official" },
    quoted_status: { id_str: "quote", full_text: "Quoted statement", tweet_created_at: "2026-10-23T11:00:00Z", user: { screen_name: "quoted", name: "Quoted" },
      quoted_status: { id_str: "nested", full_text: "Nested statement", tweet_created_at: "2026-10-23T10:00:00Z", user: { screen_name: "nested", name: "Nested" } } } };
  assert.equal(tweetText(post), "Outer statement");
  const quotes = embeddedQuote(post);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0]!.text, "Quoted statement");
  assert.equal("quoted_status" in quotes[0]!, false);
});

test("all platforms exclude API credits, ordinary limit increases and routine reset policies", () => {
  for (const definition of [codex, claude, grok]) {
    for (const text of ["API credits are now available.", "We doubled usage limits.", "Usage resets every day automatically."]) {
      assert.ok(definition.excludeProposition?.(proposition(text), text), `${definition.monitorId}: ${text}`);
    }
    assert.equal(definition.excludeProposition?.(proposition("We reset usage for everyone."), "We reset usage for everyone."), null);
  }
  assert.equal(claude.excludeProposition?.(proposition("You can still claim the one time bonus credit for cloud sessions.", "bonus_credit"), "You can still claim the one time bonus credit for cloud sessions."), null);
});

test("source time parsing preserves date/range precision, explicit zones and unknown vague times", () => {
  const post = { text: "", published_at: "2026-10-23T12:00:00Z" };
  assert.deepEqual(resolveEventExpression("Oct 24 at 3pm UTC", post, true, ""), { kind: "instant", at: "2026-10-24T15:00:00Z" });
  assert.deepEqual(resolveEventExpression("Oct 24", post, true, ""), { kind: "date", date: "2026-10-24", timeZone: "UTC" });
  assert.deepEqual(resolveEventExpression("Oct 24 from 2pm to 3pm UTC", post, true, ""), { kind: "range", from: "2026-10-24T14:00:00Z", through: "2026-10-24T15:00:00Z" });
  assert.deepEqual(resolveEventExpression("soon", post, true, ""), { kind: "unknown" });
  assert.deepEqual(resolveEventExpression("claim by Oct 24", post, true, ""), { kind: "unknown" });
  assert.deepEqual(resolveEventExpression("claiming closed Oct 23 at 11:00 UTC", post, false, "", undefined, true), { kind: "instant", at: "2026-10-23T11:00:00Z" });
});


test("Claude generic follow-ups require a trusted existing bonus event before action evidence is checked", () => {
  const text = "The event has been cancelled.";
  const linked = { ...proposition(text, "bonus_credit"), action: "amend" as const, eventId: "existing" };
  assert.equal(claude.excludeProposition?.(linked, text, { trustedEventKinds: ["bonus_credit"] }), null);
  assert.ok(claude.excludeProposition?.(linked, text, { trustedEventKinds: [] }));
  assert.ok(claude.excludeProposition?.({ ...linked, eventId: null }, text, { trustedEventKinds: ["bonus_credit"] }));
  assert.ok(claude.excludeProposition?.(linked, text, { trustedEventKinds: ["direct_reset"] }));
  assert.ok(claude.excludeProposition?.({ ...linked, action: "confirm" }, text, { trustedEventKinds: ["bonus_credit"] }));
});
