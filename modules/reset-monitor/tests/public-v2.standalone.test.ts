import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { evidenceVersion, projectPublicV2, properName, type PublicV2Input, type PublicV2EventRow } from "../backend/public-v2.ts";
import { resetSnapshotSchema, eventTimeSchema, publicTimeSchema, serializeEventTime, type ReviewedEvent, type EventTime } from "../public-v2.ts";
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
    status: row.type === "bonus_credit" ? "available" : "completed", publishedAt: "2026-10-10T10:00:00Z", title: properName("Synthetic event"), summary: null,
    time: time.kind === 'unknown' ? new Date(input.posts[0]!.published_at).toISOString() : serializeEventTime(time), timeBasis: time.kind === 'unknown' ? 'latest_update' : 'source', scope: { type: "unknown", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null }, bonusCredit: null };
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

test("saved offset instants and intervals publish in UTC without losing date or fractional precision", () => {
  for (const [storedTime, expected] of [
    ["2026-10-12T08:00:00+08:00", "2026-10-12T00:00:00Z"],
    ["2026-10-11T17:00:00.123456789-07:00", "2026-10-12T00:00:00.123456789Z"],
    ["2026-10-12T08:00:00+08:00/2026-10-11T18:00:00-07:00", "2026-10-12T00:00:00Z/2026-10-12T01:00:00Z"],
    ["2026-10-12", "2026-10-12"],
  ]) {
    const input = fixture();
    input.events[0]!.presentation = { publicV2: { ...review(input), time: storedTime } };
    const before = structuredClone(input);
    const data = projectPublicV2(input, codex, now);
    assert.equal(data.events[0]!.time, expected);
    assert.equal(data.resetTime, expected);
    assert.deepEqual(input, before);
    input.events[0]!.presentation!.publicV2.status = "announced";
    assert.equal(projectPublicV2(input, codex, now).announcedResetTime, expected);
  }
  assert.equal(serializeEventTime({ kind: "instant", at: "2026-10-12T08:00:00+08:00" }), "2026-10-12T00:00:00Z");
  assert.equal(serializeEventTime({ kind: "range", from: "2026-10-12T08:00:00+08:00", through: "2026-10-12T09:00:00+08:00" }), "2026-10-12T00:00:00Z/2026-10-12T01:00:00Z");
});

test("sources keep every configured account even without events", () => {
  for (const definition of [codex, claude, grok]) {
    const snapshot = projectPublicV2({ events: [], posts: [], links: [] }, definition, now);
    assert.deepEqual(snapshot.sources.map(source => source.id), definition.authors.map(author => `x-account:${author.handle.toLowerCase()}`));
    assert.deepEqual(snapshot.sources.map(source => source.url), definition.authors.map(author => `https://x.com/${author.handle}`));
  }
});

test("updates retain each saved source URL while account homepages remain deduplicated", () => {
  const input = fixture();
  input.posts[0]!.author = codex.authors[0]!.handle.toUpperCase();
  input.posts[0]!.url = "https://archive.example/news/@author?post=original";
  input.links[0]!.action = "announce";
  input.posts.push({ ...input.posts[0]!, id: "older-progress", author: "RetiredAuthor", published_at: "2026-10-09T10:00:00Z" },
    { ...input.posts[0]!, id: "later-announce", published_at: "2026-10-11T10:00:00Z", url: "https://example.com/later" },
    { ...input.posts[0]!, id: "later-confirm", published_at: "2026-10-12T10:00:00Z" });
  input.links.push({ ...input.links[0]!, post_id: "older-progress", action: "progress" },
    { ...input.links[0]!, post_id: "later-announce" }, { ...input.links[0]!, post_id: "later-confirm", action: "confirm" });
  const snapshot = projectPublicV2(input, codex, now);
  const sourceId = `x-account:${codex.authors[0]!.handle.toLowerCase()}`;
  assert.deepEqual(snapshot.events[0]!.updates.find(update => update.id === "post-1")!.source, { sourceId, url: input.posts[0]!.url });
  assert.deepEqual(snapshot.events[0]!.updates.map(update => update.id), ["later-confirm", "later-announce", "post-1", "older-progress"]);
  assert.equal("primarySource" in snapshot.events[0]!, false);
  assert.equal("sourceIds" in snapshot.events[0]!, false);
  assert.equal(snapshot.sources.length, codex.authors.length + 1);
  assert.deepEqual(snapshot.sources.find(source => source.id === sourceId)!.name, properName(codex.authors[0]!.name));
  assert.equal(snapshot.sources.find(source => source.id === "x-account:retiredauthor")!.url, "https://x.com/retiredauthor");
  assert.equal(snapshot.sources.some(source => source.id.startsWith("x-post:")), false);
  input.posts.reverse(); input.links.reverse();
  assert.deepEqual(projectPublicV2(input, codex, now).events[0]!.updates, snapshot.events[0]!.updates);
});

