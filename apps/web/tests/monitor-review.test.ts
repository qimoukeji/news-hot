import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { startWebServer, type WebServer } from "./web-server.ts";
import { createMonitorFixture, platforms } from "./fixtures/reset-monitor.ts";

const fixture = createMonitorFixture();
let web: WebServer;
let browser: Browser;
before(async () => { web = await startWebServer(fixture.api); browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close(); await web?.stop(); });
const reviewReason = async (page: Page) => page.getByLabel("复核理由", { exact: false }).fill("核对原帖事实和事件影响范围");

async function openPost(page: Page, query = "") {
  await page.goto(web.origin+"/admin/codex-reset?kind=posts"+query);
  await page.locator('[data-monitor-post="post-1"]').getByRole("button",{name:/^(管理关联|关联事件)$/}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("post list hides filtered unlinked records by default", async () => {
  fixture.state.filteredOut = true;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset?kind=posts`);
    await expect(page.getByText("待核对的独立帖子", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("采集记录", { exact: true })).toHaveValue("normal");
  } finally { fixture.state.filteredOut = false; await page.close(); }
});

test("keeping a filtered reply in the association dialog previews only its collection visibility", async () => {
  fixture.writes.length = 0; fixture.state.filteredOut = true; fixture.state.noActions = true;
  fixture.state.processingStatus = "processed"; fixture.state.reviewReason = null;
  const page = await browser.newPage();
  try {
    await openPost(page, "&collectionFilter=filtered");
    await page.getByRole("button", { name: "保留帖子", exact: true }).click(); await reviewReason(page);
    await page.getByRole("button", { name: "预览影响", exact: true }).click();
    await expect(page.getByLabel("采集记录变化", { exact: true })).toContainText("被过滤 → 正常记录");
    await expect(page.getByLabel("识别进度变化", { exact: true })).toContainText("已处理 → 已处理");
    assert.equal(fixture.writes[0]!.body.keepPost, true);
    assert.deepEqual(fixture.writes[0]!.body.actions, { create: [], update: [] });
    await page.getByRole("button", { name: "取消保留帖子", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "保留帖子", exact: true }).click();
    await page.getByRole("button", { name: "预览影响", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0); assert.equal(fixture.state.filteredOut, false);
  } finally { fixture.state.filteredOut=false; fixture.state.noActions=false; fixture.state.processingStatus="needs_attention"; fixture.state.reviewReason="来源关系需要管理员核对"; await page.close(); }
});

test("time range survives pagination and tab changes, and reset stays on the current tab", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset?kind=posts&from=2026-10-23&to=2026-10-23`);
    await page.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByLabel("开始日期", { exact: true })).toHaveValue("2026-10-23");
    await page.getByRole("link", { name: "事件列表", exact: true }).click();
    await expect(page).toHaveURL(/kind=events$/);
    assert.equal(new URL(page.url()).searchParams.has("page"), false);
    await expect(page.getByLabel("结束日期", { exact: true })).toHaveValue("2026-10-23");
    await expect(page.locator("[data-monitor-event]")).toHaveCount(1);
    await page.getByRole("link", { name: "帖子列表", exact: true }).click();
    await page.getByRole("link", { name: "重置", exact: true }).click();
    await expect(page).toHaveURL(`${web.origin}/admin/codex-reset?kind=posts`);
    await expect(page.getByLabel("开始日期", { exact: true })).toHaveValue("");
    assert.ok(fixture.requests.some(path => {
      const request = new URL(path, "http://fixture");
      return request.pathname.endsWith("/posts") && request.searchParams.get("from") === "2026-10-23" && request.searchParams.get("to") === "2026-10-23" && request.searchParams.get("page") === "2";
    }));
  } finally { await page.close(); }
});

