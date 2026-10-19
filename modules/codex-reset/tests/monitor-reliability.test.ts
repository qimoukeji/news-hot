import { installModules } from "@aihot/backend/modules";
import monitorModule from "../server.ts";
installModules([monitorModule]);
// Failure cases fixed before changing the monitor: malformed model output becoming an empty result;
// failed paginated scans losing their tail or advancing the success cutoff;
// unfinished review advancing the verified watermark; stale estimates/receipt dates after corrections;
// relinking deleting evidence or leaving stale activity; amendments reaching uninformed groups;
// cross-midnight windows, a model estimate before the stated time, and a duration counted as resets;
// a passed window still shown as in progress, and "by 8pm" read as a window instead of a deadline;
// health changes missing the page version, and recent reads dropping old evidence or open events.
// Calendar failure cases: correcting an old event makes it look newest; a confirmed credit on the
// same date makes an unconfirmed direct reset count as the most recent confirmed reset.
// A quiet new day/month/year must not reopen the last event's day; explicit history must still work.
import { gate, stub, Reply } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { applyRecognition } from "../backend/assemble.ts";
import { codexResetPage, codexResetVersion, codexResetsRecent, codexResetsSnapshot, presentationStatus } from "../backend/read.ts";
import { RecognitionSchema, type Recognition, type Proposition } from "../backend/recognize.ts";
import { collectPosts, flushResetPushes, monitorTick, processPending } from "../backend/scan.ts";
import { estimateFor, resolveStatedTime, scheduleFrom } from "../backend/time.ts";
import { relinkPost, reviewReceipt, updateMonitorEvent } from "../backend/admin.ts";
import { monitorPostDetail, previewMonitorReview } from "../backend/manual-review.ts";
import { beijingDate } from "@aihot/contracts/time";
import { siteCodexResetPage } from "../backend/publication.ts";

let answer: (url: string) => unknown = () => ({ tweets: [] });
let modelAnswer: unknown = {};
const provider = await stub((_hit, req) => answer(req.url));
const model = await stub(() => ({ choices: [{ message: { content: JSON.stringify(modelAnswer) }, finish_reason: "stop" }] }));
process.env.SOCIALDATA_BASE_URL = provider.url;
process.env.SOCIALDATA_API_KEY = "test-key";
process.env.DEEPSEEK_BASE_URL = model.url;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.MONITOR_MODEL = "deepseek-flash";
config.allowPrivateNetworkFetch = true;

beforeEach(async () => {
  process.env.CODEX_RESET_PROVIDER = "socialdata";
  config.modelCallsEnabled = true;
  answer = () => ({ tweets: [] });
  await sql`DELETE FROM deliveries`;
  await sql`DELETE FROM notify_targets`;
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`INSERT INTO monitor_state(key,value) VALUES('cursor:socialdata',${sql.json({checkpointVersion:2,scannedThrough:new Date(Date.now()-3600_000).toISOString()})})`;
  await sql`DELETE FROM receipts WHERE purpose LIKE 'monitor.%'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service IN ('socialdata', 'deepseek')`;
});
after(async () => { await provider.close(); await model.close(); await stopBoss(); await closeDb(); });

