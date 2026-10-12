import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import type { Timestamp } from "@aihot/contracts/admin";
import type { AdminMonitorEvent, AdminMonitorPost, AdminMonitorReviewDraft, ResetMonitorEvent, ResetMonitorSitePage } from "../../../modules/reset-monitor/contracts.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

const at = "2026-10-10T16:00:00+08:00";
const today = "2026-10-10";
const postId = "shared-post-id";
const eventId = "shared-event-id";
const pagination = { page: 1, pageSize: 10, total: 11, totalPages: 2 };
const sourceIssue = "X Article 正文未保存，无法判断文章是否包含额度事件";
const draft: AdminMonitorReviewDraft = { decision: "related", translationZh: null, contextZh: [], outage: null, propositions: [] };
const requests: string[] = [];
const writes: Array<{ path: string; body: any; csrf?: string }> = [];
let web: WebServer;
let browser: Browser;
let codexExplicitFixture = false;
let codexAmendedConfirmationFixture = false;

function publicEvent(product: string): ResetMonitorEvent {
  return {
    id: eventId, type: "direct_reset", label: "额度重置", displayLabel: "额度重置", status: "announced",
    presentation: { status: "announced", scopeKnown: true, scopeLabel: "Pro、Max", kindExplicit: true, timeInferred: false, audienceZh: "Pro、Max 用户", productsZh: product,
      ...(product === "Claude" ? { quotaScope: "five_hour+weekly" } : {}) },
    estimate: null, title: `${product} 额度重置`, scope: "Pro、Max", createdAt: at, updatedAt: at,
    confirmedAt: null, occurredOn: null, confirmationBasis: null, schedule: null,
    posts: [{ id: postId, author: product === "Codex" ? "thsottiaux" : product === "Grok" ? "bot" : "ClaudeDevs", authorAvatar: null, publishedAt: at, stage: "预告", text: "将重置五小时及周额度。", originalText: "We will reset five-hour and weekly limits.", fullText: null, fullOriginalText: null, context: [], url: "https://example.org/post" }],
    url: "https://example.org/post",
  };
}

function sitePage(product: string): ResetMonitorSitePage {
  const event = publicEvent(product);
  const bonus: ResetMonitorEvent = { ...event, id: "grok-reward", type: "bonus_credit", status: "confirmed", confirmedAt: at, confirmationBasis: "source_post",
    presentation: { ...event.presentation!, productsZh: "Grok 普通额度", status: "available", bonusCredit: { amount: "one-time bonus credits", eligibility: null, claimMethod: null, claimDeadline: null, expiresAt: null } },
    posts: [{ ...event.posts[0]!, id: "grok-post", author: "grok", text: "奖励额度现在可以领取。", url: "https://x.com/grok/status/grok-post" }] };
  if (product === "Codex" && codexExplicitFixture) {
    event.posts[0]!.author = "NewOfficial";
    event.presentation!.timePolicy = "explicit";
    event.schedule = { precision: "exact", from: "2026-10-10T18:00:00+08:00", through: "2026-10-10T18:00:00+08:00", label: "北京时间 18:00" };
    event.estimate = { from: "2026-10-11T08:00:00+08:00", through: "2026-10-11T12:00:00+08:00", basis: "author_habit", label: "旧预计窗口", reason: "不能向其他作者套用的惯例" };
    bonus.id = "codex-reward";
    bonus.presentation!.productsZh = "Codex";
    bonus.presentation!.timePolicy = "explicit";
    bonus.posts[0]!.author = "NewOfficial";
  }
  if (product === "Codex" && codexAmendedConfirmationFixture) {
    const confirmation = { ...event.posts[0]!, stage: "确认", text: "额度已重置。" };
    event.status = "confirmed";
    event.presentation!.status = "confirmed";
    event.confirmedAt = at;
    event.confirmationBasis = "source_post";
    event.posts = [{ ...confirmation, id: "amend-post", author: "NewOfficial", publishedAt: "2026-10-10T17:00:00+08:00", stage: "补充", text: "此次重置适用于 Pro、Max。" }, confirmation];
  }
  const hasBonus = product === "Grok" || (product === "Codex" && codexExplicitFixture);
  return {
    schemaVersion: 1, timezone: "Asia/Shanghai", today, checkedAt: at, historyFrom: "2026-10-09T00:00:00+08:00",
    count: hasBonus ? 2 : 1, events: hasBonus ? [event, bonus] : [event], monitor: product === "Codex" && codexExplicitFixture ? {
      status: "healthy", lastAttemptAt: at, lastCollectedAt: at, lastVerifiedAt: at, pendingCount: 0, reviewCount: 0,
      authors: [{ handle: "thsottiaux", name: "Tibo", collectedSince: null }, { handle: "NewOfficial", name: "New Official", collectedSince: at }], scopeEffectiveAt: at,
    } : null, outage: null, scanMinutes: 15, current: event, lastLanded: null,
    ...(hasBonus ? { activeBonuses: [bonus] } : {}),
    authorAvatar: null, stats: { resets90: 0, credits90: 0, bonuses90: 0, medianIntervalDays: null, lastResetDate: null },
    calendar: [today, "2026-10-09"].map(date => ({ date, eventId, type: "direct_reset", state: event.status === "confirmed" ? "confirmed" : "pending", label: event.status === "confirmed" ? "已确认重置" : "等待生效" })),
    confirmMinutes: [], version: `${product}-v1`, selectedDate: today,
  };
}

