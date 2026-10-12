import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { modulePublication } from "@aihot/backend/publication/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../../../apps/api/src/app.ts";
import { inMonitor, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { createMonitorServer, monitorNames } from "../server.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { resetPage, resetVersion, resetsRecent } from "../backend/read.ts";
import { siteResetMonitorPage } from "../backend/publication.ts";
import { monitorAnswer } from "../backend/agent.ts";
import { listMonitorEvents, reviewReceipt, updateMonitorEvent } from "../backend/admin.ts";
import { monitorPostDetail, previewMonitorReview, submitMonitorReview } from "../backend/manual-review.ts";
import { flushResetPushes, openEvents } from "../backend/scan.ts";
import { applyRecognition } from "../backend/assemble.ts";
import type { Recognition } from "../backend/recognize.ts";
import type { AdminMonitorReviewDraft, ResetMonitorPageData } from "../contracts.ts";

const now = Date.parse("2026-10-10T12:00:00+08:00");
const source = "Pro and Max users can claim a one-time cloud session bonus. Run /claim-credit by Oct 12 at 11:59pm PT. Credits expire Nov 4.";
const bonus = { amount: "one-time cloud session bonus", eligibility: "Pro and Max users", claimMethod: "/claim-credit",
  usageTerms: "One credit per account; cloud sessions only; connect GitHub to start a session.",
  claimDeadline: { source: "Oct 12 at 11:59pm PT", at: "2026-10-13T14:59:00+08:00" }, expiresAt: { source: "Nov 4", at: null } };
const third: ResetMonitorBackendDefinition = { ...claude, monitorId: "testbonus", moduleName: "testbonus-reset", product: "TestBonus", authors: [{ handle: "TestBonus", name: "TestBonus" }], authorName: "TestBonus", title: "TestBonus 额度动态",
  pagePath: "/testbonus-reset", adminPath: "/admin/testbonus-reset", adminApiPath: "/api/admin/testbonus-reset", siteApiPath: "/api/site/testbonus-reset",
  publicApiPath: "/api/v1/testbonus-resets", agentPath: "/testbonus-resets", mcpTool: "get_testbonus_resets", names: monitorNames("testbonus") };

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

async function addPost(definition: ResetMonitorBackendDefinition, id: string, at: number) {
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,recognition) VALUES
    (${definition.monitorId},${id},${definition.authors[0]!.handle},${new Date(at)},${source},${`https://x.com/${definition.authors[0]!.handle}/status/${id}`},'{"modelResult":{"immutable":true}}')`;
}
function draft(): AdminMonitorReviewDraft {
  return { decision: "events", translationZh: "一次性云会话奖励", contextZh: [], outage: null, propositions: [{ kind: "bonus_credit", kindExplicit: true,
    action: "confirm", count: 1, excerpt: source, excerptZh: "一次性云会话奖励", targetEventId: null, scope: { plans: ["Pro", "Max"], audienceSource: "Pro and Max users", audienceZh: "Pro 和 Max 用户", productsZh: "云会话" },
    schedule: null, occurredOn: null, bonusCredit: structuredClone(bonus) }] };
}
async function review(definition: ResetMonitorBackendDefinition, id: string, input = draft()) {
  return inMonitor(definition, async () => {
    const detail = (await monitorPostDetail(id))!;
    const preview = (await previewMonitorReview(id, { draft: input, version: detail.version }))!;
    return submitMonitorReview(id, { draft: input, version: detail.version, previewToken: preview.previewToken, reason: "核对奖励活动" }, "bonus-reviewer");
  });
}

test("bonus availability, calendar milestones and counts remain separate from reset completion", async () => {
  await addPost(claude, "bonus-old", now - 20 * 86400_000);
  await review(claude, "bonus-old");
  const page = await inMonitor(claude, () => resetPage(now));
  assert.equal(page.stats.bonuses90, 1);
  assert.equal(page.stats.resets90, 0);
  assert.equal(page.stats.credits90, 0);
  assert.equal(page.current, null);
  assert.equal(page.lastLanded, null);
  assert.deepEqual(page.confirmMinutes, []);
  assert.equal(page.events[0]!.presentation!.status, "available");
  assert.equal(page.events[0]!.estimate, null);
  assert.equal(page.calendar.filter((m) => m.milestone === "claim_deadline").length, 1);
  assert.equal(page.calendar.filter((m) => m.milestone === "expiry").length, 0, "date without timezone cannot become midnight");
  assert.equal(siteResetMonitorPage(page).events.length, 0);
  assert.equal(siteResetMonitorPage(page).activeBonuses!.length, 1);
  assert.equal((await inMonitor(claude, () => resetsRecent(now))).events.length, 1, "an old currently available campaign stays in recent API");
  const candidates = await inMonitor(claude, () => openEvents(new Date(now), []));
  assert.equal(candidates.length, 1, "the old active campaign stays available to reminder recognition");
  assert.deepEqual(candidates[0]!.bonusCredit, bonus);
  assert.match(inMonitor(claude, () => monitorAnswer(page, now)), /不表示个人已领取或到账/);
  assert.match(inMonitor(claude, () => monitorAnswer(page, now)), /Nov 4；时间未说明/);
  assert.equal(page.events[0]!.presentation!.bonusCredit!.usageTerms, bonus.usageTerms);
  assert.match(inMonitor(claude, () => monitorAnswer(page, now)), /使用细则：One credit per account/);
  const deadline = Date.parse(bonus.claimDeadline.at);
  const [before, afterDeadline] = await Promise.all([inMonitor(claude, () => resetVersion(deadline - 1)), inMonitor(claude, () => resetVersion(deadline))]);
  assert.notEqual(before.version, afterDeadline.version);
  assert.equal((await inMonitor(claude, () => resetPage(deadline))).events[0]!.presentation!.status, "claim_closed");
  assert.equal((await inMonitor(claude, () => openEvents(new Date(deadline + 3 * 86400_000), []))).length, 0);
  await sql`UPDATE monitor_events SET confirmation_basis=NULL WHERE monitor_id='claude'`;
  const unknown = await inMonitor(claude, () => resetPage(now));
  assert.equal(unknown.events[0]!.presentation!.status, "announced");
  assert.match(unknown.events[0]!.title, /依据待核实/);
  assert.equal(unknown.stats.bonuses90, 0);
  assert.equal(unknown.calendar[0]!.label, "奖励待核实");
});

test("admin corrections and repeated manual reviews preserve bonus facts and immutable model evidence", async () => {
  await addPost(claude, "bonus-edit", now);
  const malformed = draft();
  malformed.propositions[0]!.bonusCredit!.claimDeadline!.at = "missing-timezone";
  await assert.rejects(review(claude, "bonus-edit", malformed), /datetime/);
  await review(claude, "bonus-edit");
  let detail = (await inMonitor(claude, () => monitorPostDetail("bonus-edit")))!;
  const id = detail.draft.propositions[0]!.targetEventId!;
  const event = (await inMonitor(claude, () => listMonitorEvents())).events[0]!;
  assert.equal(event.canReceiptReview, false);
  await assert.rejects(inMonitor(claude, () => reviewReceipt(id, { version: new Date(event.updated_at).toISOString(), reason: "个人回执不能证明活动" }, "bonus-reviewer")), /不支持账户回执/);
  const edited = { ...bonus, claimDeadline: { ...bonus.claimDeadline, at: "2026-10-13T14:59:00.000+08:00" }, expiresAt: { source: "Nov 4 at 11:59pm PT", at: "2026-11-05T15:59:00.000+08:00" } };
  await inMonitor(claude, () => updateMonitorEvent(id, { version: new Date(event.updated_at).toISOString(), reason: "核对奖励到期", patch: { bonusCredit: edited } }, "bonus-reviewer"));
  detail = (await inMonitor(claude, () => monitorPostDetail("bonus-edit")))!;
  const preview = (await inMonitor(claude, () => previewMonitorReview("bonus-edit", { draft: detail.draft, version: detail.version })))!;
  await inMonitor(claude, () => submitMonitorReview("bonus-edit", { draft: detail.draft, version: detail.version, previewToken: preview.previewToken, reason: "保持奖励条件" }, "bonus-reviewer"));
  const page = await inMonitor(claude, () => resetPage(Date.parse(edited.expiresAt.at)));
  assert.equal(page.events[0]!.presentation!.status, "expired");
  assert.deepEqual(page.events[0]!.presentation!.bonusCredit, edited);
  assert.equal(page.calendar.filter((m) => m.milestone === "expiry").length, 1);
  detail = (await inMonitor(claude, () => monitorPostDetail("bonus-edit")))!;
  assert.deepEqual(detail.originalRecognition.modelResult, { immutable: true });
  assert.equal(detail.history.length, 2);
});

test("Codex supports bonus review while a third monitor reuses public and notification behavior", async () => {
  await addPost(codex, "supported", now);
  await review(codex, "supported");
  assert.equal((await inMonitor(codex, () => listMonitorEvents())).events[0]!.type, "bonus_credit");
  await sql`INSERT INTO monitor_events (monitor_id,id,type,status,title,label,display_label,scope,created_at,updated_at) VALUES ('codex','codex-edit','direct_reset','announced','','全员重置','额度重置','Pro',${new Date(now)},${new Date(now)})`;
  const codexEvent = (await inMonitor(codex, () => listMonitorEvents())).events.find(e => e.id === "codex-edit")!;
  await inMonitor(codex, () => updateMonitorEvent(codexEvent.id, { patch: { type: "bonus_credit" }, version: new Date(codexEvent.updated_at).toISOString(), reason: "补齐无既有证据的事件类型" }, "reviewer"));
  assert.equal((await inMonitor(codex, () => listMonitorEvents())).events.find(e => e.id === codexEvent.id)!.type, "bonus_credit");
  const realNow = Date.now();
  await addPost(third, "bonus-third", realNow);
  await review(third, "bonus-third");
  installModules([createMonitorServer(third)]);
  const [before] = await sql`SELECT count(*) AS n FROM receipts`;
  const publicPage = await modulePublication<ResetMonitorPageData>(third.moduleName, "agent");
  assert.equal(publicPage.stats.bonuses90, 1);
  const mcp = await createMonitorServer(third).agent!.abilities![0]!.mcp.run({});
  assert.match(mcp.text, /奖励额度/);
  assert.match(mcp.text, /不表示个人已领取或到账/);
  assert.match(mcp.text, /使用细则：One credit per account/);
  const app = await buildApp();
  try {
    for (const route of [third.publicApiPath, `${third.publicApiPath}/recent`]) {
      const response = await app.inject(route);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().events[0].type, "bonus_credit");
      assert.equal(response.json().events[0].presentation.bonusCredit.expiresAt.at, null);
      assert.equal(response.json().events[0].presentation.bonusCredit.usageTerms, bonus.usageTerms);
    }
    const agent = await app.inject(third.agentPath.replace(/^\//, "/api/v1/agent/"));
    assert.equal(agent.statusCode, 200);
    assert.match(agent.body, /奖励额度/);
    assert.match(agent.body, /使用细则：One credit per account/);
    const page = await app.inject(third.siteApiPath);
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().activeBonuses[0].type, "bonus_credit");
  } finally { await app.close(); }
  assert.equal((await sql`SELECT count(*) AS n FROM receipts`)[0]!.n, before!.n);
  const event = (await inMonitor(third, () => listMonitorEvents())).events[0]!;
  await sql`UPDATE monitor_posts SET recognition=recognition||${sql.json({ notify: [{ eventId: event.id, action: "confirm" }] })} WHERE monitor_id=${third.monitorId}`;
  await sql`INSERT INTO notify_targets (key,purpose,kind,enabled) VALUES ('bonus-log','content','log',true)`;
  await inMonitor(third, () => flushResetPushes());
  const [delivery] = await sql`SELECT payload,dedupe_key FROM deliveries WHERE target_key='bonus-log'`;
  assert.match(JSON.stringify(delivery!.payload), /活动可领取/);
  assert.match(JSON.stringify(delivery!.payload), /领取截止/);
  assert.doesNotMatch(JSON.stringify(delivery!.payload), /已完成|预计生效/);
  assert.match(delivery!.dedupe_key, /^testbonus:bonus-third:/);
  await inMonitor(third, () => flushResetPushes());
  assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key='bonus-log'`).length, 1);
  // The local log target skips network sends; simulate a group that received the original card.
  await sql`UPDATE deliveries SET status='sent' WHERE target_key='bonus-log'`;
  for (const action of ["amend", "withdraw"] as const) {
    const id = `bonus-${action}`;
    await addPost(third, id, realNow);
    await sql`UPDATE monitor_posts SET processed_at=now(),recognition=recognition||${sql.json({ notify: [{ eventId: event.id, action }] })} WHERE monitor_id=${third.monitorId} AND id=${id}`;
    if (action === "withdraw") await sql`UPDATE monitor_events SET withdrawn=true WHERE monitor_id=${third.monitorId} AND id=${event.id}`;
    await inMonitor(third, () => flushResetPushes());
    const [sent] = await sql`SELECT payload FROM deliveries WHERE target_key='bonus-log' AND dedupe_key LIKE ${`testbonus:${id}:%`}`;
    assert.ok(sent, "a previously notified bonus can send an amendment or withdrawal");
    assert.match(JSON.stringify(sent.payload), action === "amend" ? /条件有更新/ : /活动.*撤回/);
    assert.doesNotMatch(JSON.stringify(sent.payload), /重置已完成|精确到账时间/);
  }
});

