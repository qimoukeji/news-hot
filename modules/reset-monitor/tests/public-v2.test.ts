import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { config } from "@aihot/backend/config";
import { buildApp } from "../../../apps/api/src/app.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { createOverviewServer } from "../overview-server.ts";
import { exportPublicV2, previewPublicV2, applyPublicV2, type ReviewBundle } from "../backend/public-v2-review.ts";
import { evidenceVersion, properName, type PublicV2Input } from "../backend/public-v2.ts";
import { eventListSchema, overviewSchema } from "../public-v2.ts";

const definitions = [codex, claude, grok];
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`; await sql`DELETE FROM monitor_events`; await sql`DELETE FROM monitor_posts`; await sql`DELETE FROM audit_log`;
  installModules([...definitions.map(createMonitorServer), createOverviewServer(definitions)]);
  for (const definition of definitions) {
    await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url) VALUES
      (${definition.monitorId},'same-post',${definition.authors[0]!.handle},'2026-10-01T12:00:00Z','Synthetic: we reset usage at 12:00 UTC on October 1, 2026.',${`https://x.com/${definition.authors[0]!.handle}/status/same-post`})`;
    await sql`INSERT INTO monitor_events(monitor_id,id,type,status,title,created_at,updated_at,confirmation_basis) VALUES
      (${definition.monitorId},'same-event','direct_reset','confirmed','','2026-10-01T12:00:00Z','2026-10-01T12:00:00Z','source_post')`;
    await sql`INSERT INTO monitor_event_posts(monitor_id,event_id,post_id,stage,action,text,original_text) VALUES
      (${definition.monitorId},'same-event','same-post','confirmed','confirm','Synthetic reset','Synthetic reset')`;
  }
});
after(async () => { installModules([]); await closeDb(); });

function fill(bundle: ReviewBundle) {
  for (const part of bundle.monitors) {
    const input = part.input as PublicV2Input;
    part.reviews[0]!.publicV2 = {
      evidenceVersion: evidenceVersion(input.events[0]!, input), evidence: [{ postId: "same-post", excerpt: input.posts[0]!.text }],
      publishedAt: "2026-10-01T12:00:00Z", status: "completed", title: properName(`Synthetic ${part.monitorId} reset`),
      summary: null, time: "2026-10-01T12:00:00Z",
      updateSummaries: [{ postId: "same-post", summary: properName("Synthetic reset completed.") }],
      scope: { type: "unknown", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null }, bonusCredit: null,
    };
  }
  return bundle;
}

test("v2 HTTP supports anonymous 200/304, platform isolation, strict queries and read-only publication", async () => {
  const app = await buildApp(); const oldAdmin = config.devAdmin; config.devAdmin = null;
  try {
    const [before] = await sql`SELECT count(*)::int AS n FROM receipts`;
    for (const definition of definitions) {
      const path = definition.publicApiPath.replace("/v1/", "/v2/");
      const query = "?from=2026-10-01&to=2026-10-31";
      const response = await app.inject(path + query);
      assert.equal(response.statusCode, 200);
      const body = eventListSchema.parse(response.json());
      assert.deepEqual(Object.keys(body).sort(), ["list", "pagination"]);
      assert.equal(body.list[0]!.scope.type, "all_users");
      assert.equal(body.list[0]!.scope.note!.zh, "所有用户");
      assert.equal(Object.keys(body.list[0]!.scope.note!).length, 7);
      assert.deepEqual(body.list[0]!.time, "2026-10-01T12:00:00.000Z");
      assert.deepEqual(body.list[0]!.updates[0]!.source, {
        sourceId: `x-account:${definition.authors[0]!.handle.toLowerCase()}`,
        url: `https://x.com/${definition.authors[0]!.handle}/status/same-post`,
      });
      assert.equal("sourceIds" in body.list[0]!, false);
      assert.equal("primarySource" in body.list[0]!, false);
      assert.equal("bonusCredit" in body.list[0]!, false);
      assert.deepEqual(body.pagination, { limit: null, total: 1, hasMore: false, nextCursor: null });
      assert.equal(response.headers["access-control-allow-origin"], "*");
      assert.match(String(response.headers["cache-control"]), /max-age=60/);
      const unchanged = await app.inject({ url: path + query, headers: { "if-none-match": String(response.headers.etag) } });
      assert.equal(unchanged.statusCode, 304); assert.equal(unchanged.body, "");
      assert.equal((await app.inject(path + "?monitor_id=other")).statusCode, 400);
    }
    const response = await app.inject("/api/v2/overview");
    assert.equal(response.statusCode, 200);
    const overview = overviewSchema.parse(response.json());
    assert.deepEqual(overview.platforms.map(platform => platform.platform), definitions.map(definition => definition.publicV2!.platform));
    for (const [index, platform] of overview.platforms.entries()) {
      const definition = definitions[index]!;
      assert.equal(platform.sources.length, definition.authors.length);
      assert.equal(platform.catalog.quotaWindows.some(entry => entry.code === "monthly"), definition.monitorId !== "grok");
      assert.equal(platform.resetTime, "2026-10-01T12:00:00.000Z");
      assert.equal(platform.announcedResetTime, null);
      assert.equal("events" in platform, false);
    }
    assert.equal(response.headers["access-control-allow-origin"], "*");
    assert.match(String(response.headers["cache-control"]), /max-age=60/);
    const unchanged = await app.inject({ url: "/api/v2/overview", headers: { "if-none-match": String(response.headers.etag) } });
    assert.equal(unchanged.statusCode, 304); assert.equal(unchanged.body, "");
    assert.equal((await app.inject("/api/v2/overview?limit=1")).statusCode, 400);
    const [after] = await sql`SELECT count(*)::int AS n FROM receipts`;
    assert.equal(after!.n, before!.n);
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 0);
  } finally { config.devAdmin = oldAdmin; await app.close(); }
});

