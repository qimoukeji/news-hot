import { bt } from "./business-time-fixture.ts";
import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasExplicitFutureIssuance, isUsageTime, resolveActionTime as resolveAt } from "../backend/public-v2-time.ts";
import { actionEvidence, confirmsCompletedAction } from "../backend/evidence.ts";
import { actionRecognitionSchema, recognitionPrompt } from "../backend/recognize.ts";
import { properName } from "../backend/public-v2.ts";
import { inMonitor } from "../backend/context.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";

const at = "2026-10-23T12:00:00.000Z";
const post = (text: string) => ({ text, published_at: at });
const defaultTime = bt("2026-10-23T18:00:00Z");
// Keep first-processing defaults deterministic, independent of the machine clock.
function resolveActionTime(action: Parameters<typeof resolveAt>[0], source: Parameters<typeof resolveAt>[1], anchor?: string,
  now = new Date(source.published_at).getTime()) {
  return resolveAt(action, source, anchor, now);
}
function reviewed(result: ReturnType<typeof resolveAt>, message: string) {
  assert.deepEqual(result.time, defaultTime, message);
  assert.ok(result.issue, message);
}
const claim = () => ({ eventId: null, localEventKey: "event", existingActionId: null, kind: "direct_reset" as const, kindExplicit: true,
  action: "confirm" as const, invalidatesEvent: false, real: true, role: "action" as const, excerpt: "We reset usage earlier.", title: properName("Reset completed"), summary: null,
  timeExcerpt: null as string | null,
  scope: { type: "unknown" as const, note: null }, scopeExcerpt: null });

test("reset-credit usage deadlines never become delivery times, even in date-only excerpts", () => {
  const source = "We're giving Ultra and Team Premium users Fable resets based on how long you've subscribed:\n\n<6 mo: 1\n6–12 mo: 2\n>12 mo: 3\n\nUse them anytime by March 8.";
  for (const timeExcerpt of ["by March 8", "March 8", "Use them anytime by March 8."]) {
    reviewed(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt }, post(source)), timeExcerpt);
    assert.deepEqual(resolveActionTime({ action: "confirm", invalidatesEvent: false, timeExcerpt }, post(source)), { time: bt(at), issue: null });
  }
});

test("claim, redemption and expiry wording is recovered from the selected time's clause", () => {
  for (const source of [
    "Use your resets by March 8.", "You can redeem them until March 8.", "Claim your reset credits before March 8.",
    "The claim deadline is March 8.", "Reset credits expire on March 8.", "Resets are valid until March 8.",
    "Reset credits are usable until March 8.", "Reset credits are redeemable through March 8.", "March 8 is the last day to redeem the credits.",
    "重置卡可在 March 8 前使用。", "重置卡领取截止 March 8。", "重置卡将于 March 8 到期。",
  ]) {
    assert.equal(isUsageTime("March 8", source), true, source);
    reviewed(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: "March 8" }, post(source)), source);
    assert.deepEqual(resolveActionTime({ action: "confirm", invalidatesEvent: false, timeExcerpt: "March 8" }, post(source)),
      { time: bt(at), issue: null }, source);
  }
  const past = "We issued resets. Use them by Oct 22, 2026.";
  assert.deepEqual(resolveActionTime({ action: "confirm", invalidatesEvent: false, timeExcerpt: "Oct 22, 2026" }, post(past)),
    { time: bt(at), issue: null }, "a past redemption deadline is not the delivery time either");
  reviewed(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: "Mar. 8" }, post("Use them by Mar. 8.")),
    "a month abbreviation does not split the usage sentence");
});

test("separate future delivery plans survive adjacent usage instructions", () => {
  for (const source of [
    "We will give users resets on March 8. Use them by March 9.",
    "Use them by March 9. We will give users resets on March 8.",
    "We will issue reset credits on March 8; redeem them by March 9.",
    "We will issue reset credits on March 8, and you can use them until March 9.",
    "We will issue reset credits on March 8 and you can use them until March 9.",
    "Use them by March 9.\nWe will issue reset credits on March 8.",
  ]) assert.deepEqual(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: "March 8" }, post(source)),
    { time: bt("2027-03-08T18:00:00Z"), issue: null }, source);
  assert.deepEqual(resolveActionTime({ action: "confirm", invalidatesEvent: false, timeExcerpt: "Oct 22, 2026" },
    post("We issued resets on Oct 22, 2026. Use them by March 8.")),
    { time: bt(at), issue: null });
});

