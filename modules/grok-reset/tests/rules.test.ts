import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../../../apps/api/src/app.ts";
import { inMonitor } from "@aihot/reset-monitor/backend/context";
import { applyRecognition } from "@aihot/reset-monitor/backend/assemble";
import { resetPage, resetsSnapshot } from "@aihot/reset-monitor/backend/read";
import { monitorPostDetail, previewMonitorReview, submitMonitorReview } from "@aihot/reset-monitor/backend/manual-review";
import { bonusCreditOf } from "@aihot/reset-monitor/backend/bonus-credit";
import { trustedThreadEvents } from "@aihot/reset-monitor/backend/thread-events";
import type { ContextInput, Proposition, Recognition } from "@aihot/reset-monitor/backend/recognize";
import type { AdminMonitorReviewDraft, ResetMonitorSnapshot } from "@aihot/reset-monitor/contracts";
import { modulePublication } from "@aihot/backend/publication/modules";
import { backendDefinition } from "../backend-definition.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import server from "../server.ts";
import { recognition } from "./sample.fixture.ts";

const scoped = <T>(run: () => T) => inMonitor(backendDefinition, run);
const at = new Date();
let serial = 0;
async function record(author: string, patch: Partial<Proposition> = {}, options: { source?: string; rec?: Recognition; context?: ContextInput[] } = {}) {
  const id = String(99000 + ++serial);
  const source = options.source ?? `We ${patch.action === "confirm" ? "have reset" : "will reset"} usage limits.`;
  const rec = options.rec ?? recognition(source, patch);
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,raw)
    VALUES ('grok',${id},${author},${new Date(at.getTime() + serial * 1000)},${source},${`https://x.com/${author}/status/${id}`},${sql.json({ context: (options.context ?? []).map(c => ({ ...c })) })})`;
  const applied = await scoped(() => applyRecognition(id, rec));
  return { id, rec, applied };
}
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
  installModules([server]);
});
after(async () => { installModules([]); await stopBoss(); await closeDb(); });

test("account defaults preserve unknown plans, actual authors and immutable model evidence", async () => {
  for (const [author, product] of [["bot", "Grok Bot"], ["grok", "Grok 普通额度"]]) {
    const saved = await record(author!);
    const page = await scoped(() => resetPage());
    const event = page.events.find(e => e.id === saved.applied.eventIds[0])!;
    assert.equal(event.presentation!.productsZh, product);
    assert.equal(event.presentation!.scopeLabel, null);
    assert.equal(event.schedule, null);
    assert.equal(event.estimate, null);
    assert.equal(event.posts[0]!.author, author);
    const detail = await scoped(() => monitorPostDetail(saved.id));
    assert.equal(detail!.post.author, author);
    assert.deepEqual(detail!.originalRecognition!.modelResult, saved.rec);
    assert.equal(detail!.draft.propositions[0]!.scope.productsZh, product);
  }
});

test("explicit product wins; cross-account confirmation and repeated confirmation link one event", async () => {
  const source = await record("bot");
  const eventId = source.applied.eventIds[0]!;
  const patch: Partial<Proposition> = { action: "confirm", relatesTo: eventId,
    scope: { audienceSource: "Custom plan", plans: ["Custom plan"], audienceZh: null, productsZh: "Grok Bot" } };
  const first = await record("grok", patch, { source: `We have reset usage limits. https://x.com/bot/status/${source.id}` });
  const repeated = await record("bot", patch);
  assert.deepEqual(first.applied.eventIds, [eventId]);
  assert.deepEqual(repeated.applied.eventIds, [eventId]);
  const snapshot = await scoped(() => resetsSnapshot());
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.events[0]!.status, "confirmed");
  assert.equal(snapshot.events[0]!.presentation!.productsZh, "Grok Bot");
  assert.equal(snapshot.events[0]!.posts.length, 3);
});

test("default products and conflicting explicit plans cannot close an incompatible event", async () => {
  const bot = await record("bot", { scope: { audienceSource: "Plan A", plans: ["Plan A"], audienceZh: null, productsZh: null } });
  const wrongProduct = await record("grok", { action: "confirm", relatesTo: bot.applied.eventIds[0]! });
  const wrongPlan = await record("bot", { action: "confirm", relatesTo: bot.applied.eventIds[0]!,
    scope: { audienceSource: "Plan B", plans: ["Plan B"], audienceZh: null, productsZh: null } });
  const inferred = await record("grok", { action: "confirm" });
  for (const saved of [wrongProduct, wrongPlan, inferred]) {
    assert.deepEqual(saved.applied.eventIds, []);
    assert.ok((await scoped(() => monitorPostDetail(saved.id)))!.post.needs_review);
  }
  assert.equal((await scoped(() => resetsSnapshot())).events[0]!.status, "announced");
});

