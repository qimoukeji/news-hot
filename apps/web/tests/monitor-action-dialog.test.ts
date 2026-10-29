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
const dialog = (page: Page) => page.getByRole("dialog", { name: /^(添加动作|编辑动作)$/ });
const source = (page: Page, name = "官方帖子摘要") => dialog(page).getByLabel("已关联帖子", { exact: true }).getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
const addSources = async (page: Page, ...names: string[]) => {
  await dialog(page).getByRole("button", { name: "添加关联帖子", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择来源帖子", exact: true });
  for (const name of names) await picker.getByRole("checkbox", { name: new RegExp(name) }).check();
  await picker.getByRole("button", { name: "确认添加", exact: true }).click();
  await expect(picker).toHaveCount(0);
};
const removeSource = (page: Page, name = "官方帖子摘要") => source(page, name).getByRole("button", { name: /^移除来源/ }).click();
const preview = async (page: Page) => {
  await dialog(page).getByRole("button", { name: "预览影响", exact: true }).click();
  await expect(dialog(page).getByLabel("变更预览", { exact: true })).toBeVisible();
};

for (const product of platforms) test(`${product.product} creates a confirmation without posts using the action form`, async () => {
  fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    const url = `${web.origin}${product.admin}?kind=events&from=2026-10-01&to=2026-10-27&page=1`;
    await page.goto(url);
    await expect(page.getByRole("button", { name: "核实结果", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "添加动作", exact: true }).click();
    await expect(dialog(page).getByLabel("复核理由（必填，写入审计）")).toHaveCount(0);
    await expect(dialog(page).getByText("三类事件使用相同动作；取消请选修订并勾选事件失效。", { exact: true })).toHaveCount(0);
    await expect(dialog(page).getByText("没有明确依据留空；支持日期、带时区时间或时间区间。", { exact: true })).toHaveCount(0);
    await dialog(page).getByLabel("动作", { exact: true }).selectOption("confirm");
    await expect(dialog(page).getByLabel("动作标题（中文）")).toHaveValue("人工核实已生效");
    const time = dialog(page).getByLabel("明确业务时间");
    await expect(time).toHaveAttribute("required", "");

    await dialog(page).getByRole("button", { name: "预览影响", exact: true }).click();
    assert.equal(fixture.writes.length, 0);
    await time.fill("2026-10-23");
    await preview(page);
    const body = fixture.writes[0]!.body;
    assert.equal("reason" in body, false);
    assert.equal(body.actions.create[0].action, "confirm");
    assert.equal(body.actions.create[0].time, "2026-10-23");
    assert.deepEqual(body.sources, { add: [], remove: [] });
    assert.equal("verification" in body, false);
    await dialog(page).getByLabel("动作摘要（中文）").fill("已核对实际使用情况");
    await expect(dialog(page).getByLabel("变更预览")).toHaveCount(0);
    await preview(page);
    await dialog(page).getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0); await expect(page).toHaveURL(url);
    const row = page.locator('[data-timeline-action="confirm-action"]');
    await expect(row.getByText("人工核实已生效", { exact: true })).toBeVisible();
    await expect(row.getByText("无关联帖子", { exact: true })).toHaveCount(0);
    await expect(row.getByText("待处理", { exact: true })).toHaveCount(0);
  } finally { fixture.state.emptyConfirmation = false; fixture.state.emptyConfirmationTitle = "已到预告时间"; await page.close(); }
});

for (const product of platforms) test(`${product.product} edits a source-less confirmation and adds official evidence`, async () => {
  fixture.state.emptyConfirmation = true; fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}${product.path}`);
    await expect(page.getByText("已到预告时间", { exact: true })).toBeVisible();
    await expect(page.getByText("无关联帖子", { exact: true })).toBeVisible();
    await page.goto(`${web.origin}${product.admin}`);
    const row = page.locator('[data-timeline-action="confirm-action"]');
    await expect(row.getByText("无关联帖子", { exact: true })).toHaveCount(0);
    await row.getByRole("button", { name: /^编辑动作/ }).click();
    await expect(dialog(page).getByLabel("明确业务时间")).toHaveValue("2026-10-22T16:30:00.000Z");
    await expect(dialog(page).getByRole("alert")).toHaveCount(0);
    await dialog(page).getByLabel("动作摘要（中文）").fill("人工核对生效情况");
     await preview(page);
    assert.equal(fixture.writes[0]!.body.actions.update[0].id, "confirm-action");
    assert.deepEqual(fixture.writes[0]!.body.sources, { add: [], remove: [] });
    await addSources(page, "官方帖子摘要");
    await dialog(page).getByLabel("动作标题（中文）").fill("额度活动状态确认");
    await dialog(page).getByLabel("明确业务时间").fill("2026-10-23T08:00:00Z");
    await expect(dialog(page).getByLabel("变更预览")).toHaveCount(0);
    await preview(page);
    const body = fixture.writes.at(-1)!.body;
    assert.equal(body.actions.update[0].id, "confirm-action");
    assert.equal(body.actions.update[0].time, "2026-10-23T08:00:00Z");
    assert.deepEqual(body.sources.add, [{ actionId: "confirm-action", postId: "post-1" }]);
    await dialog(page).getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row.getByText("无关联帖子", { exact: true })).toHaveCount(0);
  } finally { fixture.state.emptyConfirmation = false; await page.close(); }
});

for (const product of platforms) test(`${product.product} adds actions in a dialog and refreshes the same list`, async () => {
  fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    const url = `${web.origin}${product.admin}?kind=events&from=2026-10-01&to=2026-10-27&page=1`;
    await page.goto(url);
    const requestStart = fixture.requests.length;
    const trigger = page.getByRole("button", { name: "添加动作", exact: true });
    await trigger.click();
    await expect(dialog(page).getByLabel("动作", { exact: true })).toBeFocused();
    await expect(dialog(page).getByLabel("动作", { exact: true })).toHaveValue("announce");
    await expect(source(page)).toHaveCount(0);
    await dialog(page).getByLabel("动作标题（中文）").fill("新的确认事实");
    await dialog(page).getByLabel("明确业务时间").fill("2026-10-23");

    await dialog(page).getByRole("button", { name: "预览影响", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("至少一条来源");
    assert.equal(fixture.writes.length, 0);
    await dialog(page).getByLabel("动作", { exact: true }).selectOption("confirm");
    await addSources(page, "官方帖子摘要", "另一条官方报道");
    await preview(page);
    const body = fixture.writes[0]!.body;
    assert.equal(fixture.writes[0]!.path, `${product.api}/events/event-1/review/preview`);
    assert.equal(body.actions.create[0].eventId, "event-1");
    assert.equal(body.actions.create[0].time, "2026-10-23");
    assert.deepEqual(body.sources.add, [{ actionKey: "new-action", postId: "post-1" }, { actionKey: "new-action", postId: "post-2" }]);
    assert.deepEqual(body.events, { create: [], update: [] });
    assert.deepEqual(body.orders, []);
    assert.equal("completeProcessing" in body, false);
    await dialog(page).getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(url);
    await expect(trigger).toBeFocused();
    await expect.poll(() => fixture.requests.slice(requestStart).some(path => path.startsWith(`${product.api}/entries?`))).toBe(true);
    assert.equal(fixture.writes.at(-1)!.body.previewToken, "preview-token");
    assert.equal(fixture.state.processingStatus, "needs_attention");
  } finally { await page.close(); }
});

for (const product of platforms) test(`${product.product} edits a shared action once and sends only source differences`, async () => {
  fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}${product.admin}`);
    const row = page.locator('[data-timeline-action="confirm-action"]');
    await expect(row.getByRole("button", { name: /^编辑动作/ })).toHaveCount(1);
    await expect(row.getByRole("link", { name: "处理帖子", exact: true })).toHaveCount(0);
    await row.getByRole("button", { name: /^编辑动作/ }).click();
    await expect(dialog(page).getByLabel("动作标题（中文）")).toHaveValue("额度活动状态确认");
    await expect(source(page)).toBeVisible();
    await expect(source(page, "另一条官方报道")).toBeVisible();
    await expect(dialog(page).getByText(/全部 2 条帖子来源/)).toHaveCount(0);
    await dialog(page).getByLabel("动作摘要（中文）").fill("更正后的共享事实");
    await removeSource(page, "另一条官方报道");

    await preview(page);
    assert.equal(fixture.writes[0]!.body.actions.update[0].id, "confirm-action");
    assert.deepEqual(fixture.writes[0]!.body.sources.remove, [{ actionId: "confirm-action", postId: "post-2" }]);
    assert.deepEqual(fixture.writes[0]!.body.sources.add, []);
    await dialog(page).getByLabel("动作摘要（中文）").fill("再次更正");
    await expect(dialog(page).getByLabel("变更预览")).toHaveCount(0);
    await preview(page);
    await dialog(page).getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    assert.equal(fixture.state.processingStatus, "needs_attention");
    assert.deepEqual(fixture.writes.at(-1)!.body.orders, []);
    assert.deepEqual(fixture.writes.at(-1)!.body.events.update, []);
  } finally { await page.close(); }
});