test("a manual correction from bonus to reset does not reuse campaign confirmation as reset completion", async () => {
  await addPost(claude, "bonus-original", now - 1000);
  await review(claude, "bonus-original");
  const event = (await inMonitor(claude, () => listMonitorEvents())).events[0]!;
  await assert.rejects(inMonitor(claude, () => updateMonitorEvent(event.id, { patch: { type: "direct_reset" }, version: new Date(event.updated_at).toISOString(), reason: "确认依据需要复核" }, "reviewer")), /通过帖子复核/);
  const resetWords = "We will reset weekly usage for Max.";
  await addPost(claude, "reset-correction", now);
  await sql`UPDATE monitor_posts SET text=${resetWords} WHERE monitor_id='claude' AND id='reset-correction'`;
  const input = draft();
  input.propositions[0] = { ...input.propositions[0]!, kind: "direct_reset", action: "amend", excerpt: resetWords, excerptZh: "将重置 Max 周额度", targetEventId: event.id, overrideEventFields: true,
    bonusCredit: undefined, scope: { plans: ["Max"], audienceSource: "Max", audienceZh: "Max 用户", productsZh: "周额度" } };
  await review(claude, "reset-correction", input);
  const after = (await inMonitor(claude, () => listMonitorEvents())).events[0]!;
  assert.equal(after.type, "direct_reset");
  assert.equal(after.status, "announced");
  assert.equal(after.confirmation_basis, null);
  assert.equal(after.confirmed_at, null);
  assert.equal(after.presentation!.bonusCredit, undefined);
  assert.equal(after.presentation!.manualPatch.bonusCredit, undefined);
});

