import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { createMonitorFixture, platforms } from "./fixtures/reset-monitor.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

const fixture = createMonitorFixture();
let browser: Browser, web: WebServer;
before(async () => { web = await startWebServer(fixture.api); browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close(); await web?.stop(); });
beforeEach(() => { fixture.createdPosts.length = 0; fixture.postEditorial.clear(); fixture.writes.length = 0; fixture.state.previewConflict = false; fixture.state.processingStatus = "needs_attention"; });
const createDialog = (page: Page) => page.getByRole("dialog", { name: "创建帖子", exact: true });
const editDialog = (page: Page) => page.getByRole("dialog", { name: "编辑帖子", exact: true });
async function fillNew(page: Page, title: string) {
  const dialog = createDialog(page);
  await dialog.getByLabel("发布时间（北京时间）", { exact: true }).fill("2026-10-23T08:30");
  await dialog.getByLabel("原帖链接", { exact: true }).fill("https://x.com/i/status/1234567890123456789");
  await dialog.getByLabel("标题（中文）", { exact: true }).fill(title);
  await dialog.getByLabel("摘要（中文）", { exact: true }).fill("管理员录入的来源摘要");
  await dialog.getByLabel("原文", { exact: true }).fill("Private original source text");
}

for (const product of platforms) test(`${product.product}: post association filter combines dates, resets pagination and preserves paging filters`, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${web.origin}${product.admin}?kind=posts&page=2`);
    await page.getByLabel("开始日期", { exact: true }).fill("2026-10-23");
    await page.getByLabel("结束日期", { exact: true }).fill("2026-10-23");
    await page.getByLabel("关联状态", { exact: true }).selectOption("linked");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page).toHaveURL(/association=linked/);
    assert.equal(new URL(page.url()).searchParams.has("page"), false);
    await expect(page.locator('[data-monitor-post="post-1"]')).toBeVisible();
    await expect(page.locator('[data-monitor-post="post-3"]')).toHaveCount(0);
    assert.ok(fixture.requests.some(path => path.startsWith(product.api + "/posts?") && path.includes("association=linked") && path.includes("from=2026-10-23")));
    await page.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByLabel("关联状态", { exact: true })).toHaveValue("linked");
    assert.equal(new URL(page.url()).searchParams.get("from"), "2026-10-23");
    await page.getByLabel("关联状态", { exact: true }).selectOption("unlinked");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.locator('[data-monitor-post="post-1"]')).toHaveCount(0);
    await expect(page.locator('[data-monitor-post="post-3"]')).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole("link", { name: "重置", exact: true }).click();
    await expect(page.getByLabel("关联状态", { exact: true })).toHaveValue("all");
    await expect(page.locator('[data-monitor-post]')).toHaveCount(2);
    await page.getByRole("link", { name: "事件列表", exact: true }).click();
    await expect(page.getByLabel("关联状态", { exact: true })).toHaveCount(0);
  } finally { await page.close(); }
});

for (const product of platforms) test(`${product.product}: post list offers only edit and create dialogs, with source identity preserved`, async () => {
  const page = await browser.newPage();
  try {
    const initial = `${web.origin}${product.admin}?kind=posts&from=2020-01-01&to=2020-01-02&page=2`;
    await page.goto(initial);
    await expect(page.getByRole("button", { name: "创建事件", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "创建帖子", exact: true }).click();
    await expect(createDialog(page).getByLabel("发布时间（北京时间）", { exact: true })).toHaveValue("");
    await expect(createDialog(page).getByLabel(/理由|动作|识别状态/)).toHaveCount(0);
    await expect(createDialog(page).getByRole("button", { name: "创建", exact: true })).toBeDisabled();
    assert.equal(fixture.writes.length, 0);
    const title = `${product.product} 人工帖子`;
    await fillNew(page, title);
    await createDialog(page).getByRole("button", { name: "创建", exact: true }).click();
    await expect(createDialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${web.origin}${product.admin}?kind=posts&from=2026-10-23&to=2026-10-23`);
    assert.equal(fixture.createdPosts.length, 1);
    const record = fixture.createdPosts[0]!.post;
    const body = fixture.writes[0]!.body;
    assert.equal(body.publishedAt, "2026-10-23T00:30:00.000Z"); assert.equal(body.text, "Private original source text");
    assert.deepEqual(Object.keys(body).sort(), ["author", "publishedAt", "summary", "text", "title", "url"]);
    const card = page.locator(`[data-monitor-post="${record.id}"]`);
    await expect(card.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(card.getByText("已处理", { exact: true })).toBeVisible();
    await expect(card.getByRole("button")).toHaveCount(2);
    await expect(card.getByText("无关联", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "关联事件", exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: "原帖 ↗", exact: true })).toHaveAttribute("href", record.url);
    await expect(card.getByRole("link", { name: "原帖 ↗", exact: true })).toHaveAttribute("target", "_blank");
    await expect(page.getByRole("link", { name: "处理帖子", exact: true })).toHaveCount(0);
    const url = page.url();
    await card.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(editDialog(page).getByLabel("标题（中文）", { exact: true })).toHaveValue(title);
    await expect(editDialog(page).getByLabel("作者", { exact: true })).toHaveCount(0);
    await expect(editDialog(page).getByLabel("原帖链接", { exact: true })).toHaveCount(0);
    await editDialog(page).getByText("查看已存原文", { exact: true }).click();
    await expect(editDialog(page)).toContainText("Private original source text");
    await editDialog(page).getByLabel("标题（中文）", { exact: true }).fill("修正帖子标题");
    await editDialog(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(editDialog(page)).toHaveCount(0); await expect(page).toHaveURL(url);
    await expect(card.getByRole("heading", { name: "修正帖子标题", exact: true })).toBeVisible();
    const saved = fixture.writes.at(-1)!.body;
    assert.equal(saved.version, record.version); assert.deepEqual(Object.keys(saved).sort(), ["patch", "version"]);
    assert.deepEqual(Object.keys(saved.patch), ["title"]);
    assert.equal(record.processingStatus, "processed"); assert.equal(record.actionCount, 0); assert.deepEqual(record.events, []);
  } finally { await page.close(); }
});