test("invalid stored editorial metadata returns 503 independently of other platforms", async () => {
  await sql`UPDATE monitor_events SET presentation='{"publicV2":{"unexpected":true}}'::jsonb WHERE monitor_id='claude'`;
  const app = await buildApp();
  try {
    const failed = await app.inject("/api/v2/claude-resets"); assert.equal(failed.statusCode, 503); assert.equal(failed.headers["cache-control"], "no-store");
    assert.equal((await app.inject("/api/v2/codex-resets")).statusCode, 200);
    assert.equal((await app.inject("/api/v2/grok-resets")).statusCode, 200);
  } finally { await app.close(); }
});

test("v2 HTTP lists filter and paginate without losing updates or changing platform overview", async () => {
  for (const [id, at] of [["second", "2026-10-02T12:00:00Z"], ["third", "2026-10-02T12:00:00Z"]]) {
    await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url) VALUES
      (${codex.monitorId},${id!},${codex.authors[0]!.handle},${at!},'Synthetic accepted reset.',${`https://example.test/${id}`})`;
    await sql`INSERT INTO monitor_events(monitor_id,id,type,status,title,created_at,updated_at,confirmation_basis) VALUES
      (${codex.monitorId},${id!},'direct_reset','confirmed','',${at!},${at!},'source_post')`;
    await sql`INSERT INTO monitor_event_posts(monitor_id,event_id,post_id,stage,action,text,original_text) VALUES
      (${codex.monitorId},${id!},${id!},'confirmed','confirm','Synthetic accepted reset.','Synthetic accepted reset.')`;
  }
  const app = await buildApp();
  try {
    const overview = (await app.inject("/api/v2/overview")).json();
    const base = "/api/v2/codex-resets?from=2026-10-01&to=2026-10-31";
    const whole = await app.inject(base + "&limit=");
    assert.equal(whole.statusCode, 200);
    assert.deepEqual(whole.json().list.map((event: { id: string }) => event.id), ["second", "third", "same-event"]);
    assert.deepEqual(whole.json().pagination, { limit: null, total: 3, hasMore: false, nextCursor: null });
    const page1 = await app.inject(base + "&limit=2");
    assert.equal(page1.statusCode, 200);
    const first = eventListSchema.parse(page1.json());
    assert.equal(first.pagination.hasMore, true); assert.equal(first.pagination.total, 3);
    const page2 = await app.inject(base + "&limit=2&cursor=" + encodeURIComponent(first.pagination.nextCursor!));
    const second = eventListSchema.parse(page2.json());
    assert.deepEqual(second.list.map(event => event.id), ["same-event"]);
    assert.equal(second.list[0]!.updates.length, 1); assert.equal(second.pagination.nextCursor, null);
    const filtered = await app.inject("/api/v2/codex-resets?from=2026-10-02&to=2026-10-02");
    assert.equal(filtered.json().pagination.total, 2);
    const changed = await app.inject({ url: "/api/v2/codex-resets?from=2026-09-01&to=2026-09-30", headers: { "if-none-match": String(whole.headers.etag) } });
    assert.equal(changed.statusCode, 200); assert.deepEqual(changed.json().list, []);
    for (const invalid of ["from=2026-02-29", "from=2026-05-01&to=2026-11-01", "limit=0", "limit=101", "limit=1.5", "cursor=", "limit=2&cursor=invalid", "page=1", "from=2026-10-02&to=2026-10-01"]) {
      assert.equal((await app.inject("/api/v2/codex-resets?" + invalid)).statusCode, 400, invalid);
    }
    const moved = "/api/v2/grok-resets?from=2026-10-01&to=2026-10-31&limit=2&cursor=" + encodeURIComponent(first.pagination.nextCursor!);
    assert.equal((await app.inject(moved)).statusCode, 400);
    const after = (await app.inject("/api/v2/overview")).json();
    delete overview.generatedAt; delete after.generatedAt;
    assert.deepEqual(after, overview);
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 0);
  } finally { await app.close(); }
});

test("v2 HTTP accepts named query zones, varies ETags and binds cursors to the effective zone", async () => {
  const at = "2026-10-01T23:30:00Z";
  await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url) VALUES
    (${codex.monitorId},'late',${codex.authors[0]!.handle},${at},'Synthetic late reset.','https://example.test/late')`;
  await sql`INSERT INTO monitor_events(monitor_id,id,type,status,title,created_at,updated_at,confirmation_basis) VALUES
    (${codex.monitorId},'late','direct_reset','confirmed','',${at},${at},'source_post')`;
  await sql`INSERT INTO monitor_event_posts(monitor_id,event_id,post_id,stage,action,text,original_text) VALUES
    (${codex.monitorId},'late','late','confirmed','confirm','Synthetic late reset.','Synthetic late reset.')`;
  const app = await buildApp();
  try {
    const base = "/api/v2/codex-resets?from=2026-10-01&to=2026-10-01";
    const utc = await app.inject(base);
    assert.equal(utc.statusCode, 200);
    assert.deepEqual(utc.json().list.map((event: { id: string }) => event.id), ["late", "same-event"]);
    const local = await app.inject({ url: base + "&timeZone=Asia%2FShanghai", headers: { "if-none-match": String(utc.headers.etag) } });
    assert.equal(local.statusCode, 200);
    assert.deepEqual(local.json().list.map((event: { id: string }) => event.id), ["same-event"]);
    assert.notEqual(local.headers.etag, utc.headers.etag);
    const explicitUtc = await app.inject({ url: base + "&timeZone=UTC", headers: { "if-none-match": String(utc.headers.etag) } });
    assert.equal(explicitUtc.statusCode, 304);
    const page = eventListSchema.parse((await app.inject(base + "&limit=1")).json());
    assert.ok(page.pagination.nextCursor);
    const cursorQuery = "&limit=1&cursor=" + encodeURIComponent(page.pagination.nextCursor);
    assert.equal((await app.inject(base + cursorQuery + "&timeZone=Asia%2FShanghai")).statusCode, 400);
    assert.deepEqual((await app.inject(base + cursorQuery + "&timeZone=UTC")).json().list.map((event: { id: string }) => event.id), ["same-event"]);
    for (const extra of ["timeZone=invalid", "timeZone=%2B08%3A00", "timeZone=UTC&timeZone=Asia%2FShanghai"]) {
      assert.equal((await app.inject(base + "&" + extra)).statusCode, 400);
    }
  } finally { await app.close(); }
});