let sequence = 0;
async function post(text: string, at = new Date()) {
  const id = String(9000000000000000000n + BigInt(++sequence));
  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url) VALUES (${id}, 'thsottiaux', ${at}, ${text}, ${`https://x.com/thsottiaux/status/${id}`})`;
  return id;
}
const rec = (p: Partial<Proposition> = {}): Recognition => ({
  relevant: true, translationZh: "原帖译文", contextZh: [], outage: null, needsReview: false, model: "test", promptVersion: "test", receiptId: 0,
  propositions: [{ kind: "direct_reset", kindExplicit: true, action: "announce", real: true, count: 1, relatesTo: null, excerpt: "We will reset tonight", excerptZh: "今晚重置",
    statedTime: null, timeInferred: false, expectedLanding: null, scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null }, ...p }],
});
async function announcement(at = new Date()) {
  const id = await post("We will reset tonight", at);
  const applied = await applyRecognition(id, rec());
  return { postId: id, eventId: applied.eventIds[0]! };
}
async function version(id: string) { return (await sql`SELECT updated_at FROM monitor_events WHERE id = ${id}`)[0]!.updated_at.toISOString(); }
async function state(key: string, value: unknown) { await sql`INSERT INTO monitor_state (key, value) VALUES (${key}, ${sql.json(value as never)}) ON CONFLICT (monitor_id, key) DO UPDATE SET value = EXCLUDED.value`; }

test("malformed recognition aborts and the next round preserves every claim", async () => {
  const valid = rec();
  for (const malformed of [{}, { ...valid, propositions: null }, { ...valid, needsReview: "false" },
    { ...valid, propositions: [valid.propositions[0], { ...valid.propositions[0], action: "done" }] }]) {
    assert.equal(RecognitionSchema.safeParse(malformed).success, false, "invalid semantics must not silently default to no events");
  }
  const id = await post("We will reset tonight");
  modelAnswer = {};
  await assert.rejects(processPending(), /unusable output/);
  assert.equal((await sql`SELECT processed_at FROM monitor_posts WHERE id = ${id}`)[0]!.processed_at, null);
  assert.match((await sql`SELECT raw FROM monitor_posts WHERE id = ${id}`)[0]!.raw.collectionFailure.error, /unusable output/);
  modelAnswer = valid;
  assert.deepEqual(await processPending(), { processed: 1, failed: 0 });
  assert.equal((await sql`SELECT raw FROM monitor_posts WHERE id = ${id}`)[0]!.raw.collectionFailure, undefined);
  assert.equal((await codexResetsSnapshot()).events.length, 1);
});

test("business review does not prevent the whole-round success watermark", async () => {
  const checked = "2026-09-20T00:00:00Z";
  await state("watermarks:socialdata", { lastVerifiedAt: checked });
  await state("cursor:socialdata", { checkpointVersion: 2, scannedThrough: checked });
  const id = await post("");
  await applyRecognition(id, rec()); // excerpt is in the quoted context only
  await monitorTick();
  const snap = await codexResetsSnapshot();
  assert.ok(Date.parse(snap.checkedAt!) > Date.parse(checked));
  assert.equal(snap.monitor?.status, "attention");
});

test("page failure saves previous pages and aborts before context or recognition", async () => {
  const checkpoint = { checkpointVersion: 2, scannedThrough: "2026-09-20T00:00:00.000Z" };
  await state("cursor:socialdata", checkpoint);
  let requests = 0;
  const postAt = new Date(Date.now() - 60_000).toISOString();
  answer = url => {
    requests++;
    return new URL(url, provider.url).searchParams.has("cursor") ? new Reply(503, { error: "page two failed" }) : {
      tweets: [{ id_str: "1001", tweet_created_at: postAt, full_text: "We will reset tonight", user: { screen_name: "thsottiaux" } }], next_cursor: "second",
    };
  };
  const hits = model.hits();
  await assert.rejects(monitorTick(), /503/);
  assert.equal(requests, 2);
  assert.equal(model.hits(), hits);
  assert.equal((await sql`SELECT raw FROM monitor_posts WHERE id='1001'`)[0]!.raw.contextPending, undefined);
  assert.deepEqual((await sql`SELECT value FROM monitor_state WHERE key='cursor:socialdata'`)[0]!.value, checkpoint);
});

test("recognition failure stops later posts and resumes the proven invalid request once", async () => {
  const checkpoint = { checkpointVersion: 2, scannedThrough: "2026-09-20T00:00:00.000Z" };
  await state("cursor:socialdata", checkpoint);
  await post("first ordinary post"); await post("second ordinary post");
  modelAnswer = {};
  const hits = model.hits();
  await assert.rejects(monitorTick(), /unusable output/);
  assert.equal(model.hits() - hits, 1, "a failed first post blocks later posts this round");
  assert.deepEqual((await sql`SELECT value FROM monitor_state WHERE key='cursor:socialdata'`)[0]!.value, checkpoint);
  modelAnswer = { relevant: false, translationZh: "普通发言", contextZh: [], outage: null, needsReview: false, propositions: [] };
  await monitorTick();
  assert.equal(model.hits() - hits, 3);
  assert.deepEqual((await sql`SELECT attempts FROM receipts WHERE purpose='monitor.recognize' ORDER BY id`).map(r => r.attempts), [2, 1]);
  assert.equal((await sql`SELECT count(*) AS n FROM monitor_posts WHERE processed_at IS NULL`)[0]!.n, 0);
});

test("global model uncertainty cannot block well-evidenced announcements and withdrawals", async () => {
  const id = await post("We will reset tonight");
  const uncertain = rec(); uncertain.needsReview = true;
  assert.equal((await applyRecognition(id, uncertain)).eventIds.length, 1);
  const { eventId } = await announcement();
  const withdrawal = await post("No reset tonight");
  const unsure = rec({ action: "withdraw", excerpt: "No reset tonight", relatesTo: eventId }); unsure.needsReview = true;
  assert.deepEqual((await applyRecognition(withdrawal, unsure)).eventIds, [eventId]);
  assert.equal((await codexResetsSnapshot()).count, 1);
});

test("manual schedule changes replace the old estimate; reopening clears confirmation evidence", async () => {
  const { eventId } = await announcement();
  const from = new Date(Date.now() + 72 * 3600_000).toISOString();
  await updateMonitorEvent(eventId, { patch: { schedule: { precision: "window", from, through: new Date(Date.parse(from) + 3600_000).toISOString() } }, reason: "correct time", version: await version(eventId) }, "test");
  let event = (await codexResetsSnapshot()).events[0]!;
  assert.ok(Date.parse(event.estimate!.from!) >= Date.parse(from), "old estimate must not hide the corrected schedule");
  await reviewReceipt(eventId, { occurredOn: "2026-09-30", reason: "receipt", version: await version(eventId) }, "test");
  await updateMonitorEvent(eventId, { patch: { status: "announced" }, reason: "retract mistaken receipt", version: await version(eventId) }, "test");
  event = (await codexResetsSnapshot()).events[0]!;
  assert.equal(event.confirmationBasis, null);
  assert.equal(event.occurredOn, null);
  assert.equal(event.confirmedAt, null);
  assert.ok(event.estimate);
});

test("an explicitly unknown receipt day clears the old day without replacing an official confirmation", async () => {
  const { eventId } = await announcement();
  await reviewReceipt(eventId, { occurredOn: "2026-09-30", reason: "receipt", version: await version(eventId) }, "test");
  await updateMonitorEvent(eventId, { patch: { occurredOn: null }, reason: "date uncertain", version: await version(eventId) }, "test");
  assert.equal((await codexResetsSnapshot()).events[0]!.occurredOn, null);
  const confirmation = await post("Reset has landed");
  await applyRecognition(confirmation, rec({ action: "confirm", excerpt: "Reset has landed", relatesTo: eventId }));
  await assert.rejects(reviewReceipt(eventId, { occurredOn: "2026-09-30", reason: "account date", version: await version(eventId) }, "test"), /已有确认/);
  assert.equal((await codexResetsSnapshot()).events[0]!.confirmationBasis, "source_post");
});

test("moving a post keeps public activity consistent, and moving to itself preserves the link", async () => {
  const one = await announcement(); const two = await announcement();
  let detail = (await monitorPostDetail(one.postId))!;
  let preview = (await previewMonitorReview(one.postId, { draft: detail.draft, version: detail.version }))!;
  await relinkPost({ postId: one.postId, fromEventId: one.eventId, toEventId: one.eventId, reason: "same event", version: detail.version, previewToken: preview.previewToken }, "test");
  assert.equal((await sql`SELECT count(*) AS n FROM monitor_event_posts WHERE post_id = ${one.postId}`)[0]!.n, 1);
  detail = (await monitorPostDetail(one.postId))!;
  detail.draft.propositions = detail.draft.propositions.map(p => ({ ...p, targetEventId: two.eventId }));
  preview = (await previewMonitorReview(one.postId, { draft: detail.draft, version: detail.version }))!;
  await relinkPost({ postId: one.postId, fromEventId: one.eventId, toEventId: two.eventId, reason: "fix association", version: detail.version, previewToken: preview.previewToken }, "test");
  const snap = await codexResetsSnapshot();
  assert.deepEqual(snap.activities.find((p) => p.id === one.postId)!.eventIds, [two.eventId]);
});

test("a duration is not a stated number of resets", async () => {
  const id = await post("We will reset in two hours");
  await applyRecognition(id, rec({ excerpt: "We will reset in two hours", count: 2 }));
  assert.equal((await codexResetsSnapshot()).count, 1);
});

test("overnight windows stay ordered and model estimates cannot start before the stated time", () => {
  const schedule = scheduleFrom({ precision: "window", date: "2026-10-01", from: "23:00", through: "01:00" });
  assert.equal(Date.parse(schedule.through) - Date.parse(schedule.from), 2 * 3600_000);
  const exact = scheduleFrom({ precision: "exact", date: "2026-10-01", from: "18:00", through: null });
  const estimate = estimateFor({ schedule: exact, announcedAt: new Date("2026-10-01T20:00:00Z"), model: { earliestPacific: "2026-10-01 14:00", latestPacific: "2026-10-01 19:00", note: "too early" } });
  assert.ok(Date.parse(estimate.from) >= Date.parse(exact.from));
});

test("a passed window outranks an earlier 'in progress'", () => {
  const window = { from: "2026-09-25T02:00:00Z", through: "2026-09-25T04:00:00Z", basis: "source", label: "", reason: "" };
  const e = { status: "announced" as const, estimate: window, schedule: null, presentation: { inProgress: true } as never };
  assert.equal(presentationStatus(e, Date.parse("2026-09-25T03:00:00Z")), "in_progress");
  assert.equal(presentationStatus(e, Date.parse("2026-09-29T03:00:00Z")), "likely_completed");
});

test("'by 8pm' stays a deadline and the estimate cannot extend it", () => {
  const postAt = new Date("2026-09-25T20:00:00Z"); // 13:00 Pacific
  const stated = resolveStatedTime({ precision: "deadline", relativeHours: null, period: null, clock: "20:00", clockThrough: null, dayOffset: null }, postAt)!;
  assert.equal(stated.precision, "deadline");
  const schedule = scheduleFrom(stated);
  assert.match(schedule.label, /前$/);
  const estimate = estimateFor({ schedule, announcedAt: postAt });
  assert.equal(estimate.from, postAt.toISOString(), "from the announcement");
  assert.equal(estimate.through, schedule.through, "the author's deadline is retained");
});

test("only a group that received the announcement receives its amendment, with the source text", async () => {
  const { postId, eventId } = await announcement();
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled) VALUES ('main', 'content', 'log', true), ('mirror', 'content', 'log', true)`;
  const dedupeKey = `codex:${postId}:${eventId}:announce`;
  await sql`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status) VALUES ('main', 'codex_reset', ${eventId}, ${dedupeKey}, 'sent'), ('mirror', 'codex_reset', ${eventId}, ${dedupeKey}, 'skipped')`;
  const id = await post("No reset tonight");
  await applyRecognition(id, rec({ action: "withdraw", excerpt: "No reset tonight", relatesTo: eventId }));
  await flushResetPushes();
  const deliveries = await sql`SELECT target_key, payload FROM deliveries WHERE dedupe_key LIKE ${`codex:${id}:%`}`;
  assert.deepEqual(deliveries.map((d) => d.target_key), ["main"]);
  assert.match(JSON.stringify(deliveries[0]!.payload), /原帖译文/, "withdrawal still includes its post after the event leaves the public snapshot");
});