test("updates use latest publication first and ascending IDs for equal timestamps", () => {
  const input = fixture();
  input.posts.push({ ...input.posts[0]!, id: "a-post", url: "https://example.com/a-post" });
  input.links.push({ ...input.links[0]!, post_id: "a-post" });
  assert.deepEqual(projectPublicV2(input, codex, now).events[0]!.updates.map(update => update.id), ["a-post", "post-1"]);
  input.posts[1]!.published_at = "2026-10-11T10:00:00Z";
  assert.equal(projectPublicV2(input, codex, now).events[0]!.updates[0]!.source.url, "https://example.com/a-post");
});

test("missing business updates and invalid source URLs fail instead of substituting a homepage", () => {
  const input = fixture(); input.links = [];
  assert.throws(() => projectPublicV2(input, codex, now), /requires a business update/);
  input.links = [...fixture().links, { ...fixture().links[0]!, post_id: "missing" }];
  assert.throws(() => projectPublicV2(input, codex, now), /references a missing post/);
  input.links = fixture().links; input.posts[0]!.url = "";
  assert.throws(() => projectPublicV2(input, codex, now));
});

test("an unrecognized progress time uses its post publication instead of database edits or inferred schedules", () => {
  const input = fixture();
  input.links[0]!.action = "progress";
  input.events[0]!.schedule = { precision: "exact", from: "2026-10-11T12:00:00Z", through: "2026-10-11T12:00:00Z" };
  input.events[0]!.presentation = { timeInferred: true };
  const data = projectPublicV2(input, codex, now);
  assert.deepEqual(data.events[0]!.time, serializeEventTime({ kind: "instant", at: "2026-10-10T10:00:00.000Z" }));
  assert.equal(data.statistics.resetsLast30Days, 1);
  assert.equal(data.events.length, 1);
  assert.equal(data.resetTime, data.events[0]!.time);
});

test("passing time never completes a pending reset or expires an available bonus", () => {
  const input = fixture();
  input.events[0]!.status = "announced";
  input.events[0]!.presentation = { inProgress: true, bonusCredit: { expiresAt: { at: "2020-01-01T00:00:00Z" } } };
  const progress = projectPublicV2(input, codex, now);
  assert.equal(progress.events[0]!.status, "in_progress");
  assert.equal(progress.resetTime, progress.events[0]!.time);
  assert.equal(progress.announcedResetTime, null);
  input.events[0]!.type = "bonus_credit";
  input.events[0]!.status = "confirmed";
  assert.equal(projectPublicV2(input, codex, now).events[0]!.status, "available");
});

test("account receipt review never produces a public completed status", () => {
  const input = fixture(); input.events[0]!.confirmation_basis = "receipt_review";
  const event = projectPublicV2(input, codex, now).events[0]!;
  assert.equal(event.status, "announced");
  assert.deepEqual(event.time, serializeEventTime({ kind: "instant", at: "2026-10-10T10:00:00.000Z" }));
});

test("missing timing uses the latest accepted business update while first publication stays fixed", () => {
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
    assert.deepEqual(event.time, serializeEventTime({ kind: "instant", at: "2026-10-14T10:00:00.000Z" }));
    assert.equal(event.publishedAt, "2026-10-10T10:00:00.000Z");
    assert.equal("details" in event, false);
    assert.equal(data.statistics[type === "direct_reset" ? "resetsLast30Days" : type === "reset_credit" ? "cardsLast30Days" : "bonusesLast30Days"], 1);
    assert.equal(data.resetTime, event.time);
  }
});