test("good-through and Chinese availability cutoffs use the existing action fallbacks", () => {
  for (const source of [
    "We will issue reset credits. The resets are good through March 8.",
    "We will issue reset credits, good through March 8.",
    "We will issue reset credits. 重置卡可用至 March 8。",
    "重置卡将发放，可用至March 8。",
    "重置卡有效至 March 8。",
  ]) {
    for (const timeExcerpt of ["March 8", source]) {
      assert.equal(isUsageTime(timeExcerpt, source), true, `${timeExcerpt}: ${source}`);
      reviewed(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt }, post(source)), source);
      assert.deepEqual(resolveActionTime({ action: "confirm", invalidatesEvent: false, timeExcerpt }, post(source)),
        { time: bt(at), issue: null }, source);
    }
  }
});

test("reset schedules govern their date after a product-usage qualification", () => {
  for (const source of [
    "For users who use Claude Code, resets start on November 12.",
    "For users who use Claude Code, resets begin on November 12, good through March 8.",
    "For users who use Claude Code, reset credits start on November 12, usable until March 8.",
  ]) {
    for (const timeExcerpt of ["November 12", "on November 12", source]) {
      assert.equal(isUsageTime(timeExcerpt, source), false, `${timeExcerpt}: ${source}`);
      assert.deepEqual(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt }, post(source)),
        { time: bt("2026-11-12T18:00:00Z"), issue: null }, source);
    }
    if (source.includes("March 8")) assert.equal(isUsageTime("March 8", source), true, source);
  }
  assert.equal(isUsageTime("November 12", "Use of reset credits starts on November 12."), true);
});

test("a date follows its own delivery or usage clause within a sentence", () => {
  for (const source of [
    "We will issue reset credits on Nov 12 for use on Fable only, usable until March 8.",
    "We will issue reset credits on Nov 12 (usable until March 8).",
    "We will issue reset credits for use on Fable on Nov 12, usable until March 8.",
    "Reset credits usable until March 8 will be issued on Nov 12.",
    "We will issue reset credits on Nov 12 with a claim deadline of March 8.",
    "重置卡将于 Nov 12 发放，须在 March 8 前使用。",
  ]) {
    assert.equal(isUsageTime("Nov 12", source), false, source);
    assert.equal(isUsageTime("March 8", source), true, source);
    assert.deepEqual(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: "Nov 12" }, post(source)),
      { time: bt("2026-11-12T18:00:00Z"), issue: null }, source);
    reviewed(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: "March 8" }, post(source)), source);
    assert.deepEqual(resolveActionTime({ action: "confirm", invalidatesEvent: false, timeExcerpt: "March 8" }, post(source)),
      { time: bt(at), issue: null }, source);
  }
  for (const source of [
    "We issued reset credits on Oct 22 at 10am UTC, usable until March 8.",
    "We issued reset credits on Oct 22 at 10am UTC, use them within 3 days.",
  ]) assert.deepEqual(resolveActionTime({ action: "confirm", invalidatesEvent: false, timeExcerpt: source }, post(source)),
    { time: bt(at), issue: null }, source);
});

test("a repeated date needs usage wording to identify the selected occurrence as a cutoff", () => {
  const source = "We will issue reset credits on Nov 12, usable until Nov 12.";
  assert.equal(isUsageTime("Nov 12", source), false);
  assert.equal(isUsageTime("issued on Nov 12", "Reset credits will be issued on Nov 12, usable until Nov 12."), false);
  assert.equal(isUsageTime("usable until Nov 12", source), true);
  assert.equal(isUsageTime("use them by tomorrow", "We will issue reset credits today; use them by tomorrow."), true);
  assert.equal(isUsageTime("10am", "Reset credits are usable until 10am."), true);
  assert.equal(isUsageTime("March 8", "重置卡可在March 8前使用。"), true);
  for (const source of [
    "Reset credits will be issued on Nov 12, good through Nov 12.",
    "重置卡将于 Nov 12 发放，可用至 Nov 12。",
  ]) {
    assert.equal(isUsageTime("Nov 12", source), false, source);
    const cutoff = source.startsWith("Reset") ? "good through Nov 12" : "可用至 Nov 12";
    assert.equal(isUsageTime(cutoff, source), true, source);
  }
});