test("removed monitor admin addresses return 404 without aliases", async () => {
  for (const path of ["/admin/monitor", "/admin/monitor/posts", "/api/admin/monitor/events", "/api/admin/monitor/posts", ...platforms.flatMap(product => [`${product.admin}/posts`, `${product.admin}/posts/post-1/review`])]) {
    const response = await fetch(`${web.origin}${path}`);
    assert.equal(response.status, 404, path);
  }
});

for (const product of platforms) test(`${product.product} event tab keeps all sources and post tab includes linked and unlinked records`, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}${product.admin}`);
    await expect(page.getByRole("navigation", { name: "监控管理" })).toHaveCount(0);
    const event = page.locator("[data-monitor-event]");
    await expect(event).toHaveCount(1);
    await expect(event.locator("[data-timeline-action]")).toHaveCount(2);
    assert.deepEqual(await event.locator("[data-timeline-action]").evaluateAll(rows => rows.map(row => row.getAttribute("data-timeline-action"))), ["confirm-action", "announce-action"]);
    await expect(event.locator('a[href="https://example.org/official-1"]')).toHaveCount(0);
    await expect(event.locator('a[href="https://example.org/official-2"]')).toHaveCount(0);
    await expect(page.getByText("未关联事件", { exact: true })).toHaveCount(0);
    await expect(page.getByText("待核对的独立帖子", { exact: true })).toHaveCount(0);
    await event.getByRole("button", { name: "收起动态" }).click();
    await expect(event.getByLabel("事件动作时间线")).toBeHidden();
    await expect(page.getByText("待核对的独立帖子", { exact: true })).toHaveCount(0);
    await event.getByRole("button", { name: "展开动态" }).click();
    await expect(event.getByRole("link", { name: "处理帖子", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "帖子列表", exact: true }).click();
    await expect(page.getByRole("link", { name: "处理帖子", exact: true })).toHaveCount(0);
    await page.locator('[data-monitor-post="post-1"]').getByRole("button", { name: "编辑", exact: true }).click();
    const postDialog = page.getByRole("dialog", { name: "编辑帖子", exact: true });
    await expect(postDialog.getByLabel("标题（中文）", { exact: true })).toHaveValue("官方帖子摘要");
    await postDialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(postDialog).toHaveCount(0);
    await expect(page).toHaveURL(`${web.origin}${product.admin}?kind=posts`);
    await expect(page.locator("[data-monitor-event]")).toHaveCount(0);
    await expect(page.getByText("待核对的独立帖子", { exact: true })).toBeVisible();
    await expect(page.locator('[data-monitor-post="post-1"]')).toContainText("已关联 1 个事件");
  } finally { await page.close(); }
});

for (const kind of ["events", "posts"]) test(`${kind} list applies its date range and available filters`, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset?kind=${kind}`);
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "查询", exact: true }) });
    await expect(form.locator('input:not([type="hidden"])')).toHaveCount(2);
    await expect(form.locator("select")).toHaveCount(kind === "posts" ? 2 : 0);
    await page.getByLabel("开始日期", { exact: true }).fill("2026-10-24");
    await page.getByLabel("结束日期", { exact: true }).fill("2026-10-24");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page).toHaveURL(/from=2026-10-24/);
    await expect(page.getByText(`没有符合条件的${kind === "posts" ? "帖子" : "事件"}，请调整筛选。`, { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "重置", exact: true }).click();
    await expect(page.locator("article")).not.toHaveCount(0);
  } finally { await page.close(); }
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) test(`unified event timeline and its controls fit at ${viewport.width}px`, async () => {
  const page = await browser.newPage({ viewport });
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    await expect(page.getByRole("button", { name: "添加动作", exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  } finally { await page.close(); }
});

test("event detail uses the shared action dialog and cancellation returns focus", async () => {
  const page=await browser.newPage();
  try {
    await page.goto(web.origin+"/admin/codex-reset/events/event-1");
    await page.getByRole("button",{name:"编辑动作：额度活动预告",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"编辑动作",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"取消",exact:true}).click();
    await expect(page.getByRole("button",{name:"编辑动作：额度活动预告",exact:true})).toBeFocused();
    await expect(page.getByRole("button",{name:"编辑",exact:true})).toBeEnabled();
  } finally { await page.close(); }
});

for (const product of platforms) test(`${product.product} event timeline filters by date before opening a dedicated detail page`, async () => {
  const page = await browser.newPage();
  const requestStart = fixture.requests.length;
  try {
    await page.goto(`${web.origin}${product.admin}`);
    await expect(page.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
    await expect(page.getByText("额度活动预告", { exact: true })).toBeVisible();
    await page.getByLabel("开始日期", { exact: true }).fill("2026-10-24");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.getByRole("link", { name: `${product.product} 官方活动`, exact: true })).toHaveCount(0);
    assert.equal(new URL(page.url()).searchParams.get("from"), "2026-10-24");
    await page.getByLabel("开始日期", { exact: true }).fill("2026-10-23");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.getByRole("link", { name: `${product.product} 官方活动`, exact: true })).toBeVisible();
    await page.getByRole("link", { name: `${product.product} 官方活动`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${product.admin}/events/event-1$`));
    await expect(page.getByLabel("事件动作时间线", { exact: true })).toBeVisible();
    assert.equal(fixture.requests.slice(requestStart).some(path => path.includes("/api/admin/monitor")), false);
  } finally { await page.close(); }
});

for (const product of platforms) test(`${product.product} posts show recognition states and processing reasons`, async () => {
  const page = await browser.newPage();
  try {
    for (const [status, label] of [["pending", "待识别"], ["processed", "已处理"], ["needs_attention", "待处理"], ["failed", "处理失败"]] as const) {
      fixture.state.processingStatus = status;
      await page.goto(`${web.origin}${product.admin}?kind=posts`);
      await expect(page.locator("article").first()).toContainText(label);
      await expect(page.getByRole("status").filter({ hasText: "来源关系需要管理员核对" }).first()).toBeVisible();
    }
  } finally { fixture.state.processingStatus = "needs_attention"; await page.close(); }
});

test("finishing recognition from the association dialog changes no actions and previews its reason", async () => {
  fixture.writes.length=0; fixture.state.processingStatus="needs_attention"; fixture.state.reviewReason="来源关系需要管理员核对";
  const page=await browser.newPage();
  try {
    await openPost(page); await page.getByRole("button",{name:"完成处理",exact:true}).click();
    await expect(page.getByRole("button",{name:"预览影响",exact:true})).toBeDisabled(); await reviewReason(page);
    await page.getByRole("button",{name:"预览影响",exact:true}).click();
    await expect(page.getByLabel("识别进度变化",{exact:true})).toContainText("待处理 → 已处理");
    const body=fixture.writes[0]!.body; assert.equal(body.completeProcessing,true); assert.deepEqual(body.actions,{create:[],update:[]}); assert.deepEqual(body.sources,{add:[],remove:[]});
    await page.getByRole("button",{name:"取消完成处理",exact:true}).click();
    await expect(page.getByRole("button",{name:"保存",exact:true})).toHaveCount(0);
    await page.getByRole("button",{name:"完成处理",exact:true}).click(); await page.getByRole("button",{name:"预览影响",exact:true}).click(); await page.getByRole("button",{name:"保存",exact:true}).click();
    await openPost(page); await expect(page.getByRole("button",{name:"完成处理",exact:true})).toHaveCount(0);
  } finally { fixture.state.processingStatus="needs_attention"; fixture.state.reviewReason="来源关系需要管理员核对"; await page.close(); }
});

test("event ordering reads latest data, invalidates previews and sends only order commands", async () => {
  fixture.writes.length=0; const page=await browser.newPage();
  try {
    await page.goto(web.origin+"/admin/codex-reset/events/event-1"); await page.getByRole("button",{name:"调整动作顺序",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"调整动作顺序",exact:true});
    await dialog.getByRole("button",{name:"下移：额度活动预告",exact:true}).click(); await dialog.getByRole("button",{name:"预览影响",exact:true}).click();
    await expect(dialog.getByLabel("动作顺序变化",{exact:true})).toBeVisible();
    assert.deepEqual(fixture.writes[0]!.body.orders,[{eventId:"event-1",actionIds:["confirm-action","announce-action"]}]);
    assert.equal("actions" in fixture.writes[0]!.body,false); assert.equal("events" in fixture.writes[0]!.body,false);
    await dialog.getByRole("button",{name:"上移：额度活动预告",exact:true}).click(); await expect(dialog.getByRole("button",{name:"确认提交",exact:true})).toHaveCount(0);
    await dialog.getByRole("button",{name:"下移：额度活动预告",exact:true}).click(); await dialog.getByRole("button",{name:"预览影响",exact:true}).click();
    await dialog.getByRole("button",{name:"确认提交",exact:true}).click(); await expect(dialog).toHaveCount(0);
  } finally { await page.close(); }
});

test("event editor preserves ordinary text fields and sends no reason", async () => {
  fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset/events/event-1`);
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/原因|备注|JSON|状态|实际时间/)).toHaveCount(0);
    await dialog.getByLabel("标题（中文）", { exact: true }).fill("人工确定的显示标题");
    await dialog.getByLabel("摘要（中文）", { exact: true }).fill("调整后的中文摘要");
    await dialog.getByLabel("影响范围（中文）", { exact: true }).fill("仅限 Pro 用户的每周额度");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const write = fixture.writes[0]!;
    assert.equal("reason" in write.body, false);
    assert.deepEqual(write.body.patch, { title: { zh: "人工确定的显示标题" }, summary: { zh: "调整后的中文摘要" }, scope: { type: "paid_users", productCodes: ["product"], planCodes: ["pro"], quotaWindowCodes: ["weekly"], note: { zh: "仅限 Pro 用户的每周额度" } } });
    await page.goto(`${web.origin}/admin/codex-reset`);
    await page.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
  } finally { await page.close(); }
});