test("a reset's final repair update provides its default scalar time without changing identity", () => {
  const input = fixture();
  input.posts[0]!.published_at = "2026-10-02T02:14:51Z";
  input.links[0]!.action = "announce";
  for (const [id, at, action] of [
    ["confirmation", "2026-10-02T21:18:48Z", "confirm"],
    ["missing-users", "2026-10-03T04:01:28Z", "progress"],
    ["repair", "2026-10-03T04:26:28Z", "amend"],
    ["related-context", "2026-10-04T12:00:00Z", null],
  ] as const) {
    input.posts.push({ ...input.posts[0]!, id, published_at: at, url: `https://example.test/updates/${id}` });
    input.links.push({ ...input.links[0]!, post_id: id, action });
  }
  input.posts.push({ ...input.posts[0]!, id: "unlinked-post", published_at: "2026-10-15T12:00:00Z" });
  const stored = review(input, { kind: "instant", at: "2026-10-02T02:14:51.000Z" });
  stored.publishedAt = "2026-10-02T02:14:51Z"; stored.timeBasis = "latest_update";
  stored.updateSummaries = input.links.filter(link => link.action).map(link => ({ postId: link.post_id, summary: properName(`Business update ${link.post_id}`) }));
  stored.evidenceVersion = evidenceVersion(input.events[0]!, input);
  input.events[0]!.presentation = { publicV2: stored };
  input.events[0]!.updated_at = "2026-10-15T12:00:00Z";
  const before = structuredClone(input);
  const snapshot = projectPublicV2(input, codex, now), event = snapshot.events[0]!;
  assert.deepEqual(event.time, serializeEventTime({ kind: "instant", at: "2026-10-03T04:26:28.000Z" }));
  assert.equal(event.publishedAt, stored.publishedAt);
  assert.equal("announcement" in event, false);
  assert.deepEqual(event.updates.map(update => update.id), ["repair", "missing-users", "confirmation", "post-1"]);
  for (const update of event.updates) {
    const post = input.posts.find(post => post.id === update.id)!;
    assert.equal(update.source.url, post.url);
    assert.equal(Date.parse(update.publishedAt), new Date(post.published_at).getTime());
    assert.deepEqual(update.summary, properName(`Business update ${update.id}`));
  }
  assert.equal(snapshot.statistics.resetsLast30Days, 1);
  assert.deepEqual(snapshot.events.map(row => row.id), ["event-1"]);
  assert.equal(event.status, "completed");
  assert.equal("timeBasis" in event, false);
  assert.deepEqual(input, before);
  stored.timeBasis = "source";
  assert.deepEqual(projectPublicV2(input, codex, now).events[0]!.time, stored.time, "an actual source time equal to primary publication stays explicit");
  stored.timeBasis = "latest_update";
  assert.deepEqual(projectPublicV2(input, codex, now).events[0]!.time, event.time);
});

test("pending promises use the single event time and never imply completion", () => {
  const input = fixture(); input.events[0]!.status = "announced";
  const planned: EventTime = { kind: "deadline", at: "2026-10-11T12:00:00Z" };
  const stored = review(input, planned); stored.status = "announced";
  input.events[0]!.presentation = { publicV2: stored };
  const event = projectPublicV2(input, codex, now).events[0]!;
  assert.equal(event.time, "2026-10-11T12:00:00Z");
  assert.equal("announcement" in event, false);
  assert.equal(event.status, "announced");
});

test("a recorded occurrence date takes precedence over primary publication even with an unknown reviewed time", () => {
  const input = fixture(); input.events[0]!.occurred_on = "2026-10-08";
  input.events[0]!.presentation = { publicV2: review(input, { kind: "unknown" }) };
  const event = projectPublicV2(input, codex, now).events[0]!;
  assert.deepEqual(event.time, serializeEventTime({ kind: "date", date: "2026-10-08", timeZone: "Asia/Shanghai" }));
  assert.equal("details" in event, false);
});

test("audience notes use fixed translations for all and paid users while selected-user conditions remain specific", () => {
  for (const type of ["unknown", "all_users", "paid_users", "selected_users"] as const) {
    const input = fixture(), stored = review(input);
    stored.scope = { type, productCodes: ["codex"], planCodes: ["plus"], quotaWindowCodes: [], note: properName("Synthetic eligibility condition") };
    input.events[0]!.presentation = { publicV2: stored };
    const before = structuredClone(input);
    const scope = projectPublicV2(input, codex, now).events[0]!.scope;
    const note = type === "selected_users" ? stored.scope.note : type === "paid_users"
      ? { en: "Paid users", zh: "付费用户", "zh-Hant": "付費使用者", ja: "有料ユーザー", ko: "유료 사용자", ru: "Платные пользователи", es: "Usuarios de pago" }
      : { en: "All users", zh: "所有用户", "zh-Hant": "所有使用者", ja: "すべてのユーザー", ko: "모든 사용자", ru: "Все пользователи", es: "Todos los usuarios" };
    assert.deepEqual(scope, { ...stored.scope, type: type === "unknown" ? "all_users" : type, note });
    assert.deepEqual(input, before, "public defaults must not rewrite stored source or reviewed facts");
  }
  const fallback = projectPublicV2(fixture(), codex, now).events[0]!.scope;
  assert.equal(fallback.type, "all_users");
  assert.equal(fallback.note!.zh, "所有用户");
  assert.equal(Object.keys(fallback.note!).length, 7);
});

test("selected users cannot publish without complete specific eligibility notes", () => {
  const input = fixture(), stored = review(input);
  stored.scope.type = "selected_users";
  input.events[0]!.presentation = { publicV2: stored };
  assert.throws(() => projectPublicV2(input, codex, now), /specific scope note/);
  stored.scope.note = properName("Synthetic eligible users");
  delete stored.scope.note.ja;
  assert.throws(() => projectPublicV2(input, codex, now), /specific scope note/);
  stored.scope.note.ja = " ";
  assert.throws(() => projectPublicV2(input, codex, now), /Text must not be blank/);
});

