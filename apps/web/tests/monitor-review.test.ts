import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import type { AdminMonitorEvent, AdminMonitorPost, AdminMonitorReviewDraft } from "../../../modules/codex-reset/contracts.ts";
import type { Timestamp } from "@aihot/contracts/admin";
import { startWebServer, type WebServer } from "./web-server.ts";

const at = "2026-10-09T08:00:00.000Z" as Timestamp;
const meta = { page: 1, pageSize: 10, total: 11, totalPages: 2 };
const post: AdminMonitorPost = { id: "manual-fixture", author: "thsottiaux", published_at: at, text: "All reset for everyone.", url: "https://example.org/post", translation: null,
  processed_at: null, receipt_id: null, origin: "live", propositions: null, needs_review: false, held: null, skipped: null,
  relevant: null, outage: null, links: [] };
const event = (id: string, canReceiptReview = false): AdminMonitorEvent => ({ id, type: "direct_reset", status: canReceiptReview ? "announced" : "confirmed",
  label: "额度重置", display_label: "额度重置", scope: "Plus", schedule: null, estimate: null, presentation: { kindExplicit: true }, confirmed_at: canReceiptReview ? null : at,
  occurred_on: null, confirmation_basis: canReceiptReview ? null : "source_post", withdrawn: false, created_at: at, updated_at: at, posts: [], canReceiptReview });
const draft: AdminMonitorReviewDraft = { decision: "related", translationZh: null, contextZh: [], outage: null, propositions: [] };
const writes: Array<{ path: string; body: any; csrf?: string }> = [];
let web: WebServer;
let browser: Browser;
let manualReviewFixture = false;
const api = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("Content-Type", "application/json");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/admin/me") return send({ name: "Fixture admin", csrf: "fixture-csrf", dev: true });
  if (url.pathname === "/api/admin/nav-counts" || url.pathname === "/api/site/meta") return send({});
  if (req.method === "POST") {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    writes.push({ path: url.pathname, body, csrf: req.headers["x-csrf-token"] as string });
    return send({ postId: post.id, version: "v1", previewToken: "preview-fixture", decision: body.draft.decision,
      changes: body.draft.decision === "events" ? [{ eventId: "outside-first-page", before: event("outside-first-page"), after: event("outside-first-page") }] : [], removedLinks: [], addedLinks: [] });
  }
  if (url.pathname === "/api/admin/monitor/events/options") return send({ ...meta, page: Number(url.searchParams.get("page") ?? 1), events: [event("outside-first-page")] });
  if (url.pathname === "/api/admin/monitor/events") return send(url.searchParams.get("filter") === "receipt_review"
    ? { ...meta, total:1, totalPages:1, events:[event("announced",true)] }
    : { ...meta, events: [event("confirmed"), event("announced", true)] });
  if (url.pathname === "/api/admin/monitor/posts") {
    const filter = url.searchParams.get("filter") ?? "relevant";
    const rows: AdminMonitorPost[] = manualReviewFixture ? [false, true].map(completed => ({ ...post, id: completed ? "review-complete" : "review-held", text: completed ? "Completed review fixture" : "Held review fixture",
      needs_review: !completed, manual_review: { completed, by: "Fixture admin", at: String(at), reason: completed ? "依据完整，人工复核完成" : "时间依据冲突，继续复核", decision: "events" } })) : [post];
    return send({ ...meta, filter, rows: manualReviewFixture && filter === "review" ? rows.filter(row => row.needs_review) : rows });
  }
  if (url.pathname === `/api/admin/monitor/posts/${post.id}`) return send({ post, context: [], originalRecognition: null, history: [], version: "v1", draft });
  res.statusCode = 404;
  send({ code: "not_found" });
});
before(async () => {
  web = await startWebServer(api);
  browser = await chromium.launch({ channel: "chromium" });
});
after(async () => { await browser?.close(); await web?.stop(); });

