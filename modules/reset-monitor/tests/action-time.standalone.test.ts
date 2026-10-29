import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActionTime } from "../backend/public-v2-time.ts";
import { actionEvidence, confirmsCompletedAction } from "../backend/evidence.ts";
import { actionRecognitionSchema, recognitionPrompt } from "../backend/recognize.ts";
import { properName } from "../backend/public-v2.ts";
import { inMonitor } from "../backend/context.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";

const at = "2026-10-23T12:00:00.000Z";
const post = (text: string) => ({ text, published_at: at });
const claim = () => ({ eventId: null, localEventKey: "event", existingActionId: null, kind: "direct_reset" as const, kindExplicit: true,
  action: "confirm" as const, invalidatesEvent: false, real: true, role: "action" as const, excerpt: "We reset usage earlier.", title: properName("Reset completed"), summary: null,
  timeExcerpt: null as string | null, rawScope: { audienceSource: null, audienceZh: null, productsZh: null, plans: null },
  scope: { type: "unknown" as const, productCodes: [], planCodes: [], quotaWindowCodes: [], note: properName("All users") }, scopeExcerpt: null });

test("missing and empty time fields do not invalidate a multi-action recognition response", () => {
  for (const value of [undefined, null, "", "  \n ", "soon"]) {
    const action = { ...claim(), timeExcerpt: value };
    const body = actionRecognitionSchema.parse({ relevant: true, needsReview: false, title: properName("Quota update"), summary: null, actions: [claim(), action] });
    assert.equal(body.actions.length, 2);
    assert.equal(body.actions[1]!.timeExcerpt, value?.trim() || null);
  }
});

test("unquoted and unparseable time expressions fall back without rejecting the action", () => {
  for (const [source, excerpt] of [
    ["We reset usage.", null],
    ["We reset usage.", "2026-10-24T12:00:00Z"],
    ["We reset usage earlier.", "earlier"],
    ["We reset usage on 2026-02-30.", "2026-02-30"],
    ["We reset usage at 10am CST.", "at 10am CST"],
    ["We reset usage around noon.", "around noon"],
  ] as const) {
    assert.deepEqual(resolveActionTime({ ...claim(), timeExcerpt: excerpt }, post(source)), { time: at, issue: null }, source);
  }
});

test("supported time precision is preserved and explicit future results still require review", () => {
  for (const [expression, expected] of [
    ["2026-10-23", "2026-10-23"],
    ["2026-10-23T10:00:00Z", "2026-10-23T10:00:00Z"],
    ["2026-10-23T10:00:00Z/2026-10-23T11:00:00Z", "2026-10-23T10:00:00Z/2026-10-23T11:00:00Z"],
  ]) assert.deepEqual(resolveActionTime({ ...claim(), timeExcerpt: expression! }, post(`We reset usage on ${expression}.`)), { time: expected, issue: null });
  const expression = "2026-10-24T10:00:00Z";
  assert.equal(resolveActionTime({ ...claim(), timeExcerpt: expression }, post(`We reset usage on ${expression}.`)).issue, "活动结果时间尚未发生");
  assert.deepEqual(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: expression }, post(`We will reset usage on ${expression}.`)), { time: expression, issue: null });
  const deadline = "before Oct 24, 2026 at 3pm UTC";
  assert.deepEqual(resolveActionTime({ ...claim(), timeExcerpt: deadline }, post(`We reset usage ${deadline}.`)), { time: at, issue: null }, "a future upper bound does not place the completed action in the future");
});

test("clear retrospective completions do not require a time excerpt or fabricated event association", () => {
  for (const expression of ["earlier", "previously", "yesterday", "last week"]) {
    const action = { ...claim(), excerpt: `We reset usage ${expression}.` };
    assert.equal(confirmsCompletedAction(action.excerpt), true);
    assert.equal(actionEvidence({ ...action, scope: action.rawScope }, []), "action");
    assert.equal(resolveActionTime(action, post(action.excerpt)).time, at);
  }
  for (const source of ["We will reset usage tomorrow.", "We have not reset usage.", "My usage was reset.", "We reset usage?", "If we reset usage, wait."])
    assert.equal(confirmsCompletedAction(source), false, source);
});

test("a linked follow-up announcement does not require explicit timing to provide action evidence", () => {
  const action = { ...claim(), eventId: "known-event", localEventKey: null, action: "announce" as const, excerpt: "It will land soon." };
  assert.equal(actionEvidence({ ...action, scope: action.rawScope }, []), "action");
  assert.deepEqual(resolveActionTime(action, post(action.excerpt)), { time: "2026-10-23", issue: null });
  assert.equal(actionEvidence({ ...action, eventId: null, scope: action.rawScope }, []), "related", "a time default cannot identify a missing event");
});

test("all unresolved announcement times use the Beijing publication date, including UTC date rollover", () => {
  for (const published_at of ["2026-10-23T15:59:59Z", "2026-10-23T16:00:00Z", "2026-10-23T23:30:00Z"]) {
    const date = published_at < "2026-10-23T16:00:00Z" ? "2026-10-23" : "2026-10-24";
    for (const timeExcerpt of [null, "soon", "nonliteral time", "2026-02-30"]) {
      assert.deepEqual(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt }, { text: "We will reset usage soon; 2026-02-30 is invalid.", published_at }), { time: date, issue: null });
    }
    for (const action of ["confirm", "progress", "amend"] as const)
      assert.equal(resolveActionTime({ action, invalidatesEvent: false, timeExcerpt: null }, { text: "Usage reset update.", published_at }).time, new Date(published_at).toISOString());
  }
});

test("all platform prompts tell the model that missing time alone does not require review", () => {
  for (const definition of [codex, claude, grok]) inMonitor(definition, () => {
    assert.match(recognitionPrompt(), /Missing or unparseable time alone must not set needsReview/);
    assert.doesNotMatch(recognitionPrompt(), /明确回顾完成但没有发生时间或唯一目标时复核/);
  });
});

test("an invalid source publication timestamp is not replaced with the current time", () => {
  assert.throws(() => resolveActionTime(claim(), { text: "We reset usage.", published_at: "invalid" }), RangeError);
});