test("editing uses the latest post row version, retains failed input and reloads after conflicts", async () => {
  const page = await browser.newPage();
  try {
    const url = `${web.origin}/admin/codex-reset?kind=posts&from=2026-10-01&to=2026-10-31&page=2`;
    await page.goto(url);
    const card = page.locator('[data-monitor-post="post-1"]'), trigger = card.getByRole("button", { name: "编辑", exact: true });
    await expect(card.getByRole("status")).toContainText("来源关系需要管理员核对");
    let failSave = true, readsBeforeEdit = 0, holdReload = false;
    let releaseReload: (() => void) | undefined;
    await page.route("**/api/admin/codex-reset/posts/post-1", async route => {
      if (route.request().method() === "GET" && readsBeforeEdit++ === 0 || route.request().method() === "PATCH" && failSave) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "暂时不可用" }) });
      else {
        if (route.request().method() === "GET" && holdReload) await new Promise<void>(resolve => { releaseReload = resolve; });
        await route.continue();
      }
    });
    await trigger.click();
    await expect(editDialog(page).getByRole("alert")).toHaveText("暂时不可用");
    await editDialog(page).getByRole("button", { name: "重新读取", exact: true }).click();
    await editDialog(page).getByLabel("标题（中文）", { exact: true }).fill("保留的标题");
    await editDialog(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(editDialog(page).getByRole("alert")).toContainText("保存失败");
    await expect(editDialog(page).getByLabel("标题（中文）", { exact: true })).toHaveValue("保留的标题");
    failSave = false; fixture.state.previewConflict = true;
    await editDialog(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(editDialog(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await expect(editDialog(page).getByLabel("标题（中文）", { exact: true })).toHaveValue("保留的标题");
    const reads = fixture.requests.filter(path => path === "/api/admin/codex-reset/posts/post-1").length;
    fixture.state.previewConflict = false;
    holdReload = true;
    await editDialog(page).getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(editDialog(page).getByRole("status")).toHaveText("正在读取帖子…");
    await expect(editDialog(page).getByLabel("标题（中文）", { exact: true })).toHaveCount(0);
    await expect.poll(() => !!releaseReload).toBe(true);
    holdReload = false; releaseReload!();
    await expect(editDialog(page).getByLabel("标题（中文）", { exact: true })).toHaveValue("官方帖子摘要");
    assert.ok(fixture.requests.filter(path => path === "/api/admin/codex-reset/posts/post-1").length > reads);
    await editDialog(page).getByLabel("摘要（中文）", { exact: true }).fill("修改后摘要");
    await editDialog(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(editDialog(page)).toHaveCount(0); await expect(page).toHaveURL(url); await expect(trigger).toBeFocused();
    assert.equal(fixture.writes.at(-1)!.body.version, "post-version");
    assert.equal(fixture.state.processingStatus, "needs_attention"); assert.equal(fixture.state.reviewReason, "来源关系需要管理员核对");
  } finally { await page.close(); }
});

test("a pending creation disables repeated submission and keeps the dialog open", async () => {
  const page = await browser.newPage();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  try {
    await page.goto(`${web.origin}/admin/grok-reset?kind=posts`);
    await page.getByRole("button", { name: "创建帖子", exact: true }).click(); await fillNew(page, "只创建一次");
    await page.route("**/api/admin/grok-reset/posts", async route => {
      if (route.request().method() === "POST") { attempts++; await held; }
      await route.continue();
    });
    await createDialog(page).getByRole("button", { name: "创建", exact: true }).click();
    await expect.poll(() => attempts).toBe(1);
    await expect(createDialog(page).getByRole("button", { name: "创建", exact: true })).toBeDisabled();
    await createDialog(page).locator("form").dispatchEvent("submit");
    await page.keyboard.press("Escape"); await expect(createDialog(page)).toBeVisible(); assert.equal(attempts, 1);
    release(); await expect(createDialog(page)).toHaveCount(0); assert.equal(fixture.writes.length, 1);
  } finally { release(); await page.close(); }
});

test("creation cancellation writes nothing, failed creation retains fields, and mobile actions stay visible", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${web.origin}/admin/claude-reset?kind=posts`);
    const trigger = page.getByRole("button", { name: "创建帖子", exact: true });
    await trigger.click(); await fillNew(page, "取消的帖子");
    await createDialog(page).getByRole("button", { name: "取消", exact: true }).click();
    await expect(createDialog(page)).toHaveCount(0); await expect(trigger).toBeFocused(); assert.equal(fixture.writes.length, 0);
    await trigger.click(); await fillNew(page, "失败后保留");
    let fail = true;
    await page.route("**/api/admin/claude-reset/posts", async route => {
      if (route.request().method() === "POST" && fail) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "暂时不可用" }) });
      else await route.continue();
    });
    await createDialog(page).getByRole("button", { name: "创建", exact: true }).click();
    await expect(createDialog(page).getByRole("alert")).toContainText("创建失败");
    await expect(createDialog(page).getByLabel("标题（中文）", { exact: true })).toHaveValue("失败后保留");
    assert.equal(await createDialog(page).evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await expect(createDialog(page).getByRole("button", { name: "创建", exact: true })).toBeInViewport();
    fail = false; await createDialog(page).getByRole("button", { name: "创建", exact: true }).click();
    await expect(createDialog(page)).toHaveCount(0);
  } finally { await page.close(); }
});