test("Codex and Claude catalog monthly quota without adding it to event scope or the Grok catalog", () => {
  for (const definition of [codex, claude]) {
    const snapshot = projectPublicV2(fixture(), definition, now);
    assert.deepEqual(snapshot.catalog.quotaWindows.map(entry => entry.code), ["five-hour", "weekly", "monthly"]);
    const monthly = snapshot.catalog.quotaWindows.find(entry => entry.code === "monthly")!;
    assert.equal(monthly.name.zh, "月额度");
    assert.equal(Object.keys(monthly.name).length, 7);
    assert.deepEqual(snapshot.events[0]!.scope.quotaWindowCodes, []);
    const input = fixture(), stored = review(input);
    stored.scope.quotaWindowCodes = ["monthly"];
    input.events[0]!.presentation = { publicV2: stored };
    assert.deepEqual(projectPublicV2(input, definition, now).events[0]!.scope.quotaWindowCodes, ["monthly"]);
  }
  assert.deepEqual(projectPublicV2(fixture(), grok, now).catalog.quotaWindows.map(entry => entry.code), ["five-hour", "weekly"]);
});

test("every platform and event kind has a time without inventing completion, announcements or bonus milestones", () => {
  for (const definition of [codex, claude, grok]) for (const type of ["direct_reset", "reset_credit", "bonus_credit"] as const) {
    const input = fixture(type), stored = review(input, { kind: "unknown" });
    input.events[0]!.status = "announced"; stored.status = "announced";
    input.events[0]!.created_at = "2026-10-14T10:00:00Z";
    input.events[0]!.presentation = { publicV2: { ...stored, evidenceVersion: evidenceVersion(input.events[0]!, input) } };
    const snapshot = projectPublicV2(input, definition, now), event = snapshot.events[0]!;
    assert.deepEqual(event.time, serializeEventTime({ kind: "instant", at: "2026-10-10T10:00:00.000Z" }));
    assert.equal(event.publishedAt, stored.publishedAt);
    assert.equal(event.status, "announced"); assert.equal("announcement" in event, false); assert.equal(event.bonusCredit, null);
    assert.equal(snapshot.statistics.resetsLast30Days, 0); assert.equal(snapshot.statistics.cardsLast30Days, 0); assert.equal(snapshot.statistics.bonusesLast30Days, 0);
    assert.equal(snapshot.announcedResetTime, event.time);
    assert.equal(snapshot.resetTime, null);
  }
});

test("reviewed exact times provide the latest reset time and count the correct event kind", () => {
  for (const type of ["direct_reset", "reset_credit", "bonus_credit"] as const) {
    const input = fixture(type); input.events[0]!.presentation = { publicV2: review(input) };
    const data = projectPublicV2(input, codex, now);
    assert.equal(data.resetTime, "2026-10-12T00:00:00Z");
    assert.equal(data.statistics[type === "direct_reset" ? "resetsLast30Days" : type === "reset_credit" ? "cardsLast30Days" : "bonusesLast30Days"], 1);
  }
});

test("date-only events keep their original source date across extreme user zones", () => {
  const input = fixture(); input.events[0]!.presentation = { publicV2: review(input, { kind: "date", date: "2026-10-12", timeZone: "America/Los_Angeles" }) };
  const data = projectPublicV2(input, codex, now);
  assert.equal(data.resetTime, "2026-10-12");
  assert.equal(data.events[0]!.time, "2026-10-12");
});

test("fact changes invalidate reviewed text, scope and times but preserve first publication", () => {
  const input = fixture(); const stored = review(input);
  stored.publishedAt = "2026-10-09T00:00:00Z"; stored.summary = properName("Reviewed summary"); stored.scope.productCodes = ["codex"];
  input.events[0]!.presentation = { publicV2: stored };
  input.posts[0]!.text = "Corrected source text";
  const event = projectPublicV2(input, codex, now).events[0]!;
  assert.equal(event.summary, null); assert.deepEqual(event.scope.productCodes, []);
  assert.deepEqual(event.time, serializeEventTime({ kind: "instant", at: "2026-10-10T10:00:00.000Z" }));
  assert.equal("details" in event, false);
  assert.equal(event.publishedAt, stored.publishedAt);
  assert.notEqual(event.title.en, stored.title.en);
});

