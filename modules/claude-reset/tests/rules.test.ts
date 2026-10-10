import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { inMonitor } from "@aihot/reset-monitor/backend/context";
import { applyRecognition } from "@aihot/reset-monitor/backend/assemble";
import { resetsSnapshot, resetPage } from "@aihot/reset-monitor/backend/read";
import { monitorPostDetail } from "@aihot/reset-monitor/backend/manual-review";
import type { Proposition, Recognition } from "@aihot/reset-monitor/backend/recognize";
import { backendDefinition } from "../backend-definition.ts";
import { cloudBonus } from "./cloud-bonus.fixture.ts";
import { bonusRecognition } from "./bonus-credit.fixture.ts";

after(closeDb);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts WHERE monitor_id='claude'`;
  await sql`DELETE FROM monitor_events WHERE monitor_id='claude'`;
  await sql`DELETE FROM monitor_posts WHERE monitor_id='claude'`;
  await sql`DELETE FROM monitor_state WHERE monitor_id='claude'`;
});
const scoped = <T>(run: () => T) => inMonitor(backendDefinition, run);
let serial = 0;
async function record(plan: string, action: "announce" | "confirm", productScope: string, options: { source?: string; proposition?: Partial<Proposition> } = {}) {
  const id = `claude-rule-${++serial}`;
  const source = options.source ?? `We ${action === "confirm" ? "have reset" : "will reset"} Claude usage for ${plan} ${productScope}.`;
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url)
    VALUES ('claude',${id},'ClaudeDevs',now(),${source},${`https://x.com/ClaudeDevs/status/${id}`})`;
  const recognition: Recognition = {
    relevant: true, translationZh: `${plan} ${productScope}`, contextZh: [], outage: null, needsReview: false,
    model: "test", promptVersion: "test", receiptId: 0, propositions: [{
      kind: "direct_reset", kindExplicit: true, action, real: true, count: 1, relatesTo: null, excerpt: source, excerptZh: `${plan} ${productScope}`,
      statedTime: null, timeInferred: false, expectedLanding: { earliestPacific: "2026-10-10 16:30", latestPacific: "2026-10-10 21:30", note: "不得采用模型预测" },
      scope: { audienceSource: plan, plans: [plan], audienceZh: `${plan} 用户`, productsZh: `Claude ${productScope}` },
      ...options.proposition,
    }],
  };
  return scoped(() => applyRecognition(id, recognition));
}

test("Claude Max confirmation cannot complete a Pro announcement and preserves quota scope", async () => {
  const pro = await record("Pro", "announce", "five-hour limits");
  const max = await record("Max", "confirm", "weekly limits");
  assert.equal(pro.eventIds.length, 1);
  assert.equal(max.eventIds.length, 1);
  assert.notEqual(pro.eventIds[0], max.eventIds[0]);
  const snapshot = await scoped(() => resetsSnapshot());
  const proEvent = snapshot.events.find((event) => event.id === pro.eventIds[0])!;
  const maxEvent = snapshot.events.find((event) => event.id === max.eventIds[0])!;
  assert.equal(proEvent.status, "announced");
  assert.equal(proEvent.scope, "Pro");
  assert.equal(proEvent.schedule, null);
  assert.equal(proEvent.estimate, null);
  assert.equal(proEvent.presentation!.productsZh, "Claude five-hour limits");
  assert.equal(maxEvent.status, "confirmed");
  assert.equal(maxEvent.scope, "Max");
  assert.equal(maxEvent.presentation!.productsZh, "Claude weekly limits");
  assert.equal(maxEvent.confirmationBasis, "source_post");
});

test("same-plan weekly confirmation cannot complete a five-hour announcement", async () => {
  const fiveHour = await record("Max", "announce", "five-hour limits");
  const weekly = await record("Max", "confirm", "weekly limits");
  assert.equal(fiveHour.eventIds.length, 1);
  assert.equal(weekly.eventIds.length, 1);
  assert.notEqual(fiveHour.eventIds[0], weekly.eventIds[0]);
  const snapshot = await scoped(() => resetsSnapshot());
  assert.equal(snapshot.events.find((event) => event.id === fiveHour.eventIds[0])!.status, "announced");
  assert.equal(snapshot.events.find((event) => event.id === weekly.eventIds[0])!.status, "confirmed");
});