test("default-month list ETags change at the requested zone's month boundary even for empty lists", async context => {
  let clock = Date.parse("2026-11-30T23:59:59Z");
  context.mock.method(Date, "now", () => clock);
  const app = await buildApp();
  try {
    const november = await app.inject("/api/v2/codex-resets");
    assert.equal(november.statusCode, 200); assert.deepEqual(november.json().list, []);
    clock = Date.parse("2026-12-01T00:00:00Z");
    const december = await app.inject({ url: "/api/v2/codex-resets", headers: { "if-none-match": String(november.headers.etag) } });
    assert.equal(december.statusCode, 200); assert.deepEqual(december.json().list, []);
    assert.notEqual(december.headers.etag, november.headers.etag);
    const sameMonth = await app.inject({ url: "/api/v2/codex-resets?from=&to=&limit=", headers: { "if-none-match": String(december.headers.etag) } });
    assert.equal(sameMonth.statusCode, 304);
    clock = Date.parse("2026-11-30T15:59:59Z");
    const localNovember = await app.inject("/api/v2/codex-resets?timeZone=Asia%2FShanghai");
    clock = Date.parse("2026-11-30T16:00:00Z");
    const localDecember = await app.inject({ url: "/api/v2/codex-resets?timeZone=Asia%2FShanghai", headers: { "if-none-match": String(localNovember.headers.etag) } });
    assert.equal(localDecember.statusCode, 200);
    assert.notEqual(localDecember.headers.etag, localNovember.headers.etag);
  } finally { await app.close(); }
});