test("both lists expose totals, unrelated filter and confirmation gate", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/monitor`);
    await expect(page.getByText("共 11 条 · 第 1 / 2 页")).toBeVisible();
    await expect(page.getByRole("button", { name: "回执核对确认" })).toHaveCount(1);
    await page.getByRole("link", { name: "下一页", exact:true }).click();
    await expect(page).toHaveURL(/page=2/);
    await page.getByRole("link", { name: "需回执核对", exact:true }).click();
    await expect(page).toHaveURL(/filter=receipt_review/);
    assert.equal(new URL(page.url()).searchParams.has("page"), false);
    await expect(page.getByText("共 1 条 · 第 1 / 1 页")).toBeVisible();
    await expect(page.getByRole("button", { name:"回执核对确认" })).toHaveCount(1);
    await expect(page.getByText("已确认", { exact:true })).toHaveCount(0);
    await page.getByRole("link", { name: "帖子与识别", exact: true }).click();
    await page.getByRole("link", { name: "无关", exact: true }).click();
    await expect(page).toHaveURL(/filter=unrelated/);
    await expect(page.getByRole("link", { name: "人工复核", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "标记已核实" })).toHaveCount(0);
    await expect(page.getByText("共 11 条 · 第 1 / 2 页")).toBeVisible();
  } finally { await page.close(); }
});

test("pending review previews before submitting and supports events outside the first page", async () => {
  writes.length = 0;
  const page = await browser.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  try {
    await page.goto(`${web.origin}/admin/monitor/posts/${post.id}/review`);
    await page.getByLabel("分类", { exact: true }).selectOption("events");
    await expect(page.getByLabel("类型", { exact: true }).locator('option[value="bonus_credit"]')).toHaveCount(1);
    await expect(page.getByLabel("关联目标事件").locator("option[value='outside-first-page']")).toHaveCount(1);
    await page.getByLabel("关联目标事件").selectOption("outside-first-page");
    await page.getByRole("button", { name: "预览影响", exact: true }).click();
    await expect(page.getByText("增加 0 个关联", { exact: false })).toBeVisible();
    assert.equal(writes.length, 1);
    assert.match(writes[0]!.path, /\/preview$/);
    await expect(page.getByRole("button", { name: "确认提交复核" })).toBeDisabled();
    await page.getByLabel("复核理由", { exact: false }).fill("原帖明确确认同一次重置");
    await page.getByRole("button", { name: "确认提交复核" }).click();
    await expect(page).toHaveURL(/\/admin\/monitor\?tab=posts$/);
    assert.equal(writes.length, 2);
    assert.equal(writes[1]!.body.previewToken, "preview-fixture");
    assert.equal(writes[1]!.body.draft.propositions[0].targetEventId, "outside-first-page");
    assert.equal(writes[1]!.csrf, "fixture-csrf");
  } catch (error) {
    throw new Error(`${String(error)}\nBrowser errors: ${browserErrors.join("; ")}\nPage: ${await page.locator("body").innerText()}\nServer: ${web.logs()}`, { cause: error });
  } finally { await page.close(); }
});

test("a held manual review stays pending while only a completed review has the completion badge", async () => {
  manualReviewFixture = true;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/monitor?tab=posts&filter=all`);
    const held = page.locator("article").filter({ hasText: "Held review fixture" });
    const complete = page.locator("article").filter({ hasText: "Completed review fixture" });
    await expect(held.getByText("需要复核", { exact: true })).toBeVisible();
    await expect(held.getByText("人工复核完成", { exact: true })).toHaveCount(0);
    await expect(complete.getByText("人工复核完成", { exact: true })).toBeVisible();
    await expect(complete.getByText("需要复核", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "需复核", exact: true }).click();
    await expect(page.getByText("Held review fixture", { exact: true })).toBeVisible();
    await expect(page.getByText("需要复核", { exact: true })).toBeVisible();
    await expect(page.getByText("人工复核完成", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Completed review fixture", { exact: true })).toHaveCount(0);
  } finally { manualReviewFixture = false; await page.close(); }
});