test("monitor health invalidates the page version independently of events", async () => {
  const now = Date.now();
  await state("watermarks:socialdata", { lastVerifiedAt: new Date(now).toISOString() });
  const healthy = await codexResetVersion(now);
  await post("not processed yet");
  const delayed = await codexResetVersion(now);
  assert.notEqual(delayed.version, healthy.version);
  assert.equal(delayed.version, (await codexResetPage(now)).version);
});

test("recent snapshot keeps old citations for recent events and unfinished events, with unchanged shape", async () => {
  const now = Date.now();
  const old = await announcement(new Date(now - 30 * 86400_000));
  await reviewReceipt(old.eventId, { occurredOn: null, reason: "late receipt", version: await version(old.eventId) }, "test");
  const open = await announcement(new Date(now - 20 * 86400_000));
  await sql`UPDATE monitor_events SET estimate = NULL, schedule = NULL WHERE id = ${open.eventId}`;
  const recent = await codexResetsRecent(now + 1000);
  assert.equal(recent.events.length, 2);
  assert.equal(recent.activities.length, 0);
  assert.ok(recent.events.every((e) => e.posts.length === 1));
  const full = await codexResetsSnapshot(now + 1000);
  assert.deepEqual(recent.events, full.events);
});

test("correcting an older reset does not make it the most recent completed reset", async () => {
  const now = Date.now();
  const older = await announcement(new Date(now - 7 * 86400_000));
  const newer = await announcement(new Date(now - 86400_000));
  for (const [eventId, days] of [[older.eventId, 7], [newer.eventId, 1]] as const) {
    await reviewReceipt(eventId, { occurredOn: beijingDate(now - days * 86400_000), reason: "verified day", version: await version(eventId) }, "test");
  }
  await updateMonitorEvent(older.eventId, { patch: { audienceZh: "更正历史适用范围" }, reason: "historical correction", version: await version(older.eventId) }, "test");
  assert.equal((await codexResetPage(now)).lastLanded?.id, newer.eventId);
});

