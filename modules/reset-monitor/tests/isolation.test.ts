import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { modulePublication } from "@aihot/backend/publication/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../../../apps/api/src/app.ts";
import { inMonitor, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { createMonitorServer, monitorNames } from "../server.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { resetPage, resetVersion, resetsSnapshot } from "../backend/read.ts";
import { applyRecognition } from "../backend/assemble.ts";
import { listMonitorEvents, listMonitorPosts, reviewReceipt } from "../backend/admin.ts";
import { monitorPostDetail, previewMonitorReview, submitMonitorReview } from "../backend/manual-review.ts";
import { flushResetPushes } from "../backend/scan.ts";
import type { Recognition } from "../backend/recognize.ts";
import type { AdminMonitorReviewDraft, ResetMonitorSnapshot } from "../contracts.ts";

const third: ResetMonitorBackendDefinition = {
  ...claude, monitorId: "testai", moduleName: "testai-reset", product: "TestAI", author: "TestAI", authorName: "TestAI",
  pagePath: "/testai-reset", adminPath: "/admin/testai-reset", adminApiPath: "/api/admin/testai-reset",
  siteApiPath: "/api/site/testai-reset", publicApiPath: "/api/v1/testai-resets", agentPath: "/testai-resets",
  mcpTool: "get_testai_resets", names: monitorNames("testai"),
};
const at = new Date();
const text = (definition: ResetMonitorBackendDefinition, action = "announce") =>
  `We ${action === "confirm" ? "have reset" : "will reset"} ${definition.product} usage for ${definition.monitorId === "codex" ? "Pro" : "Max"}.`;

async function addPost(definition: ResetMonitorBackendDefinition, id: string, source = text(definition), publishedAt = at) {
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url)
    VALUES (${definition.monitorId},${id},${definition.author},${publishedAt},${source},${`https://x.com/${definition.author}/status/${id}`})`;
}
function recognition(definition: ResetMonitorBackendDefinition, action: "announce" | "confirm" = "announce"): Recognition {
  return { relevant: true, translationZh: `${definition.product} 的原帖译文`, contextZh: [], outage: null, needsReview: false,
    model: "test", promptVersion: "test", receiptId: 0, propositions: [{
      kind: "direct_reset", kindExplicit: true, action, real: true, count: 1, relatesTo: null,
      excerpt: text(definition, action), excerptZh: `${definition.product} 重置`, statedTime: null, timeInferred: false, expectedLanding: null,
      scope: { audienceSource: definition.monitorId === "codex" ? "Pro" : "Max", plans: [definition.monitorId === "codex" ? "Pro" : "Max"], audienceZh: null, productsZh: definition.product },
    }] };
}

beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM deliveries`;
  await sql`DELETE FROM notify_targets`;
  installModules([]);
});
after(async () => { installModules([]); await stopBoss(); await closeDb(); });

test("same post and event IDs keep assembly, public health, history and revision changes isolated", async () => {
  for (const definition of [codex, claude]) {
    const action = definition === codex ? "confirm" : "announce";
    await addPost(definition, "shared-id", text(definition, action), definition === codex ? new Date(at.getTime() - 86400_000) : at);
    await inMonitor(definition, () => applyRecognition("shared-id", recognition(definition, action)));
    await sql`INSERT INTO monitor_state (monitor_id,key,value) VALUES (${definition.monitorId},'watermarks:socialdata',
      ${sql.json({ lastVerifiedAt: at.toISOString(), lastCollectedAt: at.toISOString() })})`;
  }
  await addPost(claude, "claude-pending");
  const [codexPage, claudePage] = await Promise.all([inMonitor(codex, () => resetPage(at.getTime())), inMonitor(claude, () => resetPage(at.getTime()))]);
  assert.equal(codexPage.count, 1);
  assert.equal(claudePage.count, 1);
  assert.equal(codexPage.events[0]!.id, claudePage.events[0]!.id);
  assert.equal(codexPage.events[0]!.status, "confirmed");
  assert.equal(claudePage.events[0]!.status, "announced");
  assert.match(codexPage.events[0]!.posts[0]!.fullOriginalText!, /Codex/);
  assert.match(claudePage.events[0]!.posts[0]!.fullOriginalText!, /Claude/);
  assert.equal(codexPage.monitor!.pendingCount, 0);
  assert.equal(claudePage.monitor!.pendingCount, 1);
  assert.notEqual(codexPage.historyFrom, claudePage.historyFrom);
  assert.equal(codexPage.stats.resets90, 1);
  assert.equal(claudePage.stats.resets90, 0);
  assert.equal(claudePage.events[0]!.estimate, null);
  const codexVersion = await inMonitor(codex, () => resetVersion(at.getTime()));
  const claudeVersion = await inMonitor(claude, () => resetVersion(at.getTime()));
  await sql`UPDATE monitor_state SET value='{"revision":"claude-only"}' WHERE monitor_id='claude' AND key='publication_revision'`;
  assert.deepEqual(await inMonitor(codex, () => resetVersion(at.getTime())), codexVersion);
  assert.notEqual((await inMonitor(claude, () => resetVersion(at.getTime()))).version, claudeVersion.version);
  const [candidates, codexCandidates] = await Promise.all([
    inMonitor(claude, () => listMonitorEvents({ filter: "receipt_review" })),
    inMonitor(codex, () => listMonitorEvents({ filter: "receipt_review" })),
  ]);
  assert.equal(candidates.total, 1, "another monitor's confirmation must not suppress account review");
  assert.equal(codexCandidates.total, 0);
  assert.equal((await inMonitor(codex, () => listMonitorPosts({ filter: "all" }))).total, 1);
  assert.equal((await inMonitor(claude, () => listMonitorPosts({ filter: "all" }))).total, 2);
  const event = candidates.events[0]!;
  await inMonitor(claude, () => reviewReceipt(event.id, { version: new Date(event.updated_at).toISOString(), occurredOn: null, reason: "核验 Claude 账户" }, "claude-reviewer"));
  assert.equal((await inMonitor(codex, () => resetsSnapshot())).events[0]!.confirmationBasis, "source_post");
  assert.equal((await inMonitor(claude, () => resetsSnapshot())).events[0]!.confirmationBasis, "receipt_review");
});