test("future issuance evidence does not depend on a selected time quote", () => {
  for (const excerpt of [
    "We will issue reset credits.",
    "We'll be giving users another batch of resets.",
    "Reset credits are scheduled to be issued on Nov 12.",
    "We’re going to grant reset credits.",
    "重置卡将于明天发放。",
  ]) {
    assert.equal(hasExplicitFutureIssuance(excerpt), true, excerpt);
    assert.deepEqual(resolveActionTime(claim(), post(excerpt)), { time: bt(at), issue: null });
  }
  for (const excerpt of [
    "Reset credits are usable until Nov 12.",
    "You'll be able to redeem reset credits tomorrow.",
    "We will not issue reset credits.",
    "If the rollout works, we will issue reset credits.",
    "Will we issue reset credits tomorrow?",
    "We issued reset credits earlier. We will issue more reset credits tomorrow.",
    "We will post instructions for reset credits tomorrow.",
    "We will issue an update about reset credits tomorrow.",
    "重置卡将于明天到期。",
  ]) assert.equal(hasExplicitFutureIssuance(excerpt), false, excerpt);
});

test("an ongoing issuance statement can schedule a future date without rolling past dates forward", () => {
  const text = "We're giving users reset credits on November 12. Use them anytime.";
  for (const published_at of ["2026-10-29T12:00:00Z", "2026-11-10T12:00:00Z"]) {
    const source = { text, published_at };
    assert.equal(hasExplicitFutureIssuance(text, source), true, published_at);
    assert.deepEqual(resolveActionTime(claim(), source), { time: bt(new Date(published_at).toISOString()), issue: null });
  }
  for (const published_at of ["2026-11-12T12:00:00Z", "2026-11-13T12:00:00Z", "2027-01-02T12:00:00Z"]) {
    const excerpt = published_at.startsWith("2027") ? text.replace("November 12", "November 12, 2026") : text;
    assert.equal(hasExplicitFutureIssuance(excerpt, { text: excerpt, published_at }), false, published_at);
  }
  const nextYear = text.replace("November 12", "January 2, 2027");
  assert.equal(hasExplicitFutureIssuance(nextYear, { text: nextYear, published_at: "2026-12-31T12:00:00Z" }), true);
  const sameDayPst = text.replace("November 12", "November 12 PST");
  assert.equal(hasExplicitFutureIssuance(sameDayPst, { text: sameDayPst, published_at: "2026-11-12T03:00:00Z" }), true);
  for (const excerpt of [
    "We're giving users reset credits to use on November 12.",
    "We're giving users reset credits usable until November 12.",
    "We're giving reset credits to users who subscribed on November 12.",
  ]) assert.equal(hasExplicitFutureIssuance(excerpt, post(excerpt)), false, excerpt);
});

test("date-only progress uses publication while preserving closure and expiry evidence", () => {
  for (const source of ["Reset credits expired on Oct 22, 2026.", "Claims closed on Oct 22, 2026.", "重置卡于 Oct 22, 2026 到期。"])
    assert.deepEqual(resolveActionTime({ action: "progress", invalidatesEvent: false, timeExcerpt: "Oct 22, 2026" }, post(source)),
      { time: bt("2026-10-23T12:00:00Z"), issue: null }, source);
});

test("progress retains explicit closure instants and ranges and reviews future results", () => {
  for (const expression of ["2026-10-22T10:00:00Z", "2026-10-22T10:00:00Z/2026-10-22T11:00:00Z"]) {
    assert.deepEqual(resolveActionTime({ action: "progress", invalidatesEvent: false, timeExcerpt: expression },
      post(`Claims closed on ${expression}.`)), { time: bt(expression), issue: null });
  }
  const expression = "2026-10-24T10:00:00Z";
  reviewed(resolveActionTime({ action: "progress", invalidatesEvent: false, timeExcerpt: expression },
    post(`Claims closed on ${expression}.`)), "a future result does not become an actual closure time");
});

test("November delivery survives the March usage deadline in a semicolon clause or separate schedule", () => {
  for (const source of [
    "We will issue reset credits on Nov 12; use them by March 8",
    "Use them by March 8. Separately, we will issue reset credits on Nov 12.",
  ]) {
    assert.deepEqual(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: "Nov 12" }, post(source)),
      { time: bt("2026-11-12T18:00:00Z"), issue: null }, source);
    reviewed(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: "by March 8" }, post(source)), source);
    assert.deepEqual(resolveActionTime({ action: "confirm", invalidatesEvent: false, timeExcerpt: "by March 8" }, post(source)),
      { time: bt(at), issue: null }, source);
  }
});

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
    assert.deepEqual(resolveActionTime({ ...claim(), timeExcerpt: excerpt }, post(source)), { time: bt(at), issue: null }, source);
  }
});