test("a third product enables automatic bonus recognition using only its definition", async () => {
  const definition = { ...third, excludeProposition: undefined };
  const text = "We have granted a one-time bonus credit for TestBonus users.";
  await addPost(definition, "third-auto", now);
  await sql`UPDATE monitor_posts SET text=${text} WHERE monitor_id=${definition.monitorId} AND id='third-auto'`;
  const rec: Recognition = { relevant: true, translationZh: "TestBonus 奖励活动", contextZh: [], outage: null, needsReview: false,
    model: "offline", promptVersion: "test", receiptId: 0, propositions: [{ kind: "bonus_credit", kindExplicit: true, action: "confirm", real: true, count: 1,
      excerpt: text, excerptZh: "TestBonus 已开放奖励", relatesTo: null, statedTime: null, timeInferred: false, expectedLanding: null,
      scope: { audienceSource: "TestBonus users", plans: null, audienceZh: "TestBonus 用户", productsZh: "TestBonus" },
      bonusCredit: { amount: null, eligibility: "TestBonus users", claimMethod: null, claimDeadline: null, expiresAt: null } }] };
  const applied = await inMonitor(definition, () => applyRecognition("third-auto", rec));
  assert.equal(applied.eventIds.length, 1);
  const page = await inMonitor(definition, () => resetPage(now));
  assert.equal(page.stats.bonuses90, 1);
  assert.equal(page.events[0]!.presentation!.status, "available");
  assert.equal(page.events[0]!.type, "bonus_credit");
  assert.equal((await inMonitor(claude, () => resetPage(now))).count, 0);
  await addPost(codex, "codex-auto", now);
  await sql`UPDATE monitor_posts SET text=${text} WHERE monitor_id='codex' AND id='codex-auto'`;
  const codexResult = await inMonitor(codex, () => applyRecognition("codex-auto", structuredClone(rec)));
  assert.equal(codexResult.eventIds.length, 1);
  const [saved] = await sql`SELECT recognition FROM monitor_posts WHERE monitor_id='codex' AND id='codex-auto'`;
  assert.equal(saved!.recognition.relevant, true);
  assert.deepEqual(saved!.recognition.modelResult, rec);
});