test("one Claude post preserves separate five-hour and weekly reset announcements", async () => {
  const id = `claude-rule-${++serial}`;
  const excerpts = ["We will reset Claude usage for Max five-hour limits", "we will reset Claude usage for Max weekly limits"];
  const source = excerpts.join(", and ") + ".";
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url)
    VALUES ('claude',${id},'ClaudeDevs',now(),${source},${`https://x.com/ClaudeDevs/status/${id}`})`;
  const rec: Recognition = { relevant: true, translationZh: "分别重置五小时及周额度", contextZh: [], outage: null, needsReview: false,
    model: "test", promptVersion: "test", receiptId: 0, propositions: excerpts.map((excerpt, index) => ({
      kind: "direct_reset", kindExplicit: true, action: "announce", real: true, count: 1, relatesTo: null,
      excerpt, excerptZh: index ? "重置周额度" : "重置五小时额度", statedTime: null, timeInferred: false, expectedLanding: null,
      scope: { audienceSource: "Max", plans: ["Max"], audienceZh: "Max 用户", productsZh: index ? "Claude 周额度" : "Claude 五小时额度" },
    })) };
  const applied = await scoped(() => applyRecognition(id, rec));
  assert.equal(applied.eventIds.length, 2);
  const events = (await scoped(() => resetsSnapshot())).events;
  assert.deepEqual(events.map((event) => event.presentation!.productsZh).sort(), ["Claude 五小时额度", "Claude 周额度"].sort());
  assert.ok(events.every((event) => event.status === "announced"));
});

test("Claude announcements discard inferred durations and clocks without literal timezone evidence", async () => {
  const soon = await record("Max", "announce", "five-hour limits", {
    source: "We will reset Claude usage for Max soon.",
    proposition: { timeInferred: true, statedTime: { precision: "deadline", relativeHours: 2, period: null, clock: null, clockThrough: null, dayOffset: null } },
  });
  const fabricatedZone = await record("Pro", "announce", "weekly limits", {
    source: "We will reset Claude usage for Pro at 18:00.",
    proposition: { statedTime: { precision: "exact", timezone: "PT", relativeHours: null, period: null, clock: "18:00", clockThrough: null, dayOffset: null } },
  });
  const vague = await record("Team", "announce", "weekly limits", {
    source: "We will reset Claude usage for Team in a few hours.",
    proposition: { timeInferred: false, statedTime: { precision: "deadline", relativeHours: 2, period: null, clock: null, clockThrough: null, dayOffset: null } },
  });
  const snapshot = await scoped(() => resetsSnapshot());
  for (const result of [soon, fabricatedZone, vague]) {
    assert.equal(result.eventIds.length, 1);
    const event = snapshot.events.find((event) => event.id === result.eventIds[0])!;
    assert.equal(event.schedule, null);
    assert.equal(event.estimate, null);
    assert.equal(event.status, "announced");
  }
});

test("policy and uncertain claims do not become Claude reset events", async () => {
  for (const [index, source, role] of [
    [1, "Claude five-hour limits reset automatically every five hours.", "policy"],
    [2, "We may increase usage limits soon.", "uncertain"],
    [3, "API credit grants explain this compensation.", "explanation"],
  ] as const) {
    const id = `claude-non-event-${index}`;
    await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url)
      VALUES ('claude',${id},'ClaudeDevs',now(),${source},${`https://x.com/ClaudeDevs/status/${id}`})`;
    const rec: Recognition = { relevant: true, translationZh: source, contextZh: [], outage: null, needsReview: false,
      model: "test", promptVersion: "test", receiptId: 0, propositions: [{
        kind: "direct_reset", kindExplicit: false, action: "announce", role, real: false, count: 1, relatesTo: null,
        excerpt: source, excerptZh: source, statedTime: null, timeInferred: false, expectedLanding: null,
        scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: "Claude" },
      }] };
    assert.deepEqual(await scoped(() => applyRecognition(id, rec)), { eventIds: [], notify: [] });
  }
});

test("explicit Claude source time survives a short action quote and never implies completion", async () => {
  const result = await record("Max", "announce", "weekly limits", {
    source: "We will reset Claude usage for Max weekly limits. Scheduled at 18:00 UTC on 2026-10-10.",
    proposition: { excerpt: "We will reset Claude usage for Max weekly limits", statedTime: {
      precision: "exact", timezone: "UTC", date: "2026-10-10", relativeHours: null,
      period: null, clock: "18:00", clockThrough: null, dayOffset: null,
    } },
  });
  const event = (await scoped(() => resetsSnapshot(Date.parse("2026-10-13T00:00:00Z")))).events.find((item) => item.id === result.eventIds[0])!;
  assert.equal(event.schedule!.from, "2026-10-11T02:00:00.000+08:00");
  assert.equal(event.estimate, null);
  assert.equal(event.presentation!.status, "expired_unconfirmed");
  assert.equal(event.status, "announced");
});