function adminPost(product: string): AdminMonitorPost {
  return { id: postId, author: product === "Codex" ? "thsottiaux" : product === "Grok" ? "bot" : "ClaudeDevs", published_at: at as Timestamp, text: `${product}: We will reset five-hour and weekly limits.`, url: "https://example.org/post", translation: null,
    processed_at: null, receipt_id: null, origin: "live", propositions: null, needs_review: true, held: null, skipped: null, relevant: null, outage: null, links: [], source_issue: sourceIssue };
}

function adminEvent(product: string): AdminMonitorEvent {
  return { id: eventId, type: "direct_reset", status: "announced", label: "额度重置", display_label: "额度重置", scope: `${product} Pro、Max`,
    schedule: null, estimate: null, presentation: { kindExplicit: true }, confirmed_at: null, occurred_on: null, confirmation_basis: null,
    withdrawn: false, created_at: at as Timestamp, updated_at: at as Timestamp, posts: [], canReceiptReview: true };
}

const api = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://fixture");
  const path = url.pathname;
  requests.push(req.url!);
  res.setHeader("Content-Type", "application/json");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (path === "/api/admin/me") return send({ name: "Fixture admin", csrf: "fixture-csrf", dev: true });
  if (path === "/api/admin/nav-counts" || path === "/api/site/meta" || path === "/api/health") return send({});
  if (path === "/api/site/track") { res.statusCode = 204; return res.end(); }
  for (const product of ["Codex", "Claude", "Grok"]) {
    const sitePath = `/api/site/${product.toLowerCase()}-reset`;
    const adminPath = product === "Codex" ? "/api/admin/monitor" : `/api/admin/${product.toLowerCase()}-reset`;
    if (path === sitePath) return send(sitePage(product));
    if (path === `${sitePath}/version`) return send({ version: `${product}-v1`, checkedAt: at, today });
    if (path.startsWith(`${sitePath}/days/`)) return send({ date: path.split("/").at(-1), version: `${product}-v1`, events: [publicEvent(product)] });
    if (req.method === "POST" && path.startsWith(`${adminPath}/posts/`)) {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      writes.push({ path, body, csrf: req.headers["x-csrf-token"] as string });
      return send({ postId, version: "v1", previewToken: `${product}-preview`, decision: body.draft.decision, changes: [], removedLinks: [], addedLinks: [] });
    }
    if (path === `${adminPath}/events/options`) return send({ ...pagination, events: [adminEvent(product)] });
    if (path === `${adminPath}/events`) return send({ ...pagination, page: Number(url.searchParams.get("page") ?? 1), events: [adminEvent(product)] });
    if (path === `${adminPath}/posts`) return send({ ...pagination, page: Number(url.searchParams.get("page") ?? 1), filter: url.searchParams.get("filter") ?? "relevant", rows: [adminPost(product)] });
    if (path === `${adminPath}/posts/${postId}`) return send({ post: adminPost(product), context: [], originalRecognition: null, history: [], version: "v1", draft });
  }
  res.statusCode = 404;
  send({ code: "not_found" });
});