test("source-only editing, preview invalidation, last-source removal, and cancellation stay explicit", async () => {
  fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    const trigger = page.getByRole("button", { name: "编辑动作：额度活动预告", exact: true });
    await trigger.click();
    await addSources(page, "另一条官方报道");

    await preview(page);
    assert.deepEqual(fixture.writes[0]!.body.actions, { create: [], update: [] });
    assert.deepEqual(fixture.writes[0]!.body.sources.add, [{ actionId: "announce-action", postId: "post-2" }]);
    await dialog(page).getByLabel("动作摘要（中文）").fill("补充动作说明");
    await expect(dialog(page).getByLabel("变更预览")).toHaveCount(0);
    await preview(page);
    await removeSource(page, "另一条官方报道");
    await removeSource(page);
    await expect(dialog(page).getByLabel("变更预览")).toHaveCount(0);
    await expect(dialog(page).getByRole("alert")).toContainText("此动作将删除");
    await preview(page);
    await expect(dialog(page).getByLabel("变更预览").getByRole("alert")).toContainText("最后一条来源");
    assert.deepEqual(fixture.writes.at(-1)!.body.sources.remove, [{ actionId: "announce-action", postId: "post-1" }]);
    await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
    await expect(trigger).toBeFocused();
    assert.ok(fixture.writes.every(write => write.path.endsWith("/preview")));
    await trigger.click();
    await expect(source(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally { await page.close(); }
});

test("action cancellation uses amend and invalidatesEvent without event or recognition writes", async () => {
  fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    await page.getByRole("button", { name: "编辑动作：额度活动状态确认" }).click();
    await dialog(page).getByLabel("动作", { exact: true }).selectOption("amend");
    await dialog(page).getByRole("checkbox", { name: /取消活动/ }).check();
     await preview(page);
    assert.equal(fixture.writes[0]!.body.actions.update[0].invalidatesEvent, true);
    assert.equal(fixture.writes[0]!.body.actions.update[0].action, "amend");
    assert.equal("completeProcessing" in fixture.writes[0]!.body, false);
    await expect(dialog(page).getByLabel("动作事实变化")).toContainText("修订 · 已取消");
  } finally { await page.close(); }
});

test("version conflicts block resubmission until fresh detail is loaded and previewed", async () => {
  fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    await page.getByRole("button", { name: "编辑动作：额度活动预告" }).click();
    await dialog(page).getByLabel("动作标题（中文）").fill("未保存的更正");
     await preview(page);
    fixture.state.previewConflict = true;
    await dialog(page).getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("重新读取后核对并预览");
    await expect(dialog(page).getByLabel("动作标题（中文）")).toHaveValue("未保存的更正");
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeDisabled();
    fixture.state.previewConflict = false;
    const reads = fixture.requests.filter(path => path.endsWith("/events/event-1/review")).length;
    await dialog(page).getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(dialog(page).getByLabel("动作标题（中文）")).toHaveValue("额度活动预告");
    assert.ok(fixture.requests.filter(path => path.endsWith("/events/event-1/review")).length > reads);
    await addSources(page, "另一条官方报道");
     await preview(page);
    await dialog(page).getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
  } finally { fixture.state.previewConflict = false; await page.close(); }
});