test("post review, audit and notification dedupe keys remain monitor local", async () => {
  for (const definition of [codex, claude]) await addPost(definition, "same-review");
  const detail = await inMonitor(claude, () => monitorPostDetail("same-review"));
  assert.match(detail!.post.text, /Claude/);
  const draft: AdminMonitorReviewDraft = { decision: "related", translationZh: "Claude 人工译文", contextZh: [], outage: null, propositions: [] };
  const preview = await inMonitor(claude, () => previewMonitorReview("same-review", { draft, version: detail!.version }));
  await inMonitor(claude, () => submitMonitorReview("same-review", { draft, version: detail!.version, previewToken: preview!.previewToken, reason: "核对 Claude" }, "claude-reviewer"));
  const codexDetail = await inMonitor(codex, () => monitorPostDetail("same-review"));
  const claudeDetail = await inMonitor(claude, () => monitorPostDetail("same-review"));
  assert.equal(codexDetail!.post.translation, null);
  assert.equal(codexDetail!.history.length, 0);
  assert.equal(claudeDetail!.post.translation, "Claude 人工译文");
  assert.equal(claudeDetail!.history.length, 1);
  await addPost(claude, "only-claude");
  assert.equal(await inMonitor(codex, () => monitorPostDetail("only-claude")), null);
  for (const definition of [codex, claude]) {
    await addPost(definition, "same-push");
    await inMonitor(definition, () => applyRecognition("same-push", recognition(definition)));
  }
  await sql`INSERT INTO notify_targets (key,purpose,kind,enabled) VALUES ('isolation-log','content','log',true)`;
  await inMonitor(codex, () => flushResetPushes());
  await inMonitor(claude, () => flushResetPushes());
  const delivery = await sql`SELECT subject_kind,dedupe_key,payload FROM deliveries WHERE target_key='isolation-log' ORDER BY subject_kind`;
  assert.equal(delivery.length, 2);
  assert.deepEqual(delivery.map((row) => row.subject_kind), ["claude_reset", "codex_reset"]);
  assert.match(delivery[0]!.dedupe_key, /^claude:same-push:/);
  assert.match(delivery[1]!.dedupe_key, /^codex:same-push:/);
  assert.match(JSON.stringify(delivery[0]!.payload), /Claude/);
  await inMonitor(claude, () => flushResetPushes());
  assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key='isolation-log'`).length, 2);
});

test("third monitor shares publications, HTTP and Agent without new tables, and public reads stay side effect free", async () => {
  installModules([codex, claude, third].map(createMonitorServer));
  for (const definition of [codex, claude, third]) {
    await addPost(definition, "same-third");
    await inMonitor(definition, () => applyRecognition("same-third", recognition(definition)));
  }
  const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'monitor_%' ORDER BY tablename`;
  assert.deepEqual(tables.map((row) => row.tablename), ["monitor_event_posts", "monitor_events", "monitor_posts", "monitor_state"]);
  const [thirdData, claudeData] = await Promise.all([
    modulePublication<ResetMonitorSnapshot>(third.moduleName, "snapshot"), modulePublication<ResetMonitorSnapshot>(claude.moduleName, "snapshot"),
  ]);
  assert.match(thirdData.events[0]!.posts[0]!.fullOriginalText!, /TestAI/);
  assert.match(claudeData.events[0]!.posts[0]!.fullOriginalText!, /Claude/);
  const [before] = await sql`SELECT count(*) AS n FROM receipts`;
  const app = await buildApp();
  const devAdmin = config.devAdmin;
  try {
    config.devAdmin = null;
    for (const definition of [codex, claude, third]) {
      const response = await app.inject(definition.publicApiPath);
      assert.equal(response.statusCode, 200, definition.publicApiPath);
      assert.match(response.json().events[0].posts[0].fullOriginalText, new RegExp(definition.product));
      assert.equal((await app.inject(definition.agentPath.replace(/^\//, "/api/v1/agent/"))).statusCode, 200);
      assert.equal((await app.inject(definition.siteApiPath + "/version")).statusCode, 200);
      assert.equal((await app.inject(definition.adminApiPath + "/posts")).statusCode, 401);
      assert.equal((await app.inject(definition.publicApiPath + "?monitor_id=other")).statusCode, 400);
    }
    config.devAdmin = { displayName: "Isolation reviewer" };
    const admin = await app.inject(claude.adminApiPath + "/posts?filter=all");
    assert.equal(admin.statusCode, 200);
    assert.equal(admin.json().total, 1);
    assert.match(admin.json().rows[0].text, /Claude/);
    const blocked = await app.inject({ method: "POST", url: claude.adminApiPath + "/posts/same-third/review/preview", payload: {} });
    assert.equal(blocked.statusCode, 403);
    const result = await createMonitorServer(third).agent!.abilities![0]!.mcp.run({});
    assert.match(result.text, /TestAI/);
    assert.equal((result.structured as unknown as ResetMonitorSnapshot).count, 1);
  } finally { config.devAdmin = devAdmin; await app.close(); }
  const [afterReads] = await sql`SELECT count(*) AS n FROM receipts`;
  assert.equal(afterReads!.n, before!.n, "page, API, Agent, MCP and backend reads must not invoke paid services");
});

test("a module exclusion bypasses automatic review but preserves evidence and permits a manual correction", async () => {
  const definition = { ...third, excludeProposition: () => "此命题不属于本监控范围" };
  const id = "excluded-third";
  const rec = recognition(definition);
  rec.propositions[0]!.timeSourceId = "missing-source";
  rec.propositions[0]!.statedTime = { precision: "exact", timezone: "UTC", clock: "18:00", relativeHours: null,
    period: null, clockThrough: null, dayOffset: null };
  await addPost(definition, id);
  const applied = await inMonitor(definition, () => applyRecognition(id, rec));
  assert.deepEqual(applied, { eventIds: [], notify: [] });
  const detail = await inMonitor(definition, () => monitorPostDetail(id));
  assert.equal(detail!.draft.decision, "unrelated");
  assert.deepEqual(detail!.draft.propositions, []);
  assert.equal(detail!.originalRecognition.needsReview, false);
  assert.deepEqual(detail!.originalRecognition.modelResult, rec);
  assert.deepEqual(detail!.originalRecognition.exclusions, [{ index: 0, reason: "此命题不属于本监控范围" }]);
  const p = rec.propositions[0]!;
  const draft: AdminMonitorReviewDraft = { decision: "events", translationZh: rec.translationZh, contextZh: [], outage: null,
    propositions: [{ kind: p.kind, kindExplicit: p.kindExplicit, action: p.action, count: p.count,
      excerpt: p.excerpt, excerptZh: p.excerptZh, scope: p.scope, targetEventId: null, schedule: null, occurredOn: null }] };
  const preview = await inMonitor(definition, () => previewMonitorReview(id, { draft, version: detail!.version }));
  await inMonitor(definition, () => submitMonitorReview(id, { draft, version: detail!.version,
    previewToken: preview!.previewToken, reason: "核对原文后修正自动排除" }, "testai-reviewer"));
  assert.equal((await inMonitor(definition, () => resetsSnapshot())).events.length, 1);
  const corrected = await inMonitor(definition, () => monitorPostDetail(id));
  assert.deepEqual(corrected!.originalRecognition.modelResult, rec);
  assert.equal(corrected!.history.length, 1);
});
