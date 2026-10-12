import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import type { Timestamp } from "@aihot/contracts/admin";
import type { AdminMonitorEvent, AdminMonitorPostDetail, ResetMonitorBonusCredit, ResetMonitorEvent, ResetMonitorPresentationStatus, ResetMonitorSitePage } from "../../../modules/reset-monitor/contracts.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

const today = "2026-10-10";
const at = "2026-10-10T08:00:00+08:00";
const id = "cloud-bonus";
const source = "Claim the one time bonus credit for cloud sessions.";
const bonus: ResetMonitorBonusCredit = { amount: null, eligibility: "Pro or Max plan on Sept 23", claimMethod: "/claim-credit in Claude Code",
  usageTerms: "One credit per account, for cloud sessions only. GitHub must be connected to start a session.",
  claimDeadline: { source: "Oct 11 at 11:59pm PT", at: "2026-10-12T14:59:00+08:00" }, expiresAt: { source: "expires Nov 4", at: null } };
let status: ResetMonitorPresentationStatus = "available";
const writes: Array<{ path: string; body: any }> = [];
let web: WebServer;
let browser: Browser;

function event(): ResetMonitorEvent {
  return { id, type: "bonus_credit", label: "奖励额度", displayLabel: "一次性云会话奖励额度", status: "confirmed", title: "一次性云会话奖励额度",
    presentation: { status, scopeKnown: true, scopeLabel: "Pro, Max", kindExplicit: true, timeInferred: false, audienceZh: "符合条件的 Pro、Max 用户", productsZh: "Claude Code 云会话", bonusCredit: bonus },
    estimate: null, scope: "Pro, Max", createdAt: at, updatedAt: at, confirmedAt: at, occurredOn: null, confirmationBasis: "source_post", schedule: null,
    posts: [{ id, author: "ClaudeDevs", authorAvatar: null, publishedAt: at, stage: "活动开放", text: "符合条件的用户可以领取云会话奖励额度。", originalText: source, fullText: null, fullOriginalText: null, context: [], url: "https://example.org/bonus" }], url: "https://example.org/bonus" };
}
function adminEvent(): AdminMonitorEvent {
  const e = event();
  return { id, type: e.type, status: e.status, label: e.label, display_label: e.displayLabel, scope: e.scope, schedule: null, estimate: null,
    presentation: e.presentation, confirmed_at: at as Timestamp, occurred_on: null, confirmation_basis: "source_post", withdrawn: false,
    created_at: at as Timestamp, updated_at: at as Timestamp, posts: [], canReceiptReview: true };
}
const api = createServer(async (req, res) => {
  const path = new URL(req.url!, "http://fixture").pathname;
  res.setHeader("Content-Type", "application/json");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (path === "/api/admin/me") return send({ name: "Fixture admin", csrf: "fixture-csrf", dev: true });
  if (["/api/admin/nav-counts", "/api/site/meta", "/api/health"].includes(path)) return send({});
  if (path === "/api/site/track") { res.statusCode = 204; return res.end(); }
  if (path === "/api/site/claude-reset") {
    const data: ResetMonitorSitePage = { schemaVersion: 1, timezone: "Asia/Shanghai", today, checkedAt: at, historyFrom: at, count: 1, events: [event()], monitor: null, outage: null,
      scanMinutes: 15, current: null, lastLanded: null, authorAvatar: null, activeBonuses: status === "available" ? [event()] : [],
      stats: { resets90: 0, credits90: 0, bonuses90: 1, medianIntervalDays: null, lastResetDate: null },
      calendar: [{ date: today, eventId: id, type: "bonus_credit", state: "confirmed", label: "奖励活动" },
        { date: "2026-10-12", eventId: id, type: "bonus_credit", state: "pending", label: "领取截止", milestone: "claim_deadline" }], confirmMinutes: [], version: "bonus-v1", selectedDate: today };
    return send(data);
  }
  if (path === "/api/site/claude-reset/version") return send({ today, version: "bonus-v1", checkedAt: at });
  if (path.startsWith("/api/site/claude-reset/days/")) return send({ date: path.split("/").at(-1), version: "bonus-v1", events: [event()] });
  if (req.method === "POST" || req.method === "PATCH") {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    writes.push({ path, body });
    return send(req.method === "PATCH" ? adminEvent() : { postId: id, version: "v1", previewToken: "bonus-preview", decision: body.draft.decision,
      changes: [{ eventId: id, before: null, after: adminEvent() }], removedLinks: [], addedLinks: [id], outageChanges: [] });
  }
  if (path === "/api/admin/claude-reset/events" || path === "/api/admin/claude-reset/events/options") return send({ page: 1, pageSize: 10, total: 1, totalPages: 1, events: [adminEvent()] });
  if (path === `/api/admin/claude-reset/posts/${id}`) {
    const detail: AdminMonitorPostDetail = { post: { id, author: "ClaudeDevs", text: source, published_at: at as Timestamp, url: "https://example.org/bonus", translation: null, processed_at: null, receipt_id: null, origin: "live", propositions: null, needs_review: true, held: null, skipped: null, relevant: true, outage: null, links: [] },
      context: [], originalRecognition: null, history: [], version: "v1", draft: { decision: "related", translationZh: null, contextZh: [], outage: null, propositions: [] } };
    return send(detail);
  }
  if (path === "/api/admin/claude-reset/posts") return send({ page: 1, pageSize: 10, total: 0, totalPages: 0, filter: "relevant", rows: [] });
  res.statusCode = 404; send({ code: "not_found" });
});
before(async () => { web = await startWebServer(api); browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close(); await web?.stop(); });