test("announcement precision is normalized and confirmation quotes never replace publication", () => {
  for (const [expression, expected] of [
    ["2026-10-23", "2026-10-23T18:00:00Z"],
    ["2026-10-23T10:00:00Z", "2026-10-23T10:00:00Z"],
    ["2026-10-23T10:00:00Z/2026-10-23T11:00:00Z", "2026-10-23T10:00:00Z/2026-10-23T11:00:00Z"],
  ]) {
    assert.deepEqual(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: expression! },
      post(`We will reset usage on ${expression}.`)), { time: bt(expected!), issue: null });
    assert.deepEqual(resolveActionTime({ ...claim(), timeExcerpt: expression! }, post(`We reset usage on ${expression}.`)),
      { time: bt(at), issue: null });
  }
  const expression = "2026-10-24T10:00:00Z";
  assert.deepEqual(resolveActionTime({ ...claim(), timeExcerpt: expression }, post(`We reset usage on ${expression}.`)), { time: bt(at), issue: null });
  assert.deepEqual(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: expression }, post(`We will reset usage on ${expression}.`)), { time: bt(expression), issue: null });
  const deadline = "before Oct 24, 2026 at 3pm UTC";
  assert.deepEqual(resolveActionTime({ ...claim(), timeExcerpt: deadline }, post(`We reset usage ${deadline}.`)), { time: bt(at), issue: null }, "a future upper bound does not place the completed action in the future");
});

test("clear retrospective completions do not require a time excerpt or fabricated event association", () => {
  for (const expression of ["earlier", "previously", "yesterday", "last week"]) {
    const action = { ...claim(), excerpt: `We reset usage ${expression}.` };
    assert.equal(confirmsCompletedAction(action.excerpt), true);
    assert.equal(actionEvidence(action, []), "action");
    assert.deepEqual(resolveActionTime(action, post(action.excerpt)).time, bt(at));
  }
  for (const source of ["We will reset usage tomorrow.", "We have not reset usage.", "My usage was reset.", "We reset usage?", "If we reset usage, wait."])
    assert.equal(confirmsCompletedAction(source), false, source);
});

test("a linked follow-up announcement does not require explicit timing to provide action evidence", () => {
  const action = { ...claim(), eventId: "known-event", localEventKey: null, action: "announce" as const, excerpt: "It will land soon." };
  assert.equal(actionEvidence(action, []), "action");
  assert.deepEqual(resolveActionTime(action, post(action.excerpt)), { time: bt("2026-10-23T18:00:00.000Z"), issue: null });
  assert.equal(actionEvidence({ ...action, eventId: null }, []), "related", "a time default cannot identify a missing event");
});

test("undated announcements use the first-processing boundary and invalid metadata requires review", () => {
  for (const published_at of ["2026-10-23T15:59:59Z", "2026-10-23T16:00:00Z", "2026-10-23T23:30:00Z"]) {
    const source = { text: "We will reset usage soon; 2026-02-30 is invalid.", published_at };
    assert.deepEqual(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt: null }, source),
      { time: bt(published_at > "2026-10-23T18:00:00Z" ? "2026-10-23T23:59:00.000Z" : "2026-10-23T18:00:00.000Z"), issue: null });
    for (const timeExcerpt of ["soon", "nonliteral time", "2026-02-30"]) {
      reviewed(resolveActionTime({ action: "announce", invalidatesEvent: false, timeExcerpt }, source), `${published_at}: ${timeExcerpt}`);
    }
    for (const action of ["confirm", "progress"] as const)
      assert.deepEqual(resolveActionTime({ action, invalidatesEvent: false, timeExcerpt: null }, { text: "Usage reset update.", published_at }).time,
        bt(action === "confirm" ? new Date(published_at).toISOString() : published_at));
  }
});

