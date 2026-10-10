import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { inMonitor } from "@aihot/reset-monitor/backend/context";
import { applyRecognition } from "@aihot/reset-monitor/backend/assemble";
import { openEvents, processPending } from "@aihot/reset-monitor/backend/scan";
import type { ContextInput, Proposition, Recognition } from "@aihot/reset-monitor/backend/recognize";
import { backendDefinition } from "../backend-definition.ts";

const scoped = <T>(run: () => T) => inMonitor(backendDefinition, run);
const grant = "Existing subscribers get a one-time credit to try them: $100 on Pro, $250 on Max.";
const launch = `Cloud sessions are officially available! ${grant}`;
const at = new Date("2026-09-23T21:23:41Z");
after(closeDb);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts WHERE monitor_id='claude'`;
  await sql`DELETE FROM monitor_events WHERE monitor_id='claude'`;
  await sql`DELETE FROM monitor_posts WHERE monitor_id='claude'`;
});
function rec(excerpt: string, patch: Partial<Proposition> = {}): Recognition {
  return { relevant: true, translationZh: null, contextZh: [], outage: null, needsReview: false, model: "test", promptVersion: "test", receiptId: 0,
    propositions: [{ kind: "bonus_credit", kindExplicit: true, action: "confirm", role: "action", real: true, count: 1, relatesTo: null,
      excerpt, excerptZh: excerpt, statedTime: null, timeInferred: false, expectedLanding: null,
      scope: { audienceSource: null, audienceZh: null, productsZh: null, plans: null }, ...patch }] };
}
async function post(id: string, text: string, recognition: Recognition, publishedAt = at, context: ContextInput[] = []) {
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,raw)
    VALUES ('claude',${id},'ClaudeDevs',${publishedAt},${text},${`https://x.com/ClaudeDevs/status/${id}`},${sql.json({context} as never)})`;
  const applied = await scoped(() => applyRecognition(id, recognition));
  const [saved] = await sql`SELECT recognition FROM monitor_posts WHERE monitor_id='claude' AND id=${id}`;
  return { applied, saved: saved!.recognition };
}
const parent = (id: string, text: string, publishedAt = at, author = "ClaudeDevs"): ContextInput => ({ id, text, author, publishedAt: publishedAt.toISOString(), relation: "reply" });

test("actual get and receive reward grants create one event; unsupported claimed actions stay visible", async () => {
  const first = await post("grant", launch, rec(grant));
  assert.equal(first.applied.eventIds.length, 1);
  const receive = grant.replace("get", "receive");
  assert.equal((await post("receive", `Cloud sessions. ${receive}`, rec(receive))).applied.eventIds.length, 1);
  const unclear = "A one-time credit for cloud sessions exists.";
  const held = await post("unclear", unclear, rec(unclear));
  assert.equal(held.applied.eventIds.length, 0);
  assert.equal(held.saved.needsReview, true);
  assert.match(held.saved.held[0].reason, /动作/);
});

test("verified official thread enriches a single reward through intervening replies without repeating one-time", async () => {
  const initial = await post("launch", launch, rec(grant, { bonusCredit: { amount: "$100 on Pro, $250 on Max", eligibility: "Existing subscribers", claimMethod: null, claimDeadline: null, expiresAt: null } }));
  const intermediate = "Cloud sessions run on Anthropic-hosted infrastructure.";
  await post("instruction", intermediate, rec(grant), new Date(at.getTime() + 1000), [parent("launch", launch)]);
  const detail = "The credit is separate from your usage limits, and it applies automatically once you start a cloud session. One credit per account, for cloud sessions only.";
  const detailAt = new Date(at.getTime() + 2000);
  const supplement = rec(detail, { role: "explanation", real: false, bonusCredit: { amount: null, eligibility: null, claimMethod: null, usageTerms: detail, claimDeadline: null, expiresAt: null } });
  const result = await post("detail", detail, supplement, detailAt, [parent("instruction", intermediate, new Date(at.getTime() + 1000))]);
  assert.deepEqual(result.applied.eventIds, initial.applied.eventIds);
  assert.deepEqual(result.applied.notify, []);
  assert.deepEqual(result.saved.modelResult, supplement);
  const [event] = await sql`SELECT presentation,confirmed_at FROM monitor_events WHERE monitor_id='claude' AND id=${initial.applied.eventIds[0]!}`;
  assert.equal(event!.presentation.bonusCredit.amount, "$100 on Pro, $250 on Max");
  assert.equal(event!.presentation.bonusCredit.usageTerms, detail);
  assert.equal(event!.confirmed_at.getTime(), at.getTime());
  const [instruction] = await sql`SELECT recognition FROM monitor_posts WHERE monitor_id='claude' AND id='instruction'`;
  assert.equal(instruction!.recognition.needsReview, true, "parent quote cannot masquerade as main-post evidence");
});