test("Codex displays explicit author time, rewards and collection coverage independently of Tibo policy", async () => {
  codexExplicitFixture = true;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/codex-reset`);
    await expect(page.getByText("原帖时间 今天 18:00", { exact: true }).first()).toBeVisible();
    await expect(page.locator("article header strong").first()).toHaveText("New Official");
    await expect(page.getByText("监控账号：Tibo（@thsottiaux）、New Official（@NewOfficial）", { exact: true })).toBeVisible();
    await expect(page.getByText("奖励额度活动", { exact: true })).toBeVisible();
    await expect(page.getByText("活动可领取", { exact: true }).first()).toBeVisible();
    await page.getByText("监控正常", { exact: false }).click();
    await expect(page.getByText("@thsottiaux：历史采集起点未记录", { exact: true })).toBeVisible();
    await expect(page.getByText("@NewOfficial：2026-10-10 16:00 起采集，不包含此前历史", { exact: true })).toBeVisible();
    await expect(page.getByText("采集范围自 2026-10-10 16:00 生效，不自动补采此前历史", { exact: true })).toBeVisible();
    const text = await page.locator("body").innerText();
    assert.equal(text.includes("不能向其他作者套用的惯例"), false);
    assert.equal(text.includes("应已生效（按预计时间，未见确认帖）"), false);
    assert.equal(text.includes("预计 今天 18:00"), false);
    assert.ok(text.includes("额度重置、重置卡与奖励额度"));
  } finally { codexExplicitFixture = false; await page.close(); }
});

test("calendar keeps official confirmation and its time when another author adds the latest amendment", async () => {
  codexAmendedConfirmationFixture = true;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/codex-reset`);
    const calendar = page.locator('section[aria-labelledby="calendar-title"]');
    const detail = calendar.locator("aside");
    await expect(detail.getByText("官方已确认", { exact: true })).toBeVisible();
    await expect(detail.getByText("确认帖 10/10 16:00", { exact: false })).toBeVisible();
    await expect(calendar.locator(`[data-day="${today}"]`)).toHaveAttribute("aria-label", `${today}，今天，已确认重置`);
    await expect(detail.locator("article header small").first()).toHaveText("@NewOfficial");
    await expect(detail.getByText("@NewOfficial 已确认", { exact: true })).toHaveCount(0);
    await detail.getByRole("button", { name: "另有 1 条相关原帖", exact: false }).click();
    await expect(detail.locator("article header small").last()).toHaveText("@thsottiaux");
  } finally { codexAmendedConfirmationFixture = false; await page.close(); }
});

before(async () => {
  web = await startWebServer(api);
  browser = await chromium.launch({ channel: "chromium" });
});
after(async () => { await browser?.close(); await web?.stop(); });