test("overview ETags ignore generation timestamps but change when an expired forecast advances to tomorrow", async context => {
  for (const day of [5, 9]) {
    const id = `history-${day}`, at = `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`;
    await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url) VALUES
      (${codex.monitorId},${id},${codex.authors[0]!.handle},${at},'Synthetic accepted reset.',${`https://example.test/${id}`})`;
    await sql`INSERT INTO monitor_events(monitor_id,id,type,status,title,created_at,updated_at,confirmation_basis) VALUES
      (${codex.monitorId},${id},'direct_reset','confirmed','',${at},${at},'source_post')`;
    await sql`INSERT INTO monitor_event_posts(monitor_id,event_id,post_id,stage,action,text,original_text) VALUES
      (${codex.monitorId},${id},${id},'confirmed','confirm','Synthetic accepted reset.','Synthetic accepted reset.')`;
  }
  let clock = Date.parse("2026-12-31T15:59:58Z");
  context.mock.method(Date, "now", () => clock);
  const app = await buildApp();
  try {
    const initial = await app.inject("/api/v2/overview");
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().platforms[0].predictedResetTime, "2027-01-01");
    clock += 1_000;
    const unchanged = await app.inject({ url: "/api/v2/overview", headers: { "if-none-match": String(initial.headers.etag) } });
    assert.equal(unchanged.statusCode, 304);
    clock += 1_000;
    const nextDay = await app.inject({ url: "/api/v2/overview", headers: { "if-none-match": String(initial.headers.etag) } });
    assert.equal(nextDay.statusCode, 200);
    assert.equal(nextDay.json().platforms[0].predictedResetTime, "2027-01-02");
  } finally { await app.close(); }
});

test("missing or invalid primary sources fail only the affected platform", async () => {
  const app = await buildApp();
  try {
    for (const url of ["", "https://user:password@example.com/post", "https:///example.com/post"]) {
      await sql`UPDATE monitor_posts SET url=${url} WHERE monitor_id='claude'`;
      const failed = await app.inject("/api/v2/claude-resets");
      assert.equal(failed.statusCode, 503); assert.equal(failed.headers["cache-control"], "no-store");
    }
    await sql`DELETE FROM monitor_event_posts WHERE monitor_id='claude'`;
    assert.equal((await app.inject("/api/v2/claude-resets")).statusCode, 503);
    assert.equal((await app.inject("/api/v2/codex-resets")).statusCode, 200);
    assert.equal((await app.inject("/api/v2/grok-resets")).statusCode, 200);
  } finally { await app.close(); }
});

test("review preview is read-only; application writes only editorial data and audit, and preserves v1 output", async () => {
  const bundle = fill(await exportPublicV2(definitions));
  const app = await buildApp();
  try {
    const before = (await app.inject("/api/v1/codex-resets")).json();
    const preview = await previewPublicV2(bundle, definitions);
    assert.equal(preview.changes.length, 3);
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 0);
    const result = await applyPublicV2(bundle, definitions, "Synthetic reviewed source fixture");
    assert.equal(result.changes.length, 3);
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE '%.public_v2'`)[0]!.n, 3);
    assert.deepEqual((await app.inject("/api/v1/codex-resets")).json(), before);
    const next = await app.inject("/api/v2/codex-resets?from=2026-10-01&to=2026-10-31"); assert.equal(typeof next.json().list[0].time, "string");
    assert.equal(next.json().list[0].title.en, "Synthetic codex reset");
    assert.equal(next.json().list[0].updates[0].summary.en, "Synthetic reset completed.");
    await assert.rejects(applyPublicV2(bundle, definitions, "Stale review"), /Event changed/);
  } finally { await app.close(); }
});

