import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { evidenceVersion, projectPublicV2, properName, type PublicV2Input, type PublicV2EventRow } from "../backend/public-v2.ts";
import { resetSnapshotSchema, eventTimeSchema, announcementSchema, type ReviewedEvent, type EventTime } from "../public-v2.ts";
import { isApiOwned } from "@aihot/contracts/http-policy";
import { resolveSourceTime, resolveBonusTimes, resolveEventExpression } from "../backend/public-v2-time.ts";

const now = Date.parse("2026-10-14T12:00:00Z");
function fixture(type: PublicV2EventRow["type"] = "direct_reset"): PublicV2Input {
  return { events: [{ id: "event-1", type, status: "confirmed", title: "", scope: "", label: "", display_label: "", schedule: null, estimate: null,
    presentation: {}, confirmed_at: "2026-10-12T10:00:00Z", occurred_on: null, confirmation_basis: "source_post", withdrawn: false,
    created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-12T10:00:00Z" }],
    posts: [{ id: "post-1", author: "thsottiaux", published_at: "2026-10-10T10:00:00Z", text: "Synthetic source: usage was reset.", url: "https://x.com/thsottiaux/status/post-1", translation: null, context: [], recognition: null }],
    links: [{ event_id: "event-1", post_id: "post-1", stage: "confirmed", action: "confirm", text: "", original_text: "Synthetic source: usage was reset." }] };
}
function review(input: PublicV2Input, time: EventTime = { kind: "instant", at: "2026-10-12T00:00:00Z" }): ReviewedEvent {
  const row = input.events[0]!;
  return { evidenceVersion: evidenceVersion(row, input), evidence: [{ postId: "post-1", excerpt: input.posts[0]!.text }],
    status: row.type === "bonus_credit" ? "available" : "completed", publishedAt: "2026-10-10T10:00:00Z", title: properName("Synthetic event"), summary: null, details: null,
    time, announcement: null, scope: { type: "unknown", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null }, bonusCredit: null };
}

test("three configured platforms return strict v2 snapshots through API-owned paths", () => {
  for (const definition of [codex, claude, grok]) {
    const data = projectPublicV2(fixture(), definition, now);
    assert.equal(data.platform, definition.publicV2!.platform);
    assert.equal(data.schemaVersion, 2);
    assert.ok(isApiOwned(definition.publicApiPath.replace("/v1/", "/v2/")));
    assert.equal(resetSnapshotSchema.safeParse(data).success, true);
    assert.deepEqual(Object.keys(data.events[0]!.title).sort(), ["en", "es", "ja", "ko", "ru", "zh", "zh-Hant"].sort());
  }
});

test("unverifiable confirmation timestamps and inferred schedules leave the time unknown", () => {
  const input = fixture();
  input.links[0]!.action = "progress";
  input.events[0]!.schedule = { precision: "exact", from: "2026-10-11T12:00:00Z", through: "2026-10-11T12:00:00Z" };
  input.events[0]!.presentation = { timeInferred: true };
  const data = projectPublicV2(input, codex, now);
  assert.deepEqual(data.events[0]!.time, { kind: "unknown" });
  assert.equal(data.statistics.resetsLast30Days, null);
  assert.equal(data.history.total, 1);
  assert.equal(data.history.range, null);
  assert.equal(data.calendar.range, null);
});

test("passing time never completes a pending reset or expires an available bonus", () => {
  const input = fixture();
  input.events[0]!.status = "announced";
  input.events[0]!.presentation = { inProgress: true, bonusCredit: { expiresAt: { at: "2020-01-01T00:00:00Z" } } };
  assert.equal(projectPublicV2(input, codex, now).events[0]!.status, "in_progress");
  input.events[0]!.type = "bonus_credit";
  input.events[0]!.status = "confirmed";
  assert.equal(projectPublicV2(input, codex, now).events[0]!.status, "available");
});

test("account receipt review never produces a public completed status", () => {
  const input = fixture(); input.events[0]!.confirmation_basis = "receipt_review";
  const event = projectPublicV2(input, codex, now).events[0]!;
  assert.equal(event.status, "announced");
  assert.equal(event.time.kind, "unknown");
});

test("official confirmation publication supplies a time node separately from first publication", () => {
  for (const type of ["direct_reset", "reset_credit", "bonus_credit"] as const) {
    const input = fixture(type);
    input.links[0]!.action = "announce";
    input.posts.push({ ...input.posts[0]!, id: "first-confirm", published_at: "2026-10-12T10:00:00Z" },
      { ...input.posts[0]!, id: "later-confirm", published_at: "2026-10-13T10:00:00Z" },
      { ...input.posts[0]!, id: "later-reminder", published_at: "2026-10-14T10:00:00Z" });
    input.links.push({ ...input.links[0]!, post_id: "later-reminder", action: "progress" },
      { ...input.links[0]!, post_id: "later-confirm", action: "confirm" },
      { ...input.links[0]!, post_id: "first-confirm", action: "confirm" });
    const data = projectPublicV2(input, codex, now), event = data.events[0]!;
    assert.deepEqual(event.time, { kind: "instant", at: "2026-10-12T10:00:00.000Z" });
    assert.equal(event.publishedAt, "2026-10-10T10:00:00.000Z");
    assert.equal(event.details, null);
    assert.equal(data.statistics[type === "direct_reset" ? "resetsLast30Days" : type === "reset_credit" ? "cardsLast30Days" : "bonusesLast30Days"], 1);
    assert.deepEqual(data.calendar.range, { from: "2026-10-11", through: "2026-10-13" });
  }
});

test("a recorded occurrence date takes precedence over official confirmation publication", () => {
  const input = fixture(); input.events[0]!.occurred_on = "2026-10-08";
  const event = projectPublicV2(input, codex, now).events[0]!;
  assert.deepEqual(event.time, { kind: "date", date: "2026-10-08", timeZone: "Asia/Shanghai" });
  assert.equal(event.details, null);
});

test("reviewed exact times provide calendar padding and count the correct event kind", () => {
  for (const type of ["direct_reset", "reset_credit", "bonus_credit"] as const) {
    const input = fixture(type); input.events[0]!.presentation = { publicV2: review(input) };
    const data = projectPublicV2(input, codex, now);
    assert.deepEqual(data.calendar.range, { from: "2026-10-11", through: "2026-10-13" });
    assert.equal(data.statistics[type === "direct_reset" ? "resetsLast30Days" : type === "reset_credit" ? "cardsLast30Days" : "bonusesLast30Days"], 1);
  }
});

test("date-only events keep their original source date across extreme user zones", () => {
  const input = fixture(); input.events[0]!.presentation = { publicV2: review(input, { kind: "date", date: "2026-10-12", timeZone: "America/Los_Angeles" }) };
  const data = projectPublicV2(input, codex, now);
  assert.deepEqual(data.calendar.range, { from: "2026-10-12", through: "2026-10-12" });
  assert.equal(data.events[0]!.time.kind, "date");
});

test("fact changes invalidate reviewed text, scope and times but preserve first publication", () => {
  const input = fixture(); const stored = review(input);
  stored.publishedAt = "2026-10-09T00:00:00Z"; stored.summary = properName("Reviewed summary"); stored.scope.productCodes = ["codex"];
  input.events[0]!.presentation = { publicV2: stored };
  input.posts[0]!.text = "Corrected source text";
  const event = projectPublicV2(input, codex, now).events[0]!;
  assert.equal(event.summary, null); assert.deepEqual(event.scope.productCodes, []);
  assert.deepEqual(event.time, { kind: "instant", at: "2026-10-10T10:00:00.000Z" });
  assert.equal(event.details, null);
  assert.equal(event.publishedAt, stored.publishedAt);
  assert.notEqual(event.title.en, stored.title.en);
});

test("latest references and history use publication rather than update order", () => {
  const input = fixture();
  input.events.push({ ...input.events[0]!, id: "older", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-14T10:00:00Z" });
  input.events.push({ ...input.events[0]!, id: "card", type: "reset_credit", created_at: "2026-10-13T10:00:00Z" });
  input.events.push({ ...input.events[0]!, id: "withdrawn", withdrawn: true });
  const data = projectPublicV2(input, codex, now);
  assert.equal(data.overview.latestDirectResetEventId, "event-1");
  assert.equal(data.overview.latestCompletedResetEventId, "event-1");
  assert.deepEqual(data.history.eventIds, ["card", "event-1", "older"]);
  assert.equal(data.history.total, 3);
});

test("statistics use Beijing calendar days and do not count cards as resets", () => {
  const input = fixture("reset_credit");
  input.events[0]!.presentation = { publicV2: review(input, { kind: "instant", at: "2026-09-14T16:00:00Z" }) };
  const data = projectPublicV2(input, codex, now);
  assert.equal(data.statistics.cardsLast30Days, 1);
  assert.equal(data.statistics.resetsLast30Days, 0);
  input.events[0]!.presentation.publicV2.time.at = "2026-09-14T15:59:59Z";
  assert.equal(projectPublicV2(input, codex, now).statistics.cardsLast30Days, 0);
});

test("forecast requires three exact completions and never rolls forward with the clock", () => {
  const input = fixture(); const base = input.events[0]!;
  input.events = [0, 1, 2].map(index => ({ ...structuredClone(base), id: `event-${index}`, created_at: `2026-10-${String(10 + index).padStart(2, "0")}T00:00:00Z` }));
  for (const [index, row] of input.events.entries()) row.presentation = { publicV2: { ...review({ ...input, events: [row] }, { kind: "instant", at: `2026-10-${String(4 + index * 4).padStart(2, "0")}T00:00:00Z` }), evidenceVersion: evidenceVersion(row, input) } };
  const data = projectPublicV2(input, codex, now);
  assert.deepEqual(data.statistics.typicalInterval, { value: 4, unit: "day", sampleCount: 2 });
  assert.deepEqual(data.overview.statisticalForecast, { time: { kind: "instant", at: "2026-10-16T00:00:00.000Z" }, expiresAt: "2026-10-16T00:00:00.000Z" });
  assert.deepEqual(projectPublicV2(input, codex, now + 200 * 86_400_000).overview.statisticalForecast, data.overview.statisticalForecast);
  input.events.pop();
  assert.equal(projectPublicV2(input, codex, now).overview.statisticalForecast, null);
});

test("official publication nodes contribute to interval statistics and the fixed forecast", () => {
  const input: PublicV2Input = { events: [], posts: [], links: [] };
  for (const day of [4, 8, 12]) {
    const base = fixture(), id = `event-${day}`, postId = `post-${day}`;
    input.events.push({ ...base.events[0]!, id });
    input.posts.push({ ...base.posts[0]!, id: postId, published_at: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z` });
    input.links.push({ ...base.links[0]!, event_id: id, post_id: postId });
  }
  const snapshot = projectPublicV2(input, codex, now);
  assert.deepEqual(snapshot.statistics.typicalInterval, { value: 4, unit: "day", sampleCount: 2 });
  assert.equal(snapshot.statistics.resetsLast30Days, 3);
  assert.deepEqual(snapshot.overview.statisticalForecast, { time: { kind: "instant", at: "2026-10-16T00:00:00.000Z" }, expiresAt: "2026-10-16T00:00:00.000Z" });
  assert.equal(snapshot.events.every(event => event.details === null), true);
});

test("bonus milestones remain separate from event opening and require matching times", () => {
  const input = fixture("bonus_credit"); const stored = review(input);
  stored.bonusCredit = { amount: null, eligibility: null, claimMethod: null, usageTerms: null,
    claimDeadline: { kind: "deadline", at: "2026-10-15T00:00:00Z" }, expiresAt: { kind: "date", date: "2026-11-01", timeZone: "UTC" } };
  input.events[0]!.presentation = { publicV2: stored };
  const data = projectPublicV2(input, codex, now);
  assert.deepEqual(data.calendar.marks.map(mark => mark.kind), ["event", "claim_deadline", "expiry"]);
  const wrong = structuredClone(data); wrong.calendar.marks[1]!.time = { kind: "instant", at: "2026-10-15T00:00:00Z" };
  assert.equal(resetSnapshotSchema.safeParse(wrong).success, false);
});

test("saved bonus wording completes years and Pacific DST without adding provenance to public text", () => {
  const input = fixture("bonus_credit");
  input.posts[0]!.published_at = "2026-09-23T21:23:41Z";
  input.posts[0]!.text = "Claim by Oct 7. Credit expires Nov 4.";
  input.posts.push({ ...input.posts[0]!, id: "reminder", published_at: "2026-10-06T18:42:44Z",
    text: "Run /claim-credit by Oct 7 at 11:59pm PT. Credit expires Nov 4." });
  input.links.push({ ...input.links[0]!, post_id: "reminder", action: "progress" });
  const stored = review(input, { kind: "unknown" }); stored.details = properName("Cloud sessions use the bonus first.");
  input.events[0]!.presentation = { publicV2: stored };
  const result = resolveBonusTimes(input.events[0]!, input, null);
  assert.deepEqual(result.bonusCredit!.claimDeadline, { kind: "deadline", at: "2026-10-08T06:59:00Z" });
  assert.deepEqual(result.bonusCredit!.expiresAt, { kind: "date", date: "2026-11-04", timeZone: "America/Los_Angeles" });
  assert.equal(result.resolutions[0]!.yearBasis, "activity");
  assert.equal(result.resolutions[1]!.zoneBasis, "post");
  const snapshot = projectPublicV2(input, claude, now);
  assert.deepEqual(snapshot.events[0]!.details, stored.details);
  assert.deepEqual(snapshot.calendar.marks.map(mark => mark.kind), ["event", "claim_deadline", "expiry"]);
  assert.deepEqual(snapshot.calendar.range, { from: "2026-09-22", through: "2026-11-04" });
  assert.deepEqual(projectPublicV2(input, claude, now + 730 * 86_400_000).events[0]!.bonusCredit, snapshot.events[0]!.bonusCredit);
  assert.equal("timeResolutions" in snapshot.events[0]!, false);
});

test("source time completion handles explicit years, cross-year dates and missing zones independently", () => {
  const context = { activityAnchor: "2026-12-29T12:00:00Z", postText: "", activityText: "", deadline: true };
  const resolve = (text: string) => resolveSourceTime(text, context);
  assert.deepEqual(resolve("by Jan 4")!.time, { kind: "date", date: "2027-01-04", timeZone: "UTC" });
  assert.deepEqual(resolve("by Jan 4, 2026")!.time, { kind: "date", date: "2026-01-04", timeZone: "UTC" });
  assert.deepEqual(resolve("2027-01-04 at 8pm PST")!.time, { kind: "deadline", at: "2027-01-05T04:00:00Z" });
  assert.deepEqual(resolve("Jan 4 at 8pm PT")!.time, { kind: "deadline", at: "2027-01-05T04:00:00Z" });
  assert.equal(resolve("Feb 30"), null);
  assert.equal(resolve("Jan 4 at 25:00 UTC"), null);
  assert.equal(resolve("sometime next month"), null);
  assert.equal(resolve("Mar 14, 2027 at 2:30am PT"), null);
  assert.deepEqual(resolve("Jan 4 at 12am PST")!.time, { kind: "deadline", at: "2027-01-04T08:00:00Z" });
  assert.deepEqual(resolve("Jan 4 at 12pm PST")!.time, { kind: "deadline", at: "2027-01-04T20:00:00Z" });
  assert.equal(resolve("Jan 4")!.zoneBasis, "publication");
});

test("bonus parsing uses linked originals, respects reviewed times and never invents receipt or expiry state", () => {
  const input = fixture("bonus_credit");
  input.posts.push({ ...input.posts[0]!, id: "unrelated", text: "Claim by Oct 7 at 11:59pm PT. Credit expires Nov 4." });
  input.posts[0]!.translation = "Claim by Oct 7 at 11:59pm PT.";
  assert.equal(resolveBonusTimes(input.events[0]!, input, null).bonusCredit, null);
  input.posts[0]!.text = "Claim by Oct 7 at 11:59pm PT. Credit expires Nov 4.";
  const bonus = { amount: null, eligibility: null, claimMethod: null, usageTerms: null,
    claimDeadline: { kind: "date" as const, date: "2027-10-09", timeZone: "UTC" }, expiresAt: null };
  assert.deepEqual(resolveBonusTimes(input.events[0]!, input, bonus).bonusCredit!.claimDeadline, bonus.claimDeadline);
  assert.equal(projectPublicV2(input, claude, now + 400 * 86_400_000).events[0]!.status, "available");
});

test("event timing completes relative, clock-only and weekday nodes without borrowing reward deadlines", () => {
  const post = fixture().posts[0]!; post.published_at = "2026-10-14T18:00:00Z";
  post.text = "We will reset tomorrow at 8pm PT.";
  assert.deepEqual(resolveEventExpression(post.text, post, true, post.text), { kind: "instant", at: "2026-10-16T03:00:00Z" });
  assert.deepEqual(resolveEventExpression("We will reset at 8am PT.", post, true, post.text), { kind: "instant", at: "2026-10-15T15:00:00Z" });
  assert.deepEqual(resolveEventExpression("We reset at 8pm PT.", post, false, post.text), { kind: "instant", at: "2026-10-14T03:00:00Z" });
  assert.deepEqual(resolveEventExpression("Reset on Friday.", post, true, post.text), { kind: "date", date: "2026-10-16", timeZone: "America/Los_Angeles" });
  assert.deepEqual(resolveEventExpression("We will reset in the next 30 minutes.", post, true, post.text), { kind: "deadline", at: "2026-10-14T18:30:00.000Z" });
  assert.deepEqual(resolveEventExpression("We reset about an hour ago.", post, false, post.text), { kind: "unknown" });
  assert.deepEqual(resolveEventExpression("Claim by Oct 17 at 11:59pm PT.", post, true, post.text), { kind: "unknown" });
});

test("bonus closure requires explicit linked statements and can be reopened without clock-derived changes", () => {
  const input = fixture("bonus_credit");
  input.posts[0]!.text = "The bonus credit has expired.";
  assert.equal(projectPublicV2(input, claude, now).events[0]!.status, "expired");
  input.posts[0]!.text = "The claim window is closed.";
  assert.equal(projectPublicV2(input, claude, now).events[0]!.status, "claim_closed");
  input.posts.push({ ...input.posts[0]!, id: "reopened", text: "The claim window has reopened.", published_at: "2026-10-11T10:00:00Z" });
  input.links.push({ ...input.links[0]!, post_id: "reopened", action: "amend" });
  assert.equal(projectPublicV2(input, claude, now).events[0]!.status, "available");
  assert.equal(projectPublicV2(input, claude, now + 365 * 86_400_000).events[0]!.status, "available");
});

test("conditional, personal, negated, questioned and future bonus statements never close the campaign", () => {
  for (const text of [
    "If your credit has expired, your normal plan limits apply.",
    "When the bonus credit has expired, normal plan limits apply.",
    "Your bonus credit has expired.", "My bonus credit has expired.",
    "The bonus credit has not expired.", "The claim window isn't closed.",
    "The bonus credit has expired?", "The claim window is closed?",
    "The bonus credit may have expired.", "The claim window will be closed tomorrow.",
  ]) {
    const input = fixture("bonus_credit");
    input.posts[0]!.text = "One-time bonus credit is now available.";
    input.posts.push({ ...input.posts[0]!, id: "explanation", published_at: "2026-10-11T10:00:00Z", text });
    input.links.push({ ...input.links[0]!, post_id: "explanation", action: "amend" });
    assert.equal(projectPublicV2(input, claude, now).events[0]!.status, "available", text);
  }
  for (const [text, expected] of [
    ["The bonus credit has expired.", "expired"],
    ["The bonus credit has expired on May 5.", "expired"],
    ["We have closed the claim window.", "claim_closed"],
  ] as const) {
    const input = fixture("bonus_credit"); input.posts[0]!.text = text;
    assert.equal(projectPublicV2(input, claude, now).events[0]!.status, expected);
  }
});

test("short reminders preserve known milestone precision while explicit changes replace it", () => {
  const input = fixture("bonus_credit");
  input.posts[0]!.published_at = "2026-09-23T21:23:41Z";
  input.posts[0]!.text = "Claim by Oct 7 at 11:59pm PT. Credit expires Nov 4 at 8pm PT.";
  const follow = { ...input.posts[0]!, id: "reminder", published_at: "2026-10-06T18:42:44Z", text: "You can still claim by Oct 7. Credit expires Nov 4." };
  input.posts.push(follow); input.links.push({ ...input.links[0]!, post_id: follow.id, action: "amend" });
  const resolve = () => resolveBonusTimes(input.events[0]!, input, null);
  assert.deepEqual(resolve().bonusCredit!.claimDeadline, { kind: "deadline", at: "2026-10-08T06:59:00Z" });
  assert.deepEqual(resolve().bonusCredit!.expiresAt, { kind: "instant", at: "2026-11-05T04:00:00Z" });
  assert.equal(resolve().resolutions[0]!.postId, "post-1");
  follow.text = "Claim by Oct 8. Credit expires Nov 5.";
  assert.deepEqual(resolve().bonusCredit!.claimDeadline, { kind: "date", date: "2026-10-08", timeZone: "America/Los_Angeles" });
  follow.text = "Claim by Oct 7 at 10pm PT.";
  assert.deepEqual(resolve().bonusCredit!.claimDeadline, { kind: "deadline", at: "2026-10-08T05:00:00Z" });
  follow.text = "Claim by Oct 7; the deadline is now date-only.";
  assert.deepEqual(resolve().bonusCredit!.claimDeadline, { kind: "date", date: "2026-10-07", timeZone: "America/Los_Angeles" });
});

test("explicit zones and offsets retain their full meaning and invalid zones never fall back to UTC", () => {
  const context = { activityAnchor: "2026-09-23T21:23:41Z", postText: "", activityText: "", deadline: true };
  const resolve = (text: string) => resolveSourceTime(text, { ...context, postText: text, activityText: text });
  for (const [text, at] of [
    ["Oct 7 at 11:59pm ET", "2026-10-08T03:59:00Z"],
    ["Nov 4 at 11:59pm ET", "2026-11-05T04:59:00Z"],
    ["Oct 7 at 11:59pm EST", "2026-10-08T04:59:00Z"],
    ["Oct 7 at 11:59pm EDT", "2026-10-08T03:59:00Z"],
    ["Oct 7 at 23:59 UTC+08:00", "2026-10-07T15:59:00Z"],
    ["Oct 7 at 23:59 UTC+0530", "2026-10-07T18:29:00Z"],
    ["Oct 7 at 23:59 GMT-03:30", "2026-10-08T03:29:00Z"],
    ["Oct 7 at 11:59pm America/New_York", "2026-10-08T03:59:00Z"],
    ["Oct 7 at 11:59pm Europe/London", "2026-10-07T22:59:00Z"],
  ]) assert.deepEqual(resolve(text!)!.time, { kind: "deadline", at }, text);
  for (const text of ["Oct 7 at 11:59pm XYZ", "Oct 7 at 11:59pm CST", "Oct 7 at 11:59pm America/Invalid", "Oct 7 at 23:59 UTC+99:00", "Oct 7 at 11:59pm ET PT"]) assert.equal(resolve(text), null, text);
  assert.deepEqual(resolve("Oct 7 UTC+08:00")!.time, { kind: "date", date: "2026-10-07", timeZone: "Etc/GMT-8" });
  const text = "Reset next Monday at 5pm XYZ.";
  const post = { ...fixture().posts[0]!, text };
  assert.deepEqual(resolveEventExpression(text, post, true, text), { kind: "unknown" });
});

test("weekday qualifiers preserve next, last and this across same-day, week and year boundaries", () => {
  const post = { ...fixture().posts[0]!, published_at: "2026-10-12T12:00:00Z" };
  const resolve = (text: string) => resolveEventExpression(text, { ...post, text }, true, text);
  assert.deepEqual(resolve("Reset next Monday at 5pm PT."), { kind: "instant", at: "2026-10-20T00:00:00Z" });
  assert.deepEqual(resolve("Reset last Monday at 5pm PT."), { kind: "instant", at: "2026-10-06T00:00:00Z" });
  assert.deepEqual(resolve("Reset this Monday at 5pm PT."), { kind: "instant", at: "2026-10-13T00:00:00Z" });
  assert.deepEqual(resolve("Reset next Monday."), { kind: "date", date: "2026-10-19", timeZone: "UTC" });
  post.published_at = "2026-12-31T12:00:00Z";
  assert.deepEqual(resolve("Reset next Monday at 5pm ET."), { kind: "instant", at: "2027-01-04T22:00:00Z" });
});

test("time windows preserve both endpoints, distinct zones, midnight, year and daylight-saving boundaries", () => {
  const context = { activityAnchor: "2026-09-23T21:23:41Z", postText: "", activityText: "", deadline: false };
  for (const [text, from, through] of [
    ["Oct 14 at 10am–12pm PT", "2026-10-14T17:00:00Z", "2026-10-14T19:00:00Z"],
    ["Oct 14 from 10am to 12pm PT", "2026-10-14T17:00:00Z", "2026-10-14T19:00:00Z"],
    ["Oct 14 between 10am and 12pm PT", "2026-10-14T17:00:00Z", "2026-10-14T19:00:00Z"],
    ["Oct 14 at 10–12pm PT", "2026-10-14T17:00:00Z", "2026-10-14T19:00:00Z"],
    ["Oct 14 at 11pm–1am PT", "2026-10-15T06:00:00Z", "2026-10-15T08:00:00Z"],
    ["Dec 31 at 11pm–Jan 1 at 1am PT", "2027-01-01T07:00:00Z", "2027-01-01T09:00:00Z"],
    ["Nov 1 at 12am–3am PT", "2026-11-01T07:00:00Z", "2026-11-01T11:00:00Z"],
    ["Oct 14 at 10am PT–2pm ET", "2026-10-14T17:00:00Z", "2026-10-14T18:00:00Z"],
  ]) assert.deepEqual(resolveSourceTime(text!, { ...context, postText: text!, activityText: text! })!.time, { kind: "range", from, through }, text);
  for (const text of ["Oct 14 at 10am–noon PT", "Oct 14–Oct 16", "Mar 14, 2027 at 1am–2:30am PT"]) assert.equal(resolveSourceTime(text, { ...context, postText: text, activityText: text }), null, text);
  const post = { ...fixture().posts[0]!, published_at: "2026-10-14T16:00:00Z", text: "Reset from 10am to 12pm PT." };
  assert.deepEqual(resolveEventExpression(post.text, post, true, post.text), { kind: "range", from: "2026-10-14T17:00:00Z", through: "2026-10-14T19:00:00Z" });
});

test("completed ranges retain their calendar mark and stay out of exact interval and forecast samples", () => {
  const input = fixture();
  const window: EventTime = { kind: "range", from: "2026-10-12T17:00:00Z", through: "2026-10-12T19:00:00Z" };
  input.events[0]!.presentation = { publicV2: review(input, window) };
  const snapshot = projectPublicV2(input, codex, now);
  assert.deepEqual(snapshot.events[0]!.time, window); assert.deepEqual(snapshot.calendar.marks[0]!.time, window);
  assert.equal(snapshot.statistics.typicalInterval, null); assert.equal(snapshot.overview.statisticalForecast, null);
  assert.equal(snapshot.statistics.resetsLast30Days, 1);
});

test("strict contracts reject bad URLs, duplicate or dangling references, and insufficient calendar ranges", () => {
  const input = fixture(); input.events[0]!.presentation = { publicV2: review(input) };
  const data = projectPublicV2(input, codex, now);
  for (const mutate of [
    (value: typeof data) => { value.sources[0]!.url = "https://user:password@example.com"; },
    (value: typeof data) => { value.events[0]!.sourceIds.push("missing"); },
    (value: typeof data) => { value.history.total++; },
    (value: typeof data) => { value.calendar.range!.from = "2026-10-12"; },
    (value: typeof data) => { value.events[0]!.scope.planCodes.push("missing"); },
    (value: typeof data) => { value.events[0]!.sourceIds.push(value.events[0]!.sourceIds[0]!); },
  ]) { const changed = structuredClone(data); mutate(changed); assert.equal(resetSnapshotSchema.safeParse(changed).success, false); }
});

test("source dates require IANA zones, real calendar dates and the actual local day boundary", () => {
  assert.equal(eventTimeSchema.safeParse({ kind: "date", date: "2026-02-30", timeZone: "UTC" }).success, false);
  assert.equal(eventTimeSchema.safeParse({ kind: "date", date: "2026-10-12", timeZone: "+08:00" }).success, false);
  assert.equal(announcementSchema.safeParse({ time: { kind: "date", date: "2026-03-08", timeZone: "America/Los_Angeles" }, displayUntil: "2026-03-08T08:00:00Z" }).success, true);
  assert.equal(announcementSchema.safeParse({ time: { kind: "date", date: "2026-03-08", timeZone: "America/Los_Angeles" }, displayUntil: "2026-03-08T07:00:00Z" }).success, false);
});