test("default product cannot overwrite a broader existing or manually reviewed product", async () => {
  const saved = await record("bot", { scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: "Grok Bot 和 Grok" } });
  const detail = await scoped(() => monitorPostDetail(saved.id));
  const draft: AdminMonitorReviewDraft = { ...detail!.draft, propositions: detail!.draft.propositions.map(p => ({ ...p, targetEventId: saved.applied.eventIds[0]!, overrideEventFields: true })) };
  const preview = await scoped(() => previewMonitorReview(saved.id, { draft, version: detail!.version }));
  await scoped(() => submitMonitorReview(saved.id, { draft, version: detail!.version, previewToken: preview!.previewToken, reason: "模拟核对产品范围" }, "tester"));
  await record("bot", { action: "confirm", relatesTo: saved.applied.eventIds[0]! });
  const event = (await scoped(() => resetsSnapshot())).events[0]!;
  assert.equal(event.presentation!.productsZh, "Grok Bot 和 Grok");
  assert.equal(event.status, "confirmed");
});

test("matching products across accounts still require explicit event evidence", async () => {
  const source = await record("bot");
  const patch: Partial<Proposition> = { action: "confirm", scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: "Grok Bot" } };
  const ambiguous = await record("grok", patch);
  assert.deepEqual(ambiguous.applied.eventIds, []);
  assert.ok((await scoped(() => monitorPostDetail(ambiguous.id)))!.post.needs_review);
  const namedOnly = await record("grok", { ...patch, relatesTo: source.applied.eventIds[0]! });
  assert.deepEqual(namedOnly.applied.eventIds, []);
  assert.ok((await scoped(() => monitorPostDetail(namedOnly.id)))!.post.needs_review);
  const explicit = await record("grok", { ...patch, relatesTo: source.applied.eventIds[0]! }, { source: `We have reset usage limits. https://x.com/bot/status/${source.id}` });
  assert.deepEqual(explicit.applied.eventIds, source.applied.eventIds);
});

test("identical excerpts for different products retain independent resets", async () => {
  const source = "We have reset usage limits.";
  const rec = recognition(source, { action: "confirm" });
  rec.propositions = ["Grok Bot", "Grok 普通额度"].map(productsZh => ({ ...rec.propositions[0]!, scope: { audienceSource: null, plans: null, audienceZh: null, productsZh } }));
  const saved = await record("bot", {}, { source, rec });
  assert.equal(saved.applied.eventIds.length, 2);
  assert.equal((await scoped(() => resetsSnapshot())).count, 2);
});

test("mixed post keeps a genuine reset while excluding API gifts and ordinary limit increases", async () => {
  const source = "We will reset usage limits. We offer API credits. We have doubled usage limits.";
  const rec = recognition(source);
  rec.propositions = [
    { ...rec.propositions[0]!, excerpt: "We will reset usage limits." },
    { ...rec.propositions[0]!, kind: "bonus_credit", excerpt: "We offer API credits." },
    { ...rec.propositions[0]!, excerpt: "We have doubled usage limits." },
  ];
  const saved = await record("bot", {}, { source, rec });
  assert.equal(saved.applied.eventIds.length, 1);
  const detail = await scoped(() => monitorPostDetail(saved.id));
  assert.equal(detail!.originalRecognition!.exclusions.length, 2);
  assert.equal(detail!.post.needs_review, false);
  assert.deepEqual(detail!.originalRecognition!.modelResult, rec);
  for (const phrase of ["Usage limits reset automatically every day.", "Maybe a surprise reset soon.", "Usage limits reset every week."]) {
    const excluded = await record("grok", { role: phrase.startsWith("Maybe") ? "uncertain" : "policy", real: false }, { source: phrase });
    assert.deepEqual(excluded.applied.eventIds, []);
  }
});

