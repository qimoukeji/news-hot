import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { inMonitor } from "../backend/context.ts";
import { bonusCreditOf } from "../backend/bonus-credit.ts";
import { presentationStatus } from "../backend/read.ts";
import type { ContextInput, Proposition } from "../backend/recognize.ts";
import { backendDefinition } from "../../claude-reset/backend-definition.ts";
import { cloudBonus } from "../../claude-reset/tests/cloud-bonus.fixture.ts";
import { bonusRecognition } from "../../claude-reset/tests/bonus-credit.fixture.ts";

type BonusCredit = NonNullable<Proposition["bonusCredit"]>;
type BonusTime = NonNullable<BonusCredit["claimDeadline"]>;
const postAt = new Date("2026-12-31T12:00:00Z");
const deadline = "Claim by 2027-01-02 at 18:00 UTC.";
const words = (date: string | null, clock = "18:00"): NonNullable<BonusTime["statedTime"]> => ({
  precision: "deadline", date, clock, timezone: "UTC", relativeHours: null, period: null, clockThrough: null, dayOffset: null,
});
const time = (source: string, statedTime = words("2027-01-02"), timeSourceId: string | null = null): BonusTime => ({
  source, statedTime, timeSourceId, at: null,
});
const context = (patch: Partial<ContextInput> = {}): ContextInput => ({
  id: "parent", author: "ClaudeDevs", relation: "reply", text: deadline, publishedAt: "2026-12-31T10:00:00Z", ...patch,
});

function convert(times: Pick<BonusCredit, "claimDeadline" | "expiresAt">, input: {
  text?: string; publishedAt?: Date; context?: ContextInput[];
} = {}) {
  const text = input.text ?? [times.claimDeadline?.source, times.expiresAt?.source].filter(Boolean).join(" ");
  const proposition: Proposition = {
    kind: "bonus_credit", kindExplicit: true, action: "confirm", real: true, count: 1, role: "action", relatesTo: null,
    excerpt: "You can claim a one-time bonus credit for cloud sessions.", excerptZh: "云会话奖励额度可领取。",
    statedTime: null, timeInferred: false, expectedLanding: null,
    scope: { audienceSource: null, audienceZh: null, productsZh: null, plans: null },
    bonusCredit: { amount: null, eligibility: null, claimMethod: null, ...times },
  };
  return inMonitor(backendDefinition, () => {
    const result = bonusCreditOf(proposition, { id: "official", text, publishedAt: input.publishedAt ?? postAt, context: input.context ?? [] });
    assert.ok(result);
    return result;
  });
}

test("bonus deadlines and expiry convert zero-padded source clocks", () => {
  const claim = "Claim by 2027-01-02 at 06:00 UTC.";
  const expiry = "The credit expires on 2027-01-03 at 09:30 UTC.";
  const result = convert({ claimDeadline: time(claim, words("2027-01-02", "06:00")), expiresAt: time(expiry, words("2027-01-03", "09:30")) });
  assert.deepEqual(result.claimDeadline, { source: claim, at: "2027-01-02T14:00:00.000+08:00" });
  assert.deepEqual(result.expiresAt, { source: expiry, at: "2027-01-03T17:30:00.000+08:00" });
  const midnight = "The credit expires on 2027-01-03 at 00:00 UTC.";
  assert.deepEqual(convert({ claimDeadline: null, expiresAt: time(midnight, words("2027-01-03", "00:00")) }).expiresAt,
    { source: midnight, at: "2027-01-03T08:00:00.000+08:00" });
});

for (const date of ["2026-01-02", "2027-01-02", null]) {
  test(`bonus time without a source year stays unknown when the model supplies ${date ?? "no date"}`, () => {
    const source = "Claim the credit by Jan 2 at 6pm UTC.";
    const unknown = { source, at: null };
    const result = convert({ claimDeadline: time(source, words(date)), expiresAt: time(source, words(date)) });
    assert.deepEqual(result.claimDeadline, unknown);
    assert.deepEqual(result.expiresAt, unknown);
  });
}

test("a named date without a year cannot reuse the matching publication day", () => {
  const source = "Claim the credit by Dec 31 at 6pm UTC.";
  const result = convert({ claimDeadline: time(source, words("2026-12-31")), expiresAt: time(source, words("2026-12-31")) });
  assert.deepEqual(result.claimDeadline, { source, at: null });
  assert.deepEqual(result.expiresAt, { source, at: null });
});