test("event reclassification previews status and time, then requires the matching preview token", async () => {
  fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset/events/event-1`);
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("类型", { exact: true }).selectOption("reset_credit");
    await dialog.getByRole("button", { name: "预览类型变更", exact: true }).click();
    await expect(dialog.getByText("类型变更对事件的影响", { exact: true })).toBeVisible();
    await expect(dialog.getByText("重置卡 · 已完成", { exact: true })).toBeVisible();
    await expect(dialog.locator("pre")).toHaveCount(0);
    await dialog.getByRole("button", { name: "确认保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(fixture.writes[1]!.body.previewToken, "event-preview-token");
  } finally { await page.close(); }
});

test("events without initial actions remain manageable without a fabricated status", async () => {
  fixture.state.noActions = true;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    await expect(page.getByText("缺少有效初始动作", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "标题待处理", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "标题待处理", exact: true }).click();
    await expect(page.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  } finally { fixture.state.noActions = false; await page.close(); }
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) test(`event editor rings and management fields fit at ${viewport.width}px`, async () => {
  const page = await browser.newPage({ viewport });
  try {
    await page.goto(`${web.origin}/admin/codex-reset/events/event-1`);
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName("编辑事件");
    assert.equal(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(":modal")), true);
    await expect(dialog.getByLabel("类型", { exact: true })).toBeFocused();
    await dialog.getByLabel("标题（中文）", { exact: true }).focus();
    assert.equal(await dialog.locator("[data-event-edit-fields]").evaluate(container => {
      const bounds = container.getBoundingClientRect();
      return [...container.querySelectorAll("input,select,textarea")].every(field => { const rect = field.getBoundingClientRect(); return rect.left >= bounds.left + 2 && rect.right <= bounds.right - 2; });
    }), true);
    await dialog.getByRole("button", { name: "保存", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "编辑", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "添加动作", exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  } finally { await page.close(); }
});