test("review imports preview, persist and audit UTC times while preserving dates and fractional precision", async () => {
  const bundle = fill(await exportPublicV2(definitions));
  const cases = [
    { monitorId: "codex", input: "2026-10-01T20:00:00.123456789+08:00", output: "2026-10-01T12:00:00.123456789Z" },
    { monitorId: "claude", input: "2026-10-01T20:00:00+08:00/2026-10-01T06:00:00-07:00", output: "2026-10-01T12:00:00Z/2026-10-01T13:00:00Z" },
    { monitorId: "grok", input: "2026-10-01", output: "2026-10-01" },
  ];
  for (const entry of cases) bundle.monitors.find(part => part.monitorId === entry.monitorId)!.reviews[0]!.publicV2!.time = entry.input;
  const original = structuredClone(bundle.monitors.map(part => part.reviews));
  const preview = await previewPublicV2(bundle, definitions);
  assert.deepEqual(bundle.monitors.map(part => part.reviews), original, "preview does not mutate the submitted reviews");
  for (const entry of cases) {
    assert.equal(preview.changes.find(change => change.monitorId === entry.monitorId)!.after.time, entry.output);
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_events WHERE presentation ? 'publicV2'`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 0);
  const applied = await applyPublicV2(bundle, definitions, "Synthetic UTC review import");
  assert.deepEqual(bundle.monitors.map(part => part.reviews), original, "application does not mutate the submitted reviews");
  for (const entry of cases) {
    const change = applied.changes.find(change => change.monitorId === entry.monitorId)!;
    const [stored] = await sql`SELECT presentation FROM monitor_events WHERE monitor_id=${entry.monitorId} AND id='same-event'`;
    const definition = definitions.find(definition => definition.monitorId === entry.monitorId)!;
    const [audit] = await sql`SELECT "after" FROM audit_log WHERE action=${`${definition.names.auditActionPrefix}.public_v2`}`;
    assert.equal(change.after.time, entry.output);
    assert.deepEqual(stored!.presentation.publicV2, change.after);
    assert.deepEqual(audit!.after, change.after);
  }
  const again = await exportPublicV2(definitions);
  for (const entry of cases) again.monitors.find(part => part.monitorId === entry.monitorId)!.reviews[0]!.publicV2!.time = entry.input;
  assert.equal((await previewPublicV2(again, definitions)).changes.length, 0, "equivalent offset forms do not create new changes");
  assert.equal((await applyPublicV2(again, definitions, "Synthetic equivalent review")).changes.length, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 3);
});

test("source drift rejects the whole batch before any writes", async () => {
  const bundle = fill(await exportPublicV2(definitions));
  await sql`UPDATE monitor_posts SET text='Synthetic corrected source' WHERE monitor_id='grok'`;
  await assert.rejects(applyPublicV2(bundle, definitions, "Synthetic source conflict"), /Event changed|Evidence changed/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_events WHERE presentation ? 'publicV2'`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 0);
});