test("withdrawn events do not participate in latest time selection", () => {
  const input = fixture();
  input.events.push({ ...input.events[0]!, id: "older", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-14T10:00:00Z" });
  input.events.push({ ...input.events[0]!, id: "card", type: "reset_credit", created_at: "2026-10-13T10:00:00Z" });
  input.events.push({ ...input.events[0]!, id: "withdrawn", withdrawn: true });
  input.links.push(...["older", "card"].map(event_id => ({ ...input.links[0]!, event_id })));
  const data = projectPublicV2(input, codex, now);
  assert.deepEqual(data.events.map(event => event.id), ["card", "event-1", "older"]);
  assert.equal(data.resetTime, data.events[0]!.time);
  assert.equal(data.announcedResetTime, null);
});

test("events sort by event time descending and use ascending IDs for equivalent instants", () => {
  const input = fixture(), base = input.events[0]!;
  input.events = [
    { ...base, id: "a-new-announcement", created_at: "2026-10-13T10:00:00Z" },
    { ...base, id: "b-latest-event", created_at: "2026-10-09T10:00:00Z" },
    { ...base, id: "c-card", type: "reset_credit", created_at: "2026-10-14T10:00:00Z" },
    { ...base, id: "d-equivalent-instant", created_at: "2026-10-08T10:00:00Z" },
  ];
  input.links = input.events.map(row => ({ ...fixture().links[0]!, event_id: row.id }));
  const times: EventTime[] = [
    { kind: "date", date: "2026-10-12", timeZone: "Asia/Shanghai" },
    { kind: "instant", at: "2026-10-15T00:00:00Z" },
    { kind: "range", from: "2026-10-14T00:00:00Z", through: "2026-10-19T00:00:00Z" },
    { kind: "instant", at: "2026-10-15T08:00:00+08:00" },
  ];
  input.events.forEach((row, index) => {
    row.presentation = { publicV2: { ...review({ ...input, events: [row] }, times[index]!),
      publishedAt: row.created_at, evidenceVersion: evidenceVersion(row, input) } };
  });
  input.events.reverse(); input.links.reverse();
  const snapshot = projectPublicV2(input, codex, now);
  const expected = ["b-latest-event", "d-equivalent-instant", "c-card", "a-new-announcement"];
  assert.deepEqual(snapshot.events.map(event => event.id), expected);
  assert.equal(snapshot.resetTime, "2026-10-15T00:00:00Z");
  assert.equal(snapshot.announcedResetTime, null);
});

test("latest event time selects every event kind and produces mutually exclusive status times", () => {
  for (const type of ["direct_reset", "reset_credit", "bonus_credit"] as const) {
    for (const announced of [false, true]) {
      const input = fixture(), older = input.events[0]!;
      const latest = { ...structuredClone(older), id: "latest", type, status: announced ? "announced" as const : "confirmed" as const };
      input.events.push(latest);
      input.links.push({ ...input.links[0]!, event_id: latest.id });
      older.presentation = { publicV2: { ...review(input), evidenceVersion: evidenceVersion(older, input) } };
      const stored = review({ ...input, events: [latest] }, { kind: "instant", at: "2026-10-16T01:00:00Z" });
      if (announced) stored.status = "announced";
      stored.evidenceVersion = evidenceVersion(latest, input); latest.presentation = { publicV2: stored };
      const snapshot = projectPublicV2(input, codex, now);
      assert.equal(snapshot.events[0]!.id, "latest");
      assert.equal(snapshot.announcedResetTime, announced ? stored.time : null);
      assert.equal(snapshot.resetTime, announced ? null : stored.time);
    }
  }
  const empty = projectPublicV2({ events: [], posts: [], links: [] }, codex, now);
  assert.equal(empty.predictedResetTime, null); assert.equal(empty.announcedResetTime, null); assert.equal(empty.resetTime, null);
});

test("statistics use Beijing calendar days and do not count cards as resets", () => {
  const input = fixture("reset_credit");
  input.events[0]!.presentation = { publicV2: review(input, { kind: "instant", at: "2026-09-14T16:00:00Z" }) };
  const data = projectPublicV2(input, codex, now);
  assert.equal(data.statistics.cardsLast30Days, 1);
  assert.equal(data.statistics.resetsLast30Days, 0);
  input.events[0]!.presentation.publicV2.time = "2026-09-14T15:59:59Z";
  assert.equal(projectPublicV2(input, codex, now).statistics.cardsLast30Days, 0);
});

test("forecast requires three exact completions and expired predictions use tomorrow in Beijing", () => {
  const input = fixture(); const base = input.events[0]!;
  input.events = [0, 1, 2].map(index => ({ ...structuredClone(base), id: `event-${index}`, created_at: `2026-10-${String(10 + index).padStart(2, "0")}T00:00:00Z` }));
  input.links = input.events.map(row => ({ ...fixture().links[0]!, event_id: row.id }));
  for (const [index, row] of input.events.entries()) row.presentation = { publicV2: { ...review({ ...input, events: [row] }, { kind: "instant", at: `2026-10-${String(4 + index * 4).padStart(2, "0")}T00:00:00Z` }), evidenceVersion: evidenceVersion(row, input) } };
  const data = projectPublicV2(input, codex, now);
  assert.deepEqual(data.statistics.typicalInterval, { value: 4, unit: "day", sampleCount: 2 });
  assert.equal(data.predictedResetTime, "2026-10-16T00:00:00.000Z");
  for (const [at, expected] of [
    ["2026-10-16T00:00:00Z", "2026-10-17"],
    ["2026-12-31T15:59:59Z", "2027-01-01"],
    ["2026-12-31T16:00:00Z", "2027-01-02"],
    ["2028-02-28T16:00:00Z", "2028-03-01"],
  ]) assert.equal(projectPublicV2(input, codex, Date.parse(at!)).predictedResetTime, expected);
  input.events.pop();
  assert.equal(projectPublicV2(input, codex, now).predictedResetTime, null);
});

test("newer date and range completions do not discard the latest precise forecast anchor", () => {
  const input = fixture(), base = input.events[0]!;
  const times = ["2026-10-04T00:00:00Z", "2026-10-08T00:00:00Z", "2026-10-12T00:00:00Z",
    "2026-10-13", "2026-10-14T00:00:00Z/2026-10-14T02:00:00Z"];
  input.events = times.map((_, index) => ({ ...structuredClone(base), id: `event-${index}` }));
  input.links = input.events.map(row => ({ ...fixture().links[0]!, event_id: row.id }));
  input.events.forEach((row, index) => {
    row.presentation = { publicV2: { ...review({ ...input, events: [row] }), time: times[index]!, evidenceVersion: evidenceVersion(row, input) } };
  });
  const snapshot = projectPublicV2(input, codex, now);
  assert.equal(snapshot.predictedResetTime, "2026-10-16T00:00:00.000Z");
  assert.deepEqual(snapshot.statistics.typicalInterval, { value: 4, unit: "day", sampleCount: 2 });
  assert.equal(snapshot.events[0]!.id, "event-4");
});

test("official publication nodes contribute to interval statistics and the forecast", () => {
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
  assert.equal(snapshot.predictedResetTime, "2026-10-16T00:00:00.000Z");
  assert.equal(snapshot.events.every(event => !("details" in event)), true);
});

test("bonus milestones remain separate from the event opening time", () => {
  const input = fixture("bonus_credit"); const stored = review(input);
  stored.bonusCredit = { amount: null, eligibility: null, claimMethod: null, usageTerms: null,
    claimDeadline: { kind: "deadline", at: "2026-10-15T00:00:00Z" }, expiresAt: { kind: "date", date: "2026-11-01", timeZone: "UTC" } };
  input.events[0]!.presentation = { publicV2: stored };
  const data = projectPublicV2(input, codex, now);
  assert.deepEqual(data.events[0]!.bonusCredit, stored.bonusCredit);
  assert.equal(data.resetTime, stored.time);
});

test("saved bonus wording completes years and Pacific DST without adding provenance to public text", () => {
  const input = fixture("bonus_credit");
  input.posts[0]!.published_at = "2026-09-23T21:23:41Z";
  input.posts[0]!.text = "Claim by Oct 7. Credit expires Nov 4.";
  input.posts.push({ ...input.posts[0]!, id: "reminder", published_at: "2026-10-06T18:42:44Z",
    text: "Run /claim-credit by Oct 7 at 11:59pm PT. Credit expires Nov 4." });
  input.links.push({ ...input.links[0]!, post_id: "reminder", action: "progress" });
  const stored = review(input, { kind: "unknown" }); stored.summary = properName("Cloud sessions use the bonus first.");
  input.events[0]!.presentation = { publicV2: stored };
  const result = resolveBonusTimes(input.events[0]!, input, null);
  assert.deepEqual(result.bonusCredit!.claimDeadline, { kind: "deadline", at: "2026-10-08T06:59:00Z" });
  assert.deepEqual(result.bonusCredit!.expiresAt, { kind: "date", date: "2026-11-04", timeZone: "America/Los_Angeles" });
  assert.equal(result.resolutions[0]!.yearBasis, "activity");
  assert.equal(result.resolutions[1]!.zoneBasis, "post");
  const snapshot = projectPublicV2(input, claude, now);
  assert.deepEqual(snapshot.events[0]!.summary, stored.summary);
  assert.deepEqual(snapshot.events[0]!.bonusCredit, result.bonusCredit);
  assert.deepEqual(snapshot.events[0]!.time, serializeEventTime({ kind: "instant", at: "2026-10-06T18:42:44.000Z" }));
  assert.equal(snapshot.resetTime, snapshot.events[0]!.time);
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

test("source timezone detection ignores URLs in expressions, posts and activity context", () => {
  const text = "We will reset usage today at 2pm.";
  const post = { ...fixture().posts[0]!, published_at: "2026-10-15T12:00:00Z", text };
  for (const url of ["https://example.com/reset", "https://example.com/America/New_York", "www.example.com/reset"]) {
    for (const [excerpt, postText, activityText] of [
      [`${text} Details: ${url}`, `${text} Details: ${url}`, `${text} Details: ${url}`],
      [text, `${text} Details: ${url}`, `${text} Details: ${url}`],
      [text, text, `Details: ${url}`],
    ]) assert.deepEqual(resolveEventExpression(excerpt!, { ...post, text: postText! }, true, activityText!),
      { kind: "instant", at: "2026-10-15T14:00:00Z" }, `${url}: ${excerpt}`);
  }
  assert.deepEqual(resolveEventExpression(text, { ...post, text: `${text} Details: https://example.com/reset` }, true, "PT"),
    { kind: "instant", at: "2026-10-15T21:00:00Z" });
  assert.deepEqual(resolveEventExpression(text, { ...post, text: `${text} at 2pm XYZ` }, true, ""), { kind: "unknown" });
});

test("ISO occurrence timestamps and intervals retain offsets, seconds and fractional precision", () => {
  const post = { ...fixture().posts[0]!, published_at: "2026-10-15T12:00:00Z" };
  for (const [expression, time] of [
    ["2026-10-15T10:00:00Z", { kind: "instant", at: "2026-10-15T10:00:00Z" }],
    ["2026-10-15T10:00+08:00", { kind: "instant", at: "2026-10-15T02:00:00Z" }],
    ["2026-10-15T10:00:32.123456789-07:00", { kind: "instant", at: "2026-10-15T17:00:32.123456789Z" }],
    ["2026-10-15T10:00:00Z/2026-10-15T11:30:45.123Z", { kind: "range", from: "2026-10-15T10:00:00Z", through: "2026-10-15T11:30:45.123Z" }],
    ["2026-10-15T10:00:00+08:00 to 2026-10-15T11:00:00+08:00", { kind: "range", from: "2026-10-15T02:00:00Z", through: "2026-10-15T03:00:00Z" }],
  ] as const) {
    const text = `We reset usage at ${expression}.`;
    assert.deepEqual(resolveEventExpression(text, { ...post, text }, false, text), time, expression);
  }
  for (const expression of ["2026-10-15T25:00:00Z", "2026-02-30T10:00:00Z", "2026-10-15T10:00:00",
    "2026-10-15T11:00:00Z/2026-10-15T10:00:00Z", "2026-10-15T11:00:00Z/2026-10-16"]) {
    const text = `We reset usage at ${expression}.`;
    assert.deepEqual(resolveEventExpression(text, { ...post, text }, false, text), { kind: "unknown" }, expression);
  }
});

test("calendar reminders and confirmations infer years from the first announcement while relative times use their own post", () => {
  const post = { ...fixture().posts[0]!, published_at: "2026-10-08T12:00:00Z" };
  const resolve = (text: string, announcement = true, activityAnchor = "2026-09-30T12:00:00Z") =>
    resolveEventExpression(text, { ...post, text }, announcement, text, activityAnchor);
  for (const announcement of [true, false]) {
    assert.deepEqual(resolve("Reset on Oct 7 at 10am UTC.", announcement), { kind: "instant", at: "2026-10-07T10:00:00Z" });
    assert.deepEqual(resolve("Reset on Oct 7.", announcement), { kind: "date", date: "2026-10-07", timeZone: "UTC" });
  }
  post.published_at = "2027-01-08T12:00:00Z";
  for (const announcement of [true, false]) {
    assert.deepEqual(resolve("Reset on Jan 4 at 10am UTC.", announcement, "2026-12-29T12:00:00Z"),
      { kind: "instant", at: "2027-01-04T10:00:00Z" });
  }
  assert.deepEqual(resolve("Reset on Jan 4, 2028 at 10am UTC."), { kind: "instant", at: "2028-01-04T10:00:00Z" });
  assert.deepEqual(resolve("Reset today at 2pm UTC."), { kind: "instant", at: "2027-01-08T14:00:00Z" });
  assert.deepEqual(resolve("Reset tomorrow at 2pm UTC."), { kind: "instant", at: "2027-01-09T14:00:00Z" });
  assert.deepEqual(resolve("Reset in 2 hours."), { kind: "instant", at: "2027-01-08T14:00:00.000Z" });
  const confirmation = "Reset on Dec 31 at 10am UTC.";
  assert.deepEqual(resolveEventExpression(confirmation, { ...post, text: confirmation }, false, confirmation),
    { kind: "instant", at: "2026-12-31T10:00:00Z" });
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

test("completed ranges retain their time and stay out of exact interval and forecast samples", () => {
  const input = fixture();
  const window: EventTime = { kind: "range", from: "2026-10-12T17:00:00Z", through: "2026-10-12T19:00:00Z" };
  input.events[0]!.presentation = { publicV2: review(input, window) };
  const snapshot = projectPublicV2(input, codex, now);
  assert.deepEqual(snapshot.events[0]!.time, serializeEventTime(window)); assert.equal(snapshot.resetTime, serializeEventTime(window));
  assert.equal(snapshot.statistics.typicalInterval, null); assert.equal(snapshot.predictedResetTime, null);
  assert.equal(snapshot.statistics.resetsLast30Days, 1);
});

test("strict contracts reject bad URLs, duplicate or dangling references, and retired snapshot sections", () => {
  const input = fixture(); input.events[0]!.presentation = { publicV2: review(input) };
  const data = projectPublicV2(input, codex, now);
  for (const mutate of [
    (value: typeof data) => { value.sources[0]!.url = "https://user:password@example.com"; },
    (value: typeof data) => { value.events[0]!.updates[0]!.source.sourceId = "missing"; },
    (value: typeof data) => { Object.assign(value, { history: {} }); },
    (value: typeof data) => { Object.assign(value, { calendar: {} }); },
    (value: typeof data) => { Object.assign(value, { overview: {} }); },
    (value: typeof data) => { value.events[0]!.scope.planCodes.push("missing"); },
    (value: typeof data) => { value.sources.push(value.sources[0]!); },
  ]) { const changed = structuredClone(data); mutate(changed); assert.equal(resetSnapshotSchema.safeParse(changed).success, false); }
});

test("updates require strict source references and reject retired top-level source fields", () => {
  const data = projectPublicV2(fixture(), codex, now);
  for (const source of [undefined, null, {}, { sourceId: data.sources[0]!.id }, { url: "https://example.com/post" },
    { ...data.events[0]!.updates[0]!.source, extra: true }, { ...data.events[0]!.updates[0]!.source, sourceId: " \n" }]) {
    const changed = structuredClone(data);
    Object.assign(changed.events[0]!.updates[0]!, { source });
    assert.equal(resetSnapshotSchema.safeParse(changed).success, false);
  }
  const changed = structuredClone(data);
  Object.assign(changed.events[0]!, { sourceIds: [] });
  assert.equal(resetSnapshotSchema.safeParse(changed).success, false);
  Object.assign(changed.events[0]!, { primarySource: data.events[0]!.updates[0]!.source });
  assert.equal(resetSnapshotSchema.safeParse(changed).success, false);
});

test("account and update URLs share strict HTTP(S) rules without domain or path guessing", () => {
  const data = projectPublicV2(fixture(), codex, now);
  for (const url of ["javascript:alert(1)", "https://user:password@example.com/", "https://@example.com/", "https:///example.com",
    "https://", " https://example.com/", "https://example.com/ ", "https://example.com/\n", "https://example.com/\\post"]) {
    for (const target of ["account", "post"]) {
      const changed = structuredClone(data);
      if (target === "account") changed.sources[0]!.url = url;
      else changed.events[0]!.updates[0]!.source.url = url;
      assert.equal(resetSnapshotSchema.safeParse(changed).success, false, `${target}: ${JSON.stringify(url)}`);
    }
  }
  for (const url of ["HTTPS://example.com/news/@author?ref=@post#@details", data.sources[0]!.url]) {
    const changed = structuredClone(data);
    changed.events[0]!.updates[0]!.source.url = url;
    assert.equal(resetSnapshotSchema.safeParse(changed).success, true);
    changed.sources[0]!.url = url;
    assert.equal(resetSnapshotSchema.safeParse(changed).success, true);
  }
});

test("source dates require IANA zones, real calendar dates and the actual local day boundary", () => {
  assert.equal(eventTimeSchema.safeParse({ kind: "date", date: "2026-02-30", timeZone: "UTC" }).success, false);
  assert.equal(eventTimeSchema.safeParse({ kind: "date", date: "2026-10-12", timeZone: "+08:00" }).success, false);
});

test("public times are ISO scalars and events reject retired fields", () => {
  for (const value of ["2026-10-03T04:26:28Z", "2026-10-03", "2026-10-03T04:00:00Z/2026-10-03T05:00:00Z"]) {
    assert.equal(publicTimeSchema.safeParse(value).success, true);
  }
  for (const value of [null, "unknown", "2026-02-30", "2026-10-03T04:26:28", { kind: "instant", at: "2026-10-03T04:26:28Z" },
    "2026-10-03T05:00:00Z/2026-10-03T04:00:00Z"]) assert.equal(publicTimeSchema.safeParse(value).success, false);
  const snapshot = projectPublicV2(fixture(), codex, now);
  for (const field of ["announcement", "details"]) {
    const invalid = structuredClone(snapshot);
    Object.assign(invalid.events[0]!, { [field]: null });
    assert.equal(resetSnapshotSchema.safeParse(invalid).success, false);
  }
  for (const field of ["latestDirectReset", "latestCompletedReset", "statisticalForecast"]) {
    const invalid = structuredClone(snapshot); Object.assign(invalid, { [field]: null });
    assert.equal(resetSnapshotSchema.safeParse(invalid).success, false);
  }
});