test("detail loading retries and failed submissions preserve inputs", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    let reads = 0, failSubmit = true;
    await page.route("**/api/admin/codex-reset/events/event-1/review", async route => {
      if (route.request().method() === "GET" && reads++ === 0 || route.request().method() === "POST" && failSubmit) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "服务暂时不可用" }) });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "编辑动作：额度活动预告" }).click();
    await expect(dialog(page).getByRole("alert")).toHaveText("服务暂时不可用");
    await dialog(page).getByRole("button", { name: "重新读取" }).click();
    await dialog(page).getByLabel("动作标题（中文）").fill("保留输入");
     await preview(page);
    await dialog(page).getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("提交失败");
    await expect(dialog(page).getByLabel("动作标题（中文）")).toHaveValue("保留输入");
    failSubmit = false;
    await preview(page);
    await dialog(page).getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
  } finally { await page.close(); }
});

test("events without initial actions only offer announce or confirm; withdrawn events forbid new sources", async () => {
  const page = await browser.newPage();
  try {
    fixture.state.noActions = true;
    await page.goto(`${web.origin}/admin/codex-reset`);
    await page.getByRole("button", { name: "添加动作", exact: true }).click();
    const select = dialog(page).getByLabel("动作", { exact: true });
    await expect(select.locator('option[value="progress"]')).toBeDisabled();
    await expect(select.locator('option[value="confirm"]')).toBeEnabled();
    await page.keyboard.press("Escape");
    fixture.state.noActions = false; fixture.state.withdrawn = true;
    await page.reload();
    await expect(page.getByRole("button", { name: "添加动作", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "编辑动作：额度活动预告" }).click();
    await expect(source(page).getByRole("button", { name: /^移除来源/ })).toBeEnabled();
    await expect(dialog(page).getByRole("button", { name: "添加关联帖子", exact: true })).toBeDisabled();
  } finally { fixture.state.noActions = false; fixture.state.withdrawn = false; await page.close(); }
});

for (const [status, label, color] of [["pending", "待识别", "text-ink-3"], ["processed", "已处理", "text-ok"], ["needs_attention", "待处理", "text-amber"], ["failed", "处理失败", "text-hot"]] as const) test(`${status} is displayed as a recognition badge`, async () => {
  const page = await browser.newPage(); fixture.state.processingStatus = status;
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    const badge = page.locator('[data-timeline-action="confirm-action"]').getByText(label, { exact: true });
    await expect(badge).toHaveCount(1);
    await expect(badge.first()).toHaveClass(/rounded-full/);
    assert.ok((await badge.first().getAttribute("class"))!.includes(color));
  } finally { fixture.state.processingStatus = "needs_attention"; await page.close(); }
});