test("recorded quota cycles reach the site, HTTP, Agent and MCP through one public projection", async () => {
  const at = new Date();
  const presentation = { scopeKnown: true, scopeLabel: "all users", kindExplicit: true, timeInferred: false,
    audienceZh: "所有用户", productsZh: null, quotaScope: "five_hour+weekly", reportedAt: at.toISOString() };
  await sql`INSERT INTO monitor_events (monitor_id,id,type,status,title,label,display_label,scope,presentation,confirmed_at,confirmation_basis,created_at,updated_at)
    VALUES ('claude','cycle-public','direct_reset','confirmed','额度重置','额度重置','额度重置','all users',${sql.json(presentation)},${at},'source_post',${at},${at})`;
  installModules([createMonitorServer(claude)]);
  const page = await modulePublication<ResetMonitorPageData>(claude.moduleName, "agent");
  assert.equal(page.events[0]!.presentation!.quotaScope, "five_hour+weekly");
  assert.match(inMonitor(claude, () => monitorAnswer(page, at.getTime())), /适用范围：所有用户 · 五小时及周额度/);
  const app = await buildApp();
  try {
    for (const path of [claude.publicApiPath, `${claude.publicApiPath}/recent`]) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().events[0].presentation.quotaScope, "five_hour+weekly");
    }
    const site = await app.inject(claude.siteApiPath);
    assert.equal(site.json().events[0].presentation.quotaScope, "five_hour+weekly");
    const agent = await app.inject(claude.agentPath.replace(/^\//, "/api/v1/agent/"));
    assert.match(agent.body, /适用范围：所有用户 · 五小时及周额度/);
    const mcp = await createMonitorServer(claude).agent!.abilities![0]!.mcp.run({});
    assert.match(mcp.text, /适用范围：所有用户 · 五小时及周额度/);
  } finally { await app.close(); }
});