test("explicit review application can write through a connection whose default transactions are read-only", async () => {
  const bundle = fill(await exportPublicV2(definitions));
  // A separate pool gives every connection the setting without changing this file's shared pool.
  const database = new URL(process.env.DATABASE_URL!);
  database.searchParams.set("default_transaction_read_only", "on");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { sql, closeDb } from '@aihot/backend/db';
    import { backendDefinition as codex } from './modules/codex-reset/backend-definition.ts';
    import { backendDefinition as claude } from './modules/claude-reset/backend-definition.ts';
    import { backendDefinition as grok } from './modules/grok-reset/backend-definition.ts';
    import { applyPublicV2 } from './modules/reset-monitor/backend/public-v2-review.ts';
    try {
      assert.equal((await sql\`SELECT current_setting('transaction_read_only') AS mode\`)[0].mode, 'on');
      const result = await applyPublicV2(JSON.parse(process.env.TEST_REVIEW_BUNDLE), [codex,claude,grok], 'Synthetic authorized write with read-only connection default');
      assert.equal(result.changes.length, 3);
      assert.equal((await sql\`SELECT current_setting('transaction_read_only') AS mode\`)[0].mode, 'on');
      process.stdout.write(JSON.stringify({ changes: result.changes.length }));
    } finally { await closeDb(); }
  `], { env: { ...process.env, DATABASE_URL: database.toString(), TEST_REVIEW_BUNDLE: JSON.stringify(bundle) }, encoding: "utf8", timeout: 30_000 });
  assert.deepEqual(JSON.parse(output), { changes: 3 });
});

test("review application stores automatic milestone resolutions privately and leaves business text untouched", async () => {
  await sql`UPDATE monitor_events SET type='bonus_credit' WHERE monitor_id='claude'`;
  await sql`UPDATE monitor_posts SET text='Synthetic: claim by Oct 7 at 11:59pm PT. Credit expires Nov 4.' WHERE monitor_id='claude'`;
  const bundle = fill(await exportPublicV2([claude]));
  const reviewed = bundle.monitors[0]!.reviews[0]!.publicV2!;
  reviewed.status = "available"; reviewed.time = "2026-10-01T12:00:00Z"; reviewed.timeBasis = "latest_update";
  const result = await applyPublicV2(bundle, [claude], "Synthetic automatic time resolution");
  assert.equal(result.changes[0]!.after.timeResolutions!.length, 2);
  const [row] = await sql`SELECT presentation FROM monitor_events WHERE monitor_id='claude'`;
  assert.deepEqual(row!.presentation.publicV2.bonusCredit.claimDeadline, { kind: "deadline", at: "2026-10-08T06:59:00Z" });
  assert.deepEqual(row!.presentation.publicV2.bonusCredit.expiresAt, { kind: "date", date: "2026-11-04", timeZone: "America/Los_Angeles" });
  const event = result.snapshots[0]!.events[0]!;
  const app = await buildApp();
  try {
    for (const suffix of ["", "&limit=1"]) {
      const response = await app.inject("/api/v2/claude-resets?from=2026-10-01&to=2026-10-31" + suffix);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().list[0].type, "bonus_credit");
      assert.equal("bonusCredit" in response.json().list[0], false);
    }
    assert.deepEqual((await sql`SELECT presentation FROM monitor_events WHERE monitor_id='claude'`)[0]!.presentation, row!.presentation);
  } finally { await app.close(); }
  assert.equal(event.summary, null); assert.equal("details" in event, false);
  assert.equal("timeResolutions" in event, false);
  assert.equal(event.publishedAt, "2026-10-01T12:00:00Z");
});

test("evidence and seven-language requirements cannot be bypassed by a review file", async () => {
  const bundle = fill(await exportPublicV2(definitions));
  const reviewed = bundle.monitors[0]!.reviews[0]!.publicV2!;
  reviewed.evidence[0]!.excerpt = "Not present in the saved source";
  await assert.rejects(previewPublicV2(bundle, definitions), /not quoted/);
  reviewed.evidence[0]!.excerpt = (bundle.monitors[0]!.input as PublicV2Input).posts[0]!.text;
  delete reviewed.title.ja;
  await assert.rejects(previewPublicV2(bundle, definitions), /Missing ja/);
});

test("review files require one evidenced summary for every accepted business update", async () => {
  for (const failure of ["missing", "duplicate", "foreign", "evidence", "language"]) {
    const bundle = fill(await exportPublicV2([codex]));
    const reviewed = bundle.monitors[0]!.reviews[0]!.publicV2!;
    if (failure === "missing") reviewed.updateSummaries = [];
    if (failure === "duplicate") reviewed.updateSummaries!.push(reviewed.updateSummaries![0]!);
    if (failure === "foreign") reviewed.updateSummaries![0]!.postId = "unlinked";
    if (failure === "evidence") reviewed.evidence = [];
    if (failure === "language") delete reviewed.updateSummaries![0]!.summary.ja;
    await assert.rejects(applyPublicV2(bundle, [codex], "Synthetic invalid update summaries"), /Update summaries must cover|Missing ja|Too small/);
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 0);
  }
});