test("the monitor calendar follows Beijing today across month and year boundaries without losing history", async () => {
  for (const date of ["2026-09-30", "2026-12-31"]) {
    const at = Date.parse(`${date}T23:59:59+08:00`);
    const last = await announcement(new Date(at - 3600_000));
    await reviewReceipt(last.eventId, { occurredOn: date, reason: "verified day", version: await version(last.eventId) }, "test");
    const before = siteCodexResetPage(await codexResetPage(at));
    assert.equal(before.selectedDate, date);
    assert.ok(before.events.some((e) => e.id === last.eventId));
    const nextPage = await codexResetPage(at + 1000);
    const next = siteCodexResetPage(nextPage);
    assert.equal(next.selectedDate, beijingDate(at + 1000), "a day with no events still opens today");
    assert.deepEqual(next.events, []);
    assert.equal(next.lastLanded?.id, last.eventId, "the last completed event remains available above the calendar");
    const history = siteCodexResetPage(nextPage, date);
    assert.equal(history.selectedDate, date);
    assert.ok(history.events.some((e) => e.id === last.eventId), "history links keep the requested day");
    assert.deepEqual(history.calendar, next.calendar);
  }
});

test("a confirmed card does not promote a same-day estimated reset in the last reset statistic", async () => {
  const now = Date.now();
  const known = await announcement(new Date(now - 7 * 86400_000));
  await reviewReceipt(known.eventId, { occurredOn: beijingDate(now - 7 * 86400_000), reason: "verified reset", version: await version(known.eventId) }, "test");
  const estimated = await announcement(new Date(now - 3 * 86400_000));
  const day = (await codexResetPage(now)).calendar.find((m) => m.eventId === estimated.eventId)!.date;
  const card = await announcement(new Date(now - 3 * 86400_000));
  await updateMonitorEvent(card.eventId, { patch: { type: "reset_credit" }, reason: "card", version: await version(card.eventId) }, "test");
  await reviewReceipt(card.eventId, { occurredOn: day, reason: "verified card", version: await version(card.eventId) }, "test");
  assert.equal((await codexResetPage(now)).stats.lastResetDate, beijingDate(now - 7 * 86400_000));
});