for (const width of [1280, 390]) test(`source picker sorts newest first and keeps selections across pages and searches at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  try {
    await page.route(`${web.origin}/api/admin/codex-reset/events/event-1/review`, async route => {
      const response = await route.fetch();
      const detail = await response.json();
      detail.options.posts = Array.from({ length: 12 }, (_, index) => ({ ...detail.options.posts[0], id: `paged-${index + 1}`, title: { zh: `分页来源 ${index + 1}` }, publishedAt: `2026-10-${String(index + 1).padStart(2, "0")}T12:00:00Z` }));
      await route.fulfill({ response, json: detail });
    });
    await page.goto(`${web.origin}/admin/codex-reset`);
    await page.getByRole("button", { name: "添加动作", exact: true }).click();
    await dialog(page).getByRole("button", { name: "添加关联帖子", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "选择来源帖子", exact: true });
    await expect(picker.getByText("可搜索标题或作者并选择多条帖子，确认后加入来源列表。", { exact: true })).toHaveCount(0);
    await expect(picker.getByRole("checkbox")).toHaveCount(10);
    await expect(picker.getByRole("checkbox").first()).toHaveAccessibleName(/分页来源 12/);
    await expect(picker.getByRole("checkbox").last()).toHaveAccessibleName(/分页来源 3 /);
    await picker.getByRole("checkbox", { name: /分页来源 12 / }).check();
    await picker.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(picker.getByRole("checkbox")).toHaveCount(2);
    await expect(picker.getByRole("checkbox").first()).toHaveAccessibleName(/分页来源 2 /);
    await picker.getByRole("checkbox", { name: /分页来源 2 / }).check();
    await picker.getByLabel("搜索来源帖子", { exact: true }).fill("分页来源 1");
    await expect(picker.getByRole("navigation", { name: "来源帖子分页" })).toContainText("第 1 / 1 页");
    await expect(picker.getByRole("checkbox", { name: /分页来源 12 / })).toBeChecked();
    await expect(picker.getByText("已选择 2 条", { exact: true })).toBeVisible();
    await picker.getByLabel("搜索来源帖子", { exact: true }).fill("");
    await expect(picker.getByRole("checkbox", { name: /分页来源 12 / })).toBeChecked();
    assert.equal(await picker.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await picker.getByRole("button", { name: "确认添加", exact: true }).click();
    await expect(source(page, "分页来源 12")).toBeVisible();
    await expect(source(page, "分页来源 2")).toBeVisible();
  } finally { await page.close(); }
});

for (const width of [1280, 390]) test(`source picker stages selections, traps focus and only closes itself at ${width}px`, async () => {
  fixture.writes.length = 0;
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    await page.getByRole("button", { name: "编辑动作：额度活动预告" }).click();
    await expect(source(page)).toBeVisible();
    await expect(dialog(page).getByRole("checkbox")).toHaveCount(0);
    await dialog(page).getByLabel("动作标题（中文）").fill("主弹框尚未保存");
    const trigger = dialog(page).getByRole("button", { name: "添加关联帖子", exact: true });
    await trigger.click();
    const picker = page.getByRole("dialog", { name: "选择来源帖子", exact: true });
    await expect(picker.getByLabel("搜索来源帖子")).toBeFocused();
    await expect(picker.getByRole("checkbox", { name: /官方帖子摘要/ })).toHaveCount(0);
    await picker.getByLabel("搜索来源帖子").fill("无匹配帖子");
    await expect(picker.getByRole("checkbox")).toHaveCount(0);
    await expect(picker.getByText(/没有可选择的帖子/)).toBeVisible();
    await picker.getByLabel("搜索来源帖子").fill("other");
    await picker.getByRole("checkbox", { name: /另一条官方报道/ }).check();
    await expect(picker.getByText("已选择 1 条", { exact: true })).toBeVisible();
    await picker.screenshot({ path: `.data/local-preview/source-picker-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByLabel("动作标题（中文）")).toHaveValue("主弹框尚未保存");
    await expect(trigger).toBeFocused();
    await expect(source(page, "另一条官方报道")).toHaveCount(0);
    await trigger.click();
    await expect(picker.getByRole("checkbox", { name: /另一条官方报道/ })).not.toBeChecked();
    await picker.getByRole("checkbox", { name: /另一条官方报道/ }).check();
    await picker.getByRole("button", { name: "取消", exact: true }).click();
    await expect(source(page, "另一条官方报道")).toHaveCount(0);
    assert.equal(fixture.writes.length, 0);
    await addSources(page, "另一条官方报道");
    await expect(source(page, "另一条官方报道")).toBeVisible();
    assert.equal(fixture.writes.length, 0);
    await expect(trigger).toBeFocused();
    await dialog(page).screenshot({ path: `.data/local-preview/action-sources-${width}.png` });
    await trigger.click();
    await expect(picker.getByRole("checkbox")).toHaveCount(0);
    await expect(picker.getByRole("button", { name: "确认添加", exact: true })).toBeDisabled();
    await picker.getByRole("button", { name: "关闭", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(picker.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();
    await expect(trigger).toBeFocused();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

for (const width of [1280, 390]) test(`dialog scrolls with visible actions and traps focus at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    await page.getByRole("button", { name: "添加动作", exact: true }).click();
    await dialog(page).getByLabel("动作标题（中文）").fill("验证弹框滚动");
    await addSources(page, "官方帖子摘要");  await preview(page);
    const submit = dialog(page).getByRole("button", { name: "确认提交", exact: true });
    await expect(submit).toBeInViewport();
    assert.equal(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await submit.focus(); await page.keyboard.press("Tab");
    await expect(dialog(page).getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await page.screenshot({ path: `.data/local-preview/action-dialog-${width}.png` });
    await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveCount(0);
  } finally { await page.close(); }
});
