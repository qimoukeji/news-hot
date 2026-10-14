import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { config } from "@aihot/backend/config";
import { buildApp } from "../../../apps/api/src/app.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { exportPublicV2, previewPublicV2, applyPublicV2, type ReviewBundle } from "../backend/public-v2-review.ts";
import { evidenceVersion, properName, type PublicV2Input } from "../backend/public-v2.ts";
import { resetSnapshotSchema } from "../public-v2.ts";

const definitions = [codex, claude, grok];
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`; await sql`DELETE FROM monitor_events`; await sql`DELETE FROM monitor_posts`; await sql`DELETE FROM audit_log`;
  installModules(definitions.map(createMonitorServer));
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
      summary: null, details: null, time: { kind: "instant", at: "2026-10-01T12:00:00Z" }, announcement: null,
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
      const response = await app.inject(path);
      assert.equal(response.statusCode, 200);
      const body = resetSnapshotSchema.parse(response.json());
      assert.equal(body.platform, definition.publicV2!.platform);
      assert.equal(body.sources.some(source => source.url.includes(definition.authors[0]!.handle)), true);
      assert.equal(response.headers["access-control-allow-origin"], "*");
      assert.match(String(response.headers["cache-control"]), /max-age=60/);
      const unchanged = await app.inject({ url: path, headers: { "if-none-match": String(response.headers.etag) } });
      assert.equal(unchanged.statusCode, 304); assert.equal(unchanged.body, "");
      assert.equal((await app.inject(path + "?monitor_id=other")).statusCode, 400);
    }
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
    const next = await app.inject("/api/v2/codex-resets"); assert.equal(next.json().events[0].time.kind, "instant");
    assert.equal(next.json().events[0].title.en, "Synthetic codex reset");
    await assert.rejects(applyPublicV2(bundle, definitions, "Stale review"), /Event changed/);
  } finally { await app.close(); }
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
  await sql`SET default_transaction_read_only=on`;
  try {
    const [setting] = await sql`SELECT current_setting('transaction_read_only') AS mode`;
    assert.equal(setting!.mode, "on");
    const result = await applyPublicV2(bundle, definitions, "Synthetic authorized write with read-only connection default");
    assert.equal(result.changes.length, 3);
    const [after] = await sql`SELECT current_setting('transaction_read_only') AS mode`;
    assert.equal(after!.mode, "on");
  } finally { await sql`SET default_transaction_read_only=off`; }
});

test("review application stores automatic milestone resolutions privately and leaves business text untouched", async () => {
  await sql`UPDATE monitor_events SET type='bonus_credit' WHERE monitor_id='claude'`;
  await sql`UPDATE monitor_posts SET text='Synthetic: claim by Oct 7 at 11:59pm PT. Credit expires Nov 4.' WHERE monitor_id='claude'`;
  const bundle = fill(await exportPublicV2([claude]));
  const reviewed = bundle.monitors[0]!.reviews[0]!.publicV2!;
  reviewed.status = "available"; reviewed.time = { kind: "unknown" };
  const result = await applyPublicV2(bundle, [claude], "Synthetic automatic time resolution");
  assert.equal(result.changes[0]!.after.timeResolutions!.length, 2);
  const [row] = await sql`SELECT presentation FROM monitor_events WHERE monitor_id='claude'`;
  assert.deepEqual(row!.presentation.publicV2.bonusCredit.claimDeadline, { kind: "deadline", at: "2026-10-08T06:59:00Z" });
  assert.deepEqual(row!.presentation.publicV2.bonusCredit.expiresAt, { kind: "date", date: "2026-11-04", timeZone: "America/Los_Angeles" });
  const event = result.snapshots[0]!.events[0]!;
  assert.equal(event.summary, null); assert.equal(event.details, null);
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