async function applySample(text: string, recognition: Recognition, id = `claude-rule-${++serial}`) {
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,raw)
    VALUES ('claude',${id},'ClaudeDevs',${new Date(cloudBonus.publishedAt)},${text},${`https://x.com/ClaudeDevs/status/${id}`},
      ${sql.json({ context: cloudBonus.context })})`;
  const result = await scoped(() => applyRecognition(id, structuredClone(recognition)));
  const [post] = await sql`SELECT recognition,activity,outage FROM monitor_posts WHERE monitor_id='claude' AND id=${id}`;
  return { id, result, post: post! };
}

test("actual cloud-session bonus-credit false positive is unrelated and retains raw model evidence", async () => {
  const { result, post, id } = await applySample(cloudBonus.text, cloudBonus.recognition, cloudBonus.id);
  assert.deepEqual(result, { eventIds: [], notify: [] });
  assert.equal(post.recognition.relevant, false);
  assert.equal(post.recognition.needsReview, false);
  assert.equal(post.recognition.propositions[0].real, false);
  assert.equal(post.activity, null);
  assert.deepEqual(post.recognition.modelResult, cloudBonus.recognition);
  assert.deepEqual(post.recognition.exclusions, [{ index: 0, reason: "云会话赠额是独立消费池，不是额度重置或可兑换的重置次数" }]);
  const detail = await scoped(() => monitorPostDetail(id));
  assert.equal(detail!.draft.decision, "unrelated");
  assert.deepEqual(detail!.draft.propositions, []);
  assert.deepEqual((await scoped(() => resetsSnapshot())).events, []);
});

test("API-credit grants cannot become reset cards even when the model claims confirmation", async () => {
  const text = "We have granted $100 in monthly Claude Platform API credits to Max subscribers.";
  const rec = structuredClone(cloudBonus.recognition) as Recognition;
  rec.propositions[0] = { ...rec.propositions[0]!, action: "confirm", excerpt: text, statedTime: null, timeSourceId: null };
  const { result, post } = await applySample(text, rec);
  assert.deepEqual(result, { eventIds: [], notify: [] });
  assert.equal(post.recognition.relevant, false);
  assert.equal(post.recognition.needsReview, false);
  assert.equal(post.activity, null);
  assert.match(post.recognition.exclusions[0].reason, /API 赠金/);
});

test("quoting only the bonus-pool spending or expiry sentence cannot become a reset confirmation", async () => {
  const rec = structuredClone(cloudBonus.recognition) as Recognition;
  rec.propositions[0] = { ...rec.propositions[0]!, action: "confirm", excerpt: cloudBonus.text.split("\n\n")[1]!, statedTime: null, timeSourceId: null };
  const { result, post } = await applySample(cloudBonus.text, rec);
  assert.deepEqual(result, { eventIds: [], notify: [] });
  assert.equal(post.recognition.relevant, false);
  assert.equal(post.recognition.needsReview, false);
  assert.equal(post.activity, null);
  assert.match(post.recognition.exclusions[0].reason, /云会话赠额/);
});

test("a genuine redeemable reset credit remains a reset-card event", async () => {
  const text = "We have granted one reset credit that Max users can redeem to reset their weekly Claude usage.";
  const rec = structuredClone(cloudBonus.recognition) as Recognition;
  rec.propositions[0] = { ...rec.propositions[0]!, action: "confirm", excerpt: text, statedTime: null, timeSourceId: null };
  const { result, post } = await applySample(text, rec);
  assert.equal(result.eventIds.length, 1);
  assert.equal(post.recognition.exclusions, undefined);
  const event = (await scoped(() => resetsSnapshot())).events[0]!;
  assert.equal(event.type, "reset_credit");
  assert.equal(event.status, "confirmed");
});

test("a mixed bonus-credit and reset post preserves reset numbering and duplicate references", async () => {
  const reset = "We will reset Claude weekly usage for Max.";
  const rec = structuredClone(cloudBonus.recognition) as Recognition;
  const proposition: Proposition = { ...rec.propositions[0]!, kind: "direct_reset", excerpt: reset, excerptZh: "重置 Max 周额度",
    statedTime: null, timeSourceId: null, scope: { audienceSource: "Max weekly usage", plans: ["Max"], audienceZh: "Max 周额度", productsZh: "Claude 周额度" } };
  rec.propositions.push(proposition, { ...proposition, duplicateOf: 1 });
  const { id, result, post } = await applySample(`${cloudBonus.text}\n\n${reset}`, rec);
  assert.deepEqual(result.eventIds, [`reset-${id}-1-1`]);
  assert.equal(result.notify.length, 1);
  assert.equal(post.recognition.relevant, true);
  assert.equal(post.recognition.needsReview, false);
  assert.equal(post.recognition.propositions[2].duplicateOf, 1);
  assert.equal(post.recognition.exclusions.length, 1);
  assert.deepEqual(post.recognition.modelResult, rec);
  const detail = await scoped(() => monitorPostDetail(id));
  assert.equal(detail!.draft.decision, "events");
  assert.equal(detail!.draft.propositions.length, 1);
});

test("excluding a bonus-credit claim preserves a separate outage hint", async () => {
  const rec = { ...structuredClone(cloudBonus.recognition), outage: "outage" as const };
  const { result, post } = await applySample(cloudBonus.text, rec);
  assert.deepEqual(result, { eventIds: [], notify: [] });
  assert.equal(post.recognition.relevant, true);
  assert.equal(post.outage.kind, "outage");
  assert.equal(post.recognition.needsReview, false);
});


test("the actual cloud bonus becomes an available campaign with independent claim and expiry evidence", async () => {
  const rec = bonusRecognition();
  const { result, post, id } = await applySample(cloudBonus.text, rec, cloudBonus.id);
  assert.deepEqual(result.eventIds, [`bonus-${id}-1-1`]);
  assert.deepEqual(result.notify, [{ eventId: result.eventIds[0], action: "confirm", postId: id }]);
  assert.equal(post.recognition.needsReview, false);
  assert.deepEqual(post.recognition.modelResult, rec);
  assert.equal(post.recognition.exclusions, undefined);
  const page = await scoped(() => resetPage(Date.parse("2026-10-07T00:00:00Z")));
  const event = page.events[0]!;
  assert.equal(event.type, "bonus_credit");
  assert.equal(event.title, "奖励额度活动可领取");
  assert.equal(event.presentation!.status, "available");
  assert.deepEqual(event.presentation!.bonusCredit!.claimDeadline, {
    source: "Run /claim-credit in Claude Code by Oct 7 at 11:59pm PT.", at: null,
  });
  assert.deepEqual(event.presentation!.bonusCredit!.expiresAt, { source: "expires Nov 4", at: null });
  assert.equal(event.presentation!.bonusCredit!.amount, null);
  assert.equal(event.presentation!.bonusCredit!.claimMethod, "Run /claim-credit in Claude Code");
  assert.equal(event.schedule, null);
  assert.equal(event.estimate, null);
  assert.equal(page.current, null);
  assert.equal(page.lastLanded, null);
  assert.equal(page.stats.bonuses90, 1);
  assert.equal(page.stats.resets90, 0);
  assert.equal(page.stats.credits90, 0);
  assert.deepEqual(page.calendar.map((mark) => [mark.date, mark.milestone ?? "available"]), [["2026-10-07", "available"]]);
  const detail = await scoped(() => monitorPostDetail(id));
  assert.equal(detail!.draft.propositions[0]!.kind, "bonus_credit");
  assert.deepEqual(detail!.draft.propositions[0]!.bonusCredit, event.presentation!.bonusCredit);
});

test("bonus times reject a borrowed timezone, fabricated model instant, and fabricated amount", async () => {
  const rec = bonusRecognition();
  rec.propositions[0]!.count = 5;
  rec.propositions[0]!.statedTime = structuredClone(cloudBonus.recognition.propositions[0]!.statedTime);
  rec.propositions[0]!.expectedLanding = { earliestPacific: "2026-10-07 23:59", latestPacific: "2026-10-08 01:00", note: "不得推算" };
  rec.propositions[0]!.bonusCredit!.amount = "$100";
  rec.propositions[0]!.bonusCredit!.expiresAt = { source: "expires Nov 4", at: "2026-11-04T00:00:00Z",
    statedTime: { precision: "date", date: "2026-11-04", timezone: "PT", clock: null, relativeHours: null, period: null, clockThrough: null, dayOffset: null } };
  const { result, post } = await applySample(cloudBonus.text, rec, cloudBonus.id);
  assert.equal(result.eventIds.length, 1);
  assert.equal(post.recognition.propositions[0].count, 1);
  assert.equal(post.recognition.propositions[0].bonusCredit.amount, null);
  assert.equal(post.recognition.propositions[0].bonusCredit.expiresAt.at, null);
  assert.equal(post.recognition.propositions[0].statedTime, null);
  const event = (await scoped(() => resetsSnapshot())).events[0]!;
  assert.equal(event.schedule, null);
  assert.equal(event.estimate, null);
});

test("bonus-specific rules still reject monthly API gifts and ordinary limit increases", async () => {
  for (const source of ["We are granting monthly Claude Platform API credits for Max.", "We are doubling Claude usage limits for Max."]) {
    const rec = bonusRecognition();
    rec.propositions[0]!.excerpt = source;
    rec.propositions[0]!.bonusCredit = null;
    const { result, post } = await applySample(source, rec);
    assert.deepEqual(result, { eventIds: [], notify: [] });
    assert.equal(post.recognition.relevant, false);
    assert.equal(post.recognition.needsReview, false);
  }
});

test("one source post can expose a bonus campaign and a genuine reset as separate events", async () => {
  const reset = "We will reset Claude weekly usage for Max.";
  const rec = bonusRecognition();
  rec.propositions.push({ ...rec.propositions[0]!, bonusCredit: null, kind: "direct_reset", action: "announce", excerpt: reset, excerptZh: "重置周额度",
    scope: { audienceSource: "Max weekly usage", plans: ["Max"], audienceZh: "Max 周额度", productsZh: "Claude 周额度" } });
  const { result, post } = await applySample(`${cloudBonus.text}\n\n${reset}`, rec, cloudBonus.id);
  assert.equal(result.eventIds.length, 2);
  assert.equal(result.notify.length, 2);
  assert.equal(post.recognition.needsReview, false);
  assert.deepEqual((await scoped(() => resetsSnapshot())).events.map(e => e.type).sort(), ["bonus_credit", "direct_reset"]);
});

test("a confirmed bonus reminder and deadline change link the same campaign without duplicate grants", async () => {
  const first = await applySample(cloudBonus.text, bonusRecognition(), cloudBonus.id);
  const rec = bonusRecognition();
  rec.propositions[0]!.relatesTo = first.result.eventIds[0]!;
  const second = await applySample(cloudBonus.text, rec);
  assert.deepEqual(second.result.eventIds, first.result.eventIds);
  assert.deepEqual(second.result.notify, []);
  const deadline = "Run /claim-credit in Claude Code by Oct 9, 2026 at 11:59pm PT.";
  rec.propositions[0]!.action = "amend";
  rec.propositions[0]!.excerpt = rec.propositions[0]!.excerpt.replace("Oct 7", "Oct 9, 2026");
  rec.propositions[0]!.bonusCredit!.claimDeadline = { source: deadline, at: null, statedTime: {
    precision: "deadline", date: "2026-10-09", timezone: "PT", clock: "23:59", relativeHours: null, period: null, clockThrough: null, dayOffset: null } };
  const amended = await applySample(cloudBonus.text.replace("Run /claim-credit in Claude Code by Oct 7 at 11:59pm PT.", deadline), rec);
  assert.equal(amended.result.notify[0]!.action, "amend");
  const events = (await scoped(() => resetsSnapshot())).events;
  assert.equal(events.length, 1);
  assert.equal(events[0]!.presentation!.bonusCredit!.claimDeadline!.at, "2026-10-10T14:59:00.000+08:00");
});

test("a future bonus promise cannot become an available campaign through a false confirmation", async () => {
  const source = "We will offer a one-time bonus credit for cloud sessions soon.";
  const rec = bonusRecognition();
  rec.propositions[0] = { ...rec.propositions[0]!, excerpt: source, bonusCredit: null };
  const { result, post } = await applySample(source, rec);
  assert.deepEqual(result.eventIds, []);
  assert.equal(post.recognition.needsReview, true);
  assert.equal((await scoped(() => resetsSnapshot())).count, 0);
});

test("API gift wording in a mixed post cannot suppress an independently stated cloud bonus", async () => {
  const rec = bonusRecognition();
  const { result } = await applySample(`${cloudBonus.text}\n\nMonthly API credits are also available.`, rec, cloudBonus.id);
  assert.equal(result.eventIds.length, 1);
});