test("all three kinds remain distinct and bonus dates accept either official author, never other authors", async () => {
  const card = await record("bot", { kind: "reset_credit" }, { source: "We will grant one reset credit to reset usage limits." });
  assert.equal(card.applied.eventIds.length, 1);
  const source = "You can claim one-time bonus credits now. Claim by 2026-10-12 at 12:00 UTC. Credits expire Nov 4.";
  const rec = recognition(source, { kind: "bonus_credit", action: "confirm", bonusCredit: {
    amount: "one-time bonus credits", eligibility: null, claimMethod: null,
    claimDeadline: { source: "Claim by 2026-10-12 at 12:00 UTC.", at: null, statedTime: { precision: "exact", timezone: "UTC", date: "2026-10-12", clock: "12:00", relativeHours: null, period: null, clockThrough: null, dayOffset: null } },
    expiresAt: { source: "Credits expire Nov 4.", at: null },
  } });
  const bonus = await record("grok", {}, { source, rec });
  const page = await scoped(() => resetPage(at.getTime() + 60_000));
  assert.equal(page.stats.credits90, 0);
  assert.equal(page.stats.resets90, 0);
  assert.equal(page.stats.bonuses90, 1);
  const event = page.events.find(e => e.id === bonus.applied.eventIds[0])!;
  assert.equal(event.presentation!.bonusCredit!.claimDeadline!.at, "2026-10-12T20:00:00.000+08:00");
  assert.equal(event.presentation!.bonusCredit!.expiresAt!.at, null);
  const p = { ...rec.propositions[0]!, bonusCredit: { ...rec.propositions[0]!.bonusCredit!, claimDeadline: { ...rec.propositions[0]!.bonusCredit!.claimDeadline!, timeSourceId: "parent" } } };
  for (const author of ["bot", "grok", "reader"]) {
    const bonusDetails = scoped(() => bonusCreditOf(p, { id: "reply", text: "Details.", publishedAt: at,
      context: [{ id: "parent", author, relation: "reply", text: source, publishedAt: at.toISOString() }] }));
    assert.equal(!!bonusDetails!.claimDeadline, author !== "reader");
  }
  const context = [{ id: bonus.id, author: "grok", relation: "reply" as const, text: source, publishedAt: new Date(at.getTime() + serial * 1000).toISOString() }];
  const trusted = await scoped(() => sql.begin(tx => trustedThreadEvents(tx, context, new Date(at.getTime() + 60_000))));
  assert.equal(trusted[0]!.id, event.id);
  assert.deepEqual(await scoped(() => sql.begin(tx => trustedThreadEvents(tx, [{ ...context[0]!, author: "bot" }], new Date(at.getTime() + 60_000)))), []);
});

test("Grok public, Agent and MCP reads agree, remain read-only and enforce backend authorization", async () => {
  const saved = await record("grok", { action: "confirm" });
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url) VALUES ('claude',${saved.id},'ClaudeDevs',now(),'other monitor','https://example.test/other')`;
  const app = await buildApp();
  const admin = config.devAdmin;
  const [before] = await sql`SELECT count(*)::int AS n FROM receipts`;
  try {
    config.devAdmin = null;
    for (const path of ["/api/site/grok-reset", "/api/site/grok-reset/version", "/api/v1/grok-resets", "/api/v1/grok-resets/recent", "/api/v1/agent/grok-resets"]) {
      assert.equal((await app.inject(path)).statusCode, 200, path);
    }
    assert.equal((await app.inject("/api/admin/grok-reset/posts")).statusCode, 401);
    assert.equal((await app.inject("/api/v1/grok-resets?monitor_id=claude")).statusCode, 400);
    config.devAdmin = { displayName: "Test admin" };
    assert.equal((await app.inject("/api/admin/grok-reset/posts?filter=all")).json().rows[0].author, "grok");
    const data = await modulePublication<ResetMonitorSnapshot>("grok-reset", "snapshot");
    const result = await server.agent!.abilities![0]!.mcp.run({});
    assert.equal((result.structured as unknown as ResetMonitorSnapshot).count, data.count);
    assert.equal(data.events[0]!.posts[0]!.author, "grok");
    assert.ok(result.text.includes("Grok 普通额度"));
    assert.deepEqual((await sql`SELECT count(*)::int AS n FROM receipts`)[0], before);
  } finally { config.devAdmin = admin; await app.close(); }
});

test("Grok manual review cannot change Codex or Claude posts and events with the same IDs", async () => {
  const saved = await record("bot");
  for (const definition of [codex, claude]) {
    await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url)
      VALUES (${definition.monitorId},${saved.id},${definition.authors[0]!.handle},${at},'We will reset usage limits.','https://example.test/synthetic')`;
    await inMonitor(definition, () => applyRecognition(saved.id, recognition("We will reset usage limits.")));
  }
  const others = await Promise.all([codex, claude].map(definition => inMonitor(definition, () => resetsSnapshot())));
  assert.ok(others.every(snapshot => snapshot.events[0]!.id === saved.applied.eventIds[0]));
  const detail = await scoped(() => monitorPostDetail(saved.id));
  const draft: AdminMonitorReviewDraft = { ...detail!.draft, decision: "related", translationZh: "模拟人工判断：不属于额度事件", propositions: [] };
  const preview = await scoped(() => previewMonitorReview(saved.id, { draft, version: detail!.version }));
  await scoped(() => submitMonitorReview(saved.id, { draft, version: detail!.version, previewToken: preview!.previewToken, reason: "模拟核对原帖" }, "tester"));
  assert.equal((await scoped(() => resetsSnapshot())).count, 0);
  for (const [index, definition] of [codex, claude].entries()) {
    assert.deepEqual(await inMonitor(definition, () => resetsSnapshot()), others[index]);
    assert.equal((await inMonitor(definition, () => monitorPostDetail(saved.id)))!.post.manual_review ?? null, null);
  }
});