test("reward details, distinct times and milestone calendar do not describe a reset or personal receipt", async () => {
  status = "available";
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/claude-reset`);
    await expect(page.getByRole("heading", { level: 1, name: "Claude 额度动态", exact: true })).toBeVisible();
    const active = page.locator('section[aria-labelledby="bonus-title"]');
    await expect(active.getByText("活动可领取", { exact: true })).toBeVisible();
    await expect(active.getByText("Pro or Max plan on Sept 23", { exact: true })).toBeVisible();
    await expect(active.getByText("/claim-credit in Claude Code", { exact: true })).toBeVisible();
    await expect(active.getByText(bonus.usageTerms!, { exact: true })).toBeVisible();
    await expect(active.getByText("Oct 11 at 11:59pm PT · 北京时间 10/12 14:59", { exact: true })).toBeVisible();
    await expect(active.getByText("expires Nov 4 · 时间未说明", { exact: true })).toBeVisible();
    assert.doesNotMatch(await active.innerText(), /到账|发卡|预计|已完成|恢复满额/);
    await expect(page.getByText("近 90 天奖励活动", { exact: true })).toBeVisible();
    await page.locator('[data-day="2026-10-12"]').click();
    await expect(page.getByText("领取截止日", { exact: true })).toBeVisible();
    assert.doesNotMatch(await page.locator("aside[aria-live]").innerText(), /到账|预计|重置卡发放/);
    for (const [next, label] of [["claim_closed", "领取已截止"], ["expired", "奖励已到期"]] as const) {
      status = next;
      await page.reload();
      await expect(page.locator("aside[aria-live]").getByText(label, { exact: true })).toBeVisible();
      await expect(active).toHaveCount(0);
    }
  } finally { await page.close(); }
});

test("Claude admin bonus editing preserves raw times and permits unknown instants", async () => {
  status = "available";
  writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/claude-reset`);
    await expect(page.getByRole("button", { name: "回执核对确认" })).toHaveCount(0);
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByLabel("类型", { exact: true }).locator('option[value="bonus_credit"]')).toHaveCount(1);
    await page.getByLabel("奖励金额或用量（原话）", { exact: true }).fill("one time bonus credit");
    await page.getByLabel("使用细则（原话）", { exact: true }).fill("Cloud sessions spend this credit first.");
    await page.getByLabel("领取截止（北京时间）", { exact: true }).fill("");
    await page.getByPlaceholder("为什么做这个改动", { exact: true }).fill("保留官方原话，不猜测时间");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    assert.equal(writes[0]!.body.patch.bonusCredit.amount, "one time bonus credit");
    assert.equal(writes[0]!.body.patch.bonusCredit.usageTerms, "Cloud sessions spend this credit first.");
    assert.deepEqual(writes[0]!.body.patch.bonusCredit.claimDeadline, { source: bonus.claimDeadline!.source, at: null });
    assert.equal(writes[0]!.body.patch.bonusCredit.expiresAt.at, null);
  } finally { await page.close(); }
});

test("manual reward review uses one activity, independent times and a preview token", async () => {
  writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/claude-reset/posts/${id}/review`);
    await page.getByLabel("分类", { exact: true }).selectOption("events");
    await page.getByLabel("类型", { exact: true }).selectOption("bonus_credit");
    await page.getByLabel("动作", { exact: true }).selectOption("confirm");
    await expect(page.getByLabel("次数", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("实际生效日", { exact: true })).toHaveCount(0);
    await page.getByLabel("资格条件（原话）", { exact: true }).fill(bonus.eligibility!);
    await page.getByLabel("领取方式（原话）", { exact: true }).fill(bonus.claimMethod!);
    await page.getByLabel("使用细则（原话）", { exact: true }).fill(bonus.usageTerms!);
    await page.getByLabel("领取截止（原话）", { exact: true }).fill(bonus.claimDeadline!.source);
    await page.getByLabel("领取截止（北京时间）", { exact: true }).fill("2026-10-12T14:59");
    await page.getByLabel("奖励到期（原话）", { exact: true }).fill("expires Nov 4");
    await page.getByRole("button", { name: "预览影响", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认提交复核" })).toBeDisabled();
    await page.getByLabel("复核理由", { exact: false }).fill("云会话奖励独立于重置次数");
    await page.getByRole("button", { name: "确认提交复核" }).click();
    await expect(page).toHaveURL(/\/admin\/claude-reset\?tab=posts$/);
    assert.equal(writes.length, 2);
    const proposition = writes[1]!.body.draft.propositions[0];
    assert.equal(proposition.kind, "bonus_credit");
    assert.equal(proposition.count, 1);
    assert.equal(proposition.schedule, null);
    assert.equal(proposition.occurredOn, null);
    assert.deepEqual(proposition.bonusCredit, bonus);
    assert.equal(writes[1]!.body.previewToken, "bonus-preview");
  } finally { await page.close(); }
});