test("Codex, Claude and Grok public pages bind their own identity, history and version reads", async () => {
  for (const product of ["Codex", "Claude", "Grok"]) {
    const page = await browser.newPage();
    const start = requests.length;
    const pagePath = `/${product.toLowerCase()}-reset`;
    const sitePath = `/api/site${pagePath}`;
    try {
      await page.goto(`${web.origin}${pagePath}`);
      const title = product === "Codex" ? "Codex 重置监控" : `${product} 额度动态`;
      await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
      await expect(page.getByText("时间未说明", { exact: true }).first()).toBeVisible();
      await expect(page.getByText(`适用范围：Pro、Max 用户 · ${product}${product === "Claude" ? " · 五小时及周额度" : ""}`, { exact: true }).first()).toBeVisible();
      await expect(page.locator("article header strong").first()).toHaveText(product === "Codex" ? "Tibo" : product === "Grok" ? "Grok Bot" : "ClaudeDevs");
      if (product === "Grok") {
        await expect(page.locator("article header strong").filter({ hasText: /^Grok$/ }).first()).toBeVisible();
        await expect(page.locator("article header small").filter({ hasText: /^@bot$/ }).first()).toBeVisible();
        await expect(page.locator("article header small").filter({ hasText: /^@grok$/ }).first()).toBeVisible();
      }
      if (product === "Claude") {
        assert.equal((await page.locator("body").innerText()).includes("Tibo"), false);
        await expect(page.getByText("应已生效（按预计时间，未见确认帖）", { exact: true })).toHaveCount(0);
        await page.getByText("时间与确认依据", { exact: true }).click();
        await expect(page.getByText("明确时间才换算。", { exact: true })).toBeVisible();
      }
      await page.locator('[data-day="2026-10-09"]').click();
      await expect.poll(() => requests.slice(start).some(path => path === `${sitePath}/days/2026-10-09`)).toBe(true);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect.poll(() => requests.slice(start).includes(`${sitePath}/version`)).toBe(true);
      const ownReads = requests.slice(start).filter(path => /^\/api\/site\/(?:codex|claude|grok)-reset/.test(path));
      assert.ok(ownReads.length >= 3);
      assert.ok(ownReads.every(path => path.startsWith(sitePath)), ownReads.join("\n"));
      const response = await fetch(`${web.origin}${pagePath}/history/2026-10-09`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(title));
    } finally { await page.close(); }
  }
});

for (const product of ["Claude", "Grok"]) test(`${product} admin pagination, event candidates and review commands stay on its HTTP scope`, async () => {
  const handle = product === "Grok" ? "bot" : "ClaudeDevs";
  const slug = product.toLowerCase();
  const page = await browser.newPage();
  const start = requests.length;
  const firstWrite = writes.length;
  try {
    await page.goto(`${web.origin}/admin/${slug}-reset`);
    await expect(page.getByText("共 11 条 · 第 1 / 2 页")).toBeVisible();
    await page.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(page.getByText("共 11 条 · 第 2 / 2 页")).toBeVisible();
    await page.getByRole("link", { name: "帖子与识别", exact: true }).click();
    await expect(page.getByText(`资料不完整：${sourceIssue}`, { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "人工复核", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/${slug}-reset/posts/${postId}/review$`));
    await expect(page.getByText(`资料不完整：${sourceIssue}`, { exact: true })).toBeVisible();
    await page.getByLabel("分类", { exact: true }).selectOption("events");
    await expect(page.getByLabel("关联目标事件").locator(`option[value='${eventId}']`)).toHaveCount(1);
    await page.getByLabel("关联目标事件").selectOption(eventId);
    await page.getByRole("button", { name: "预览影响", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认提交复核" })).toBeDisabled();
    await page.getByLabel("复核理由", { exact: false }).fill(`核对 ${product} 的原帖及适用范围`);
    await page.getByRole("button", { name: "确认提交复核" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/${slug}-reset\\?tab=posts$`));
    await expect(page.getByText(`@${handle}`, { exact: true })).toBeVisible();
    const ownWrites = writes.slice(firstWrite);
    assert.equal(ownWrites.length, 2);
    assert.equal(ownWrites[0]!.path, `/api/admin/${slug}-reset/posts/${postId}/review/preview`);
    assert.equal(ownWrites[1]!.path, `/api/admin/${slug}-reset/posts/${postId}/review`);
    assert.equal(ownWrites[1]!.body.previewToken, `${product}-preview`);
    assert.equal(ownWrites[1]!.body.draft.propositions[0].targetEventId, eventId);
    assert.equal(ownWrites[1]!.csrf, "fixture-csrf");
    assert.ok(!requests.slice(start).some(path => path.startsWith("/api/admin/monitor")));
  } catch (error) {
    throw new Error(`${String(error)}\nPage: ${await page.locator("body").innerText()}\nServer: ${web.logs()}`, { cause: error });
  } finally { await page.close(); }
});