test("foreign, forged, future and cross-monitor ancestry cannot authorize bonus details", async () => {
  await post("launch", launch, rec(grant));
  const detail = "The credit applies automatically.";
  for (const [index, context] of [parent("launch", launch, at, "OtherAuthor"), parent("launch", `${launch} forged`), parent("launch", launch, new Date(at.getTime() + 1000)), parent("codex-only", launch)].entries()) {
    if (index === 3) await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url) VALUES ('codex','codex-only','ClaudeDevs',${at},${launch},'https://example.test/codex')`;
    const result = await post(`untrusted-${index}`, detail, rec(detail), at, [context]);
    assert.deepEqual(result.applied.eventIds, []);
    assert.equal(result.saved.exclusions.length, 1);
  }
});

test("an explicitly named standalone reminder enriches its verified reward without another confirmation", async () => {
  const initial = await post("launch", launch, rec(grant));
  const text = "You can still claim the credit. Run /claim-credit in Claude Code.";
  const reminder = await post("standalone", text, rec(text, { role: "explanation", real: false, action: "amend",
    relatesTo: initial.applied.eventIds[0]!, bonusCredit: { amount: null, eligibility: null, claimMethod: "Run /claim-credit in Claude Code.", claimDeadline: null, expiresAt: null } }),
    new Date(at.getTime() + 14 * 86400_000));
  assert.deepEqual(reminder.applied.eventIds, initial.applied.eventIds);
  assert.deepEqual(reminder.applied.notify, []);
  const [event] = await sql`SELECT presentation,confirmed_at FROM monitor_events WHERE monitor_id='claude' AND id=${initial.applied.eventIds[0]!}`;
  assert.equal(event!.presentation.bonusCredit.claimMethod, "Run /claim-credit in Claude Code.");
  assert.equal(event!.confirmed_at.getTime(), at.getTime());
});

test("a second reward in the same official thread is independent; ambiguous details require review", async () => {
  const first = await post("first", launch, rec(grant));
  const another = "Existing subscribers get another one-time bonus credit for cloud sessions: $50.";
  const later = new Date(at.getTime() + 1000);
  const second = await post("second", another, rec(another), later, [parent("first", launch)]);
  assert.equal(second.applied.eventIds.length, 1);
  assert.notEqual(second.applied.eventIds[0], first.applied.eventIds[0]);
  const detail = "The credit applies automatically.";
  const held = await post("ambiguous", detail, rec(detail), new Date(at.getTime() + 2000), [parent("first", launch), parent("second", another, later)]);
  assert.equal(held.saved.needsReview, true);
  assert.deepEqual(held.applied.eventIds, []);
  assert.match(held.saved.held[0].reason, /多个奖励活动/);
});

test("old reset card remains a bounded candidate; weekday reminder needs a unique explicit target", async () => {
  const text = "Pro, Max, and Team users get a reset to use anytime.";
  const initial = await post("card", text, rec(text, { kind: "reset_credit" }));
  const reminderAt = new Date(at.getTime() + 145.867 * 3600_000);
  const candidates = await scoped(() => openEvents(reminderAt, []));
  assert.equal(candidates.some((e) => e.id === initial.applied.eventIds[0]), true);
  const reminder = "We granted all Pro, Max, and Team users a reset last Tuesday. You can still apply it before Oct 22.";
  const held = await post("reminder-held", reminder, rec(reminder, { kind: "reset_credit" }), reminderAt);
  assert.equal(held.saved.needsReview, true);
  assert.deepEqual(held.applied.eventIds, []);
  const fabricatedTime = await post("reminder-fabricated-time", reminder, rec(reminder, { kind: "reset_credit", statedTime: {
    precision: "exact", date: "2026-09-22", timezone: "PT", clock: "12:00", relativeHours: null, period: null, clockThrough: null, dayOffset: null,
  } }), reminderAt);
  assert.equal(fabricatedTime.saved.needsReview, true);
  assert.deepEqual(fabricatedTime.applied.eventIds, []);
  const linked = await post("reminder-linked", reminder, rec(reminder, { kind: "reset_credit", relatesTo: initial.applied.eventIds[0]! }), reminderAt);
  assert.deepEqual(linked.applied.eventIds, initial.applied.eventIds);
  assert.deepEqual(linked.applied.notify, []);
  assert.equal((await sql`SELECT id FROM monitor_events WHERE monitor_id='claude'`).length, 1);
});

test("cycle evidence survives omitted model scope and never borrows nearby ordinary increases", async () => {
  const reset = "We've reset 5-hour and weekly rate limits for all users.";
  const result = await post("cycle", reset, rec(reset, { kind: "direct_reset" }));
  const [event] = await sql`SELECT presentation FROM monitor_events WHERE monitor_id='claude' AND id=${result.applied.eventIds[0]!}`;
  assert.equal(event!.presentation.quotaScope, "five_hour+weekly");
  const card = "5-hour session limits increase 20% today. Pro users get a reset to use anytime.";
  const ordinary = await post("card-cycle", card, rec(card, { kind: "reset_credit", scope: { audienceSource: "Pro 5-hour limits", plans: ["Pro"], audienceZh: null, productsZh: null } }));
  const [credit] = await sql`SELECT presentation FROM monitor_events WHERE monitor_id='claude' AND id=${ordinary.applied.eventIds[0]!}`;
  assert.equal(credit!.presentation.quotaScope, null);
});

test("missing Article body enters review without any model request or receipt", async () => {
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url) VALUES ('claude','article','ClaudeDevs',${at},'https://x.com/i/article/2100112233','https://x.com/ClaudeDevs/status/article')`;
  const [{ n: before }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts`;
  assert.equal((await scoped(() => processPending())).processed, 1);
  const [article] = await sql`SELECT recognition,raw FROM monitor_posts WHERE monitor_id='claude' AND id='article'`;
  assert.equal(article!.recognition.needsReview, true);
  assert.match(article!.raw.sourceIncomplete, /正文/);
  assert.match(article!.recognition.sourceIssue, /正文/);
  const [{ n: after }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts`;
  assert.equal(after, before);
});