test("September aliases require a source year even on the publication day", () => {
  for (const month of ["Sep", "Sept", "September"]) {
    const source = `Claim the credit by ${month} 23 at 6pm UTC.`;
    const result = convert({ claimDeadline: time(source, words("2026-09-23")), expiresAt: time(source, words("2026-09-23")) },
      { publishedAt: new Date("2026-09-23T12:00:00Z") });
    assert.deepEqual(result.claimDeadline, { source, at: null });
    assert.deepEqual(result.expiresAt, { source, at: null });
  }
});

test("September aliases with an explicit source year convert normally", () => {
  for (const month of ["Sep", "Sept", "September"]) {
    const source = `Claim the credit by ${month} 23, 2026 at 6pm UTC.`;
    const result = convert({ claimDeadline: time(source, words("2026-09-23")), expiresAt: time(source, words("2026-09-23")) },
      { publishedAt: new Date("2026-09-23T12:00:00Z") });
    const expected = { source, at: "2026-09-24T02:00:00.000+08:00" };
    assert.deepEqual(result.claimDeadline, expected);
    assert.deepEqual(result.expiresAt, expected);
  }
});

test("the saved cloud bonus preserves unknown deadline and expiry years without closing the campaign", () => {
  inMonitor(backendDefinition, () => {
    const bonusCredit = bonusCreditOf(bonusRecognition().propositions[0]!, {
      id: cloudBonus.id, text: cloudBonus.text, publishedAt: new Date(cloudBonus.publishedAt), context: cloudBonus.context,
    });
    assert.ok(bonusCredit);
    assert.deepEqual(bonusCredit.claimDeadline, { source: "Run /claim-credit in Claude Code by Oct 7 at 11:59pm PT.", at: null });
    assert.deepEqual(bonusCredit.expiresAt, { source: "expires Nov 4", at: null });
    assert.equal(presentationStatus({
      type: "bonus_credit", status: "confirmed", confirmation_basis: "source_post", schedule: null, estimate: null,
      presentation: { scopeKnown: false, scopeLabel: null, kindExplicit: true, timeInferred: false,
        audienceZh: null, productsZh: null, reportedAt: null, bonusCredit },
    }, Date.parse("2026-10-10T00:00:00Z")), "available");
  });
});

test("bonus time from another author's context is rejected for both fields", () => {
  for (const relation of ["reply", "quote"] as const) {
    const result = convert({ claimDeadline: time(deadline, words("2027-01-02"), "parent"), expiresAt: time(deadline, words("2027-01-02"), "parent") },
      { text: "You can claim a one-time bonus credit for cloud sessions.", context: [context({ author: "OtherAuthor", relation })] });
    assert.equal(result.claimDeadline, null);
    assert.equal(result.expiresAt, null);
  }
});

test("bonus time stated in the official main post converts normally", () => {
  for (const timeSourceId of [null, "official"]) {
    assert.deepEqual(convert({ claimDeadline: time(deadline, words("2027-01-02"), timeSourceId), expiresAt: null }).claimDeadline,
      { source: deadline, at: "2027-01-03T02:00:00.000+08:00" });
  }
});

test("official reply and quote context supply bonus time evidence", () => {
  for (const relation of ["reply", "quote"] as const) {
    const result = convert({ claimDeadline: time(deadline, words("2027-01-02"), "parent"), expiresAt: time(deadline, words("2027-01-02"), "parent") },
      { text: "You can claim a one-time bonus credit for cloud sessions.", context: [context({ relation, author: "@CLAUDEDEVS" })] });
    const expected = { source: deadline, at: "2027-01-03T02:00:00.000+08:00" };
    assert.deepEqual(result.claimDeadline, expected);
    assert.deepEqual(result.expiresAt, expected);
  }
});

test("official context with a future or missing publication date retains unknown bonus time", () => {
  for (const publishedAt of ["2026-12-31T13:00:00Z", null]) {
    const result = convert({ claimDeadline: time(deadline, words("2027-01-02"), "parent"), expiresAt: time(deadline, words("2027-01-02"), "parent") },
      { text: "You can claim a one-time bonus credit for cloud sessions.", context: [context({ publishedAt })] });
    assert.deepEqual(result.claimDeadline, { source: deadline, at: null });
    assert.deepEqual(result.expiresAt, { source: deadline, at: null });
  }
});

test("expiry cannot borrow the claim deadline's timezone", () => {
  const expiry = "The credit expires on 2027-01-03 at 18:00.";
  const result = convert({ claimDeadline: time(deadline), expiresAt: time(expiry, words("2027-01-03")) });
  assert.deepEqual(result.claimDeadline, { source: deadline, at: "2027-01-03T02:00:00.000+08:00" });
  assert.deepEqual(result.expiresAt, { source: expiry, at: null });
});