test("amendments without usable time use the earliest 10:00 UTC at or after publication", () => {
  for (const [published_at, expected] of [
    ["2026-10-23T09:59:59Z", "2026-10-23T10:00:00.000Z"],
    ["2026-10-23T10:00:00Z", "2026-10-23T10:00:00.000Z"],
    ["2026-10-23T09:59:59.999999999Z", "2026-10-23T10:00:00.000Z"],
    ["2026-10-23T10:00:00.000000001Z", "2026-10-24T10:00:00.000Z"],
    ["2026-10-23T10:00:00.001Z", "2026-10-24T10:00:00.000Z"],
    ["2026-10-23T10:00:01Z", "2026-10-24T10:00:00.000Z"],
    ["2026-10-23T15:59:59Z", "2026-10-24T10:00:00.000Z"],
    ["2026-10-23T16:00:00Z", "2026-10-24T10:00:00.000Z"],
    ["2026-10-23T23:59:59Z", "2026-10-24T10:00:00.000Z"],
    ["2026-10-24T00:00:00Z", "2026-10-24T10:00:00.000Z"],
    ["2026-10-31T17:00:00Z", "2026-11-01T10:00:00.000Z"],
    ["2026-11-02T17:00:00Z", "2026-11-03T10:00:00.000Z"],
    ["2026-12-31T17:00:00Z", "2027-01-01T10:00:00.000Z"],
    ["2027-01-01T00:00:00Z", "2027-01-01T10:00:00.000Z"],
    ["2026-10-23T23:30:00-07:00", "2026-10-24T10:00:00.000Z"],
    ["2027-01-01T02:00:00+09:00", "2027-01-01T10:00:00.000Z"],
  ]) {
    for (const timeExcerpt of [undefined, null, "", "  ", "soon", "not in the source", "2026-02-30"]) {
      const action = actionRecognitionSchema.parse({ relevant: true, needsReview: false, title: properName("Eligibility correction"), summary: null,
        actions: [{ ...claim(), action: "amend", timeExcerpt }] }).actions[0]!;
      const source = { text: "Eligibility corrected; soon and 2026-02-30 give no usable time.", published_at: published_at! };
      const result = resolveActionTime(action, source);
      if (action.timeExcerpt === null) {
        assert.deepEqual(result, { time: bt(expected!), issue: null }, `${published_at}: ${String(timeExcerpt)}`);
      } else {
        assert.deepEqual(result.time, bt(`${new Date(published_at!).toISOString().slice(0, 10)}T18:00:00Z`), `${published_at}: ${String(timeExcerpt)}`);
        assert.ok(result.issue, `${published_at}: ${String(timeExcerpt)}`);
      }
    }
  }
});

test("amendment dates use the daily default while exact times and ranges retain precision", () => {
  for (const [expression, expected] of [
    ["2026-10-23", bt("2026-10-24T10:00:00.000Z")],
    ["2026-10-23T09:15:00.123456789Z", bt("2026-10-23T09:15:00.123456789Z")],
    ["2026-10-23T08:00:00Z/2026-10-23T09:00:00Z", bt("2026-10-23T08:00:00Z/2026-10-23T09:00:00Z")],
  ] as const) assert.deepEqual(resolveActionTime({ action: "amend", invalidatesEvent: false, timeExcerpt: expression },
    post(`Eligibility corrected on ${expression}.`)), { time: expected, issue: null });
});

test("all platform prompts distinguish missing time defaults from invalid time review", () => {
  for (const definition of [codex, claude, grok]) inMonitor(definition, () => {
    assert.match(recognitionPrompt(), /Missing or vague time uses timeExcerpt=null and must not reject an otherwise supported action/);
    assert.match(recognitionPrompt(), /An amendment without time uses the next 10:00 UTC at or after publication/);
    assert.match(recognitionPrompt(), /announcement dates default to 18:00 UTC/);
    assert.match(recognitionPrompt(), /Confirmations always use source publication time/);
    assert.match(recognitionPrompt(), /Invalid time metadata is retained through the existing review flow with a default time/);
    assert.match(recognitionPrompt(), /do not fabricate a timeExcerpt/);
    assert.match(recognitionPrompt(), /Ordinary changed facts remain amend; their time records the correction itself and does not reschedule a promise/);
    assert.doesNotMatch(recognitionPrompt(), /明确回顾完成但没有发生时间或唯一目标时复核/);
  });
});

test("an invalid source publication timestamp is not replaced with the current time", () => {
  assert.throws(() => resolveActionTime(claim(), { text: "We reset usage.", published_at: "invalid" }), RangeError);
});
