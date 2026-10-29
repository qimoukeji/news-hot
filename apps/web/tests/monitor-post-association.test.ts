import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { createMonitorFixture, platforms, type Product } from "./fixtures/reset-monitor.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

const fixture = createMonitorFixture();
let browser: Browser, web: WebServer;
before(async () => { web = await startWebServer(fixture.api); browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close(); await web?.stop(); });
beforeEach(() => {
  fixture.writes.length = 0; fixture.requests.length = 0; fixture.associationActions.clear(); fixture.createdEvents.length = 0; fixture.createdPosts.length = 0;
  Object.assign(fixture.state, { noActions: false, emptyConfirmation: false, previewConflict: false, withdrawn: false, status: "completed", processingStatus: "needs_attention", reviewReason: "来源关系需要管理员核对" });
});
const dialog = (page: Page) => page.getByRole("dialog", { name: /^(关联事件|管理关联)$/ });
const child = (page: Page, name: string) => page.getByRole("dialog", { name, exact: true });
const card = (page: Page, id = "post-3") => page.locator(`[data-monitor-post="${id}"]`);
async function open(page: Page, product: Product, query = "", id = "post-3") {
  const url = `${web.origin}${product.admin}?kind=posts${query}`;
  await page.goto(url);
  await card(page, id).getByRole("button", { name: id === "post-3" ? "关联事件" : "管理关联", exact: true }).click();
  await expect(dialog(page).getByRole("heading", { name: "当前关联", exact: true })).toBeVisible();
  return url;
}
async function chooseEvent(page: Page, product: Product, title = `${product.product} 官方活动`) {
  await dialog(page).getByRole("button", { name: "关联已有事件", exact: true }).click();
  const picker = child(page, "选择事件");
  await picker.getByLabel("搜索事件", { exact: true }).fill(title);
  await picker.getByRole("button", { name: new RegExp(title) }).click();
  await expect(child(page, "关联到此事件")).toBeVisible();
}
async function sourcePicker(page: Page, product: Product, title?: string) {
  await chooseEvent(page, product, title);
  await child(page, "关联到此事件").getByRole("button", { name: "补充已有动作来源", exact: true }).click();
  return child(page, "选择已有动作");
}
async function stageSource(page: Page, product: Product, title = "额度活动预告", eventTitle?: string) {
  const picker = await sourcePicker(page, product, eventTitle);
  await picker.getByRole("radio", { name: new RegExp(title) }).check();
  await picker.getByRole("button", { name: "确定", exact: true }).click();
  await expect(picker).toHaveCount(0);
}
async function stageNewEvent(page: Page, title: string) {
  await dialog(page).getByRole("button", { name: "新建事件", exact: true }).click();
  const form = child(page, "新建事件并关联");
  await form.getByLabel("标题（中文）", { exact: true }).fill(title);
  await form.getByLabel("摘要（中文）", { exact: true }).fill("新一期活动说明");
  await form.getByLabel("影响范围（中文）", { exact: true }).fill("所有付费用户");
  await expect(form.getByLabel("动作", { exact: true })).toHaveValue("announce");
  await expect(form.getByLabel("动作", { exact: true }).locator('option[value="progress"]')).toBeDisabled();
  await expect(form.getByLabel("动作", { exact: true }).locator('option[value="amend"]')).toBeDisabled();
  await form.getByLabel("动作标题（中文）", { exact: true }).fill("新一期额度活动预告");
  await form.getByLabel("动作摘要（中文）", { exact: true }).fill("当前帖子明确预告下一轮额度活动");
  await form.getByLabel("明确业务时间", { exact: true }).fill("2026-10-30");
  await form.getByRole("button", { name: "确定", exact: true }).click();
  await expect(form).toHaveCount(0);
}
async function stageNewAction(page: Page, product: Product, title: string, eventTitle?: string) {
  await chooseEvent(page, product, eventTitle);
  await child(page, "关联到此事件").getByRole("button", { name: "新增动作", exact: true }).click();
  const form = child(page, "新增动作并关联");
  await form.getByLabel("动作", { exact: true }).selectOption("progress");
  await form.getByLabel("动作标题（中文）", { exact: true }).fill(title);
  await form.getByRole("button", { name: "确定", exact: true }).click();
  await expect(form).toHaveCount(0);
}
async function newConfirmation(page: Page, title: string) {
  await chooseEvent(page, platforms[0]);
  await child(page, "关联到此事件").getByRole("button", { name: "新增动作", exact: true }).click();
  const form = child(page, "新增动作并关联");
  await form.getByLabel("动作", { exact: true }).selectOption("confirm");
  await form.getByLabel("动作标题（中文）", { exact: true }).fill(title);
  await form.getByLabel("明确业务时间", { exact: true }).fill("2026-10-23T08:00:00Z");
  return form;
}
async function stageRemove(page: Page, title: string) {
  await dialog(page).getByRole("button", { name: `移除关联：${title}`, exact: true }).click();
  await child(page, "移除关联").getByRole("button", { name: "确定移除", exact: true }).click();
  await expect(child(page, "移除关联")).toHaveCount(0);
}
async function preview(page: Page) {
  await dialog(page).getByRole("button", { name: "预览影响", exact: true }).click();
  await expect(dialog(page).getByLabel("变更预览", { exact: true })).toBeVisible();
  const body = fixture.writes.at(-1)!.body;
  assert.equal("reason" in body, false); assert.equal("post" in body, false); assert.equal("completeProcessing" in body, false);
  return body;
}
async function submit(page: Page) {
  await dialog(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
}

for (const product of platforms) for (const width of [1280, 390]) test(`${product.product}: event picker sorts by descending time before pagination, resets search and selects a later-page event at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  try {
    await page.route(`${web.origin}${product.api}/posts/post-3`, async route => {
      const response = await route.fetch(), detail = await response.json();
      detail.options.events = Array.from({ length: 12 }, (_, index) => ({ ...detail.options.events[0], id: `event-${index + 1}`, title: { zh: `分页事件 ${index + 1}` }, withdrawn: index === 0,
        time: index === 11 ? null : index === 1 ? "2026-10-27/2026-10-28" : index === 2 ? "2026-10-26" : `2026-10-${28 - index}T06:00:00Z` })).reverse();
      await route.fulfill({ response, json: detail });
    });
    const url = await open(page, product);
    await dialog(page).getByRole("button", { name: "关联已有事件", exact: true }).click();
    const picker = child(page, "选择事件"), list = picker.getByRole("list", { name: "可选事件", exact: true }), pagination = picker.getByRole("navigation", { name: "事件分页", exact: true });
    await expect(picker.getByLabel("搜索事件", { exact: true })).toBeFocused();
    await expect(list.getByRole("listitem")).toHaveCount(10);
    assert.deepEqual(await list.locator("li > button > span:first-child").allTextContents(), Array.from({ length: 10 }, (_, index) => `分页事件 ${index + 1}`));
    await expect(pagination).toContainText("共 12 条 · 第 1 / 2 页");
    await expect(list.getByRole("button", { name: /^分页事件 1 / })).toBeDisabled();
    await expect(pagination.getByRole("link", { name: "上一页", exact: true })).toHaveCount(0);
    await pagination.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(list.getByRole("listitem")).toHaveCount(2);
    assert.deepEqual(await list.locator("li > button > span:first-child").allTextContents(), ["分页事件 11", "分页事件 12"]);
    await expect(pagination).toContainText("第 2 / 2 页");
    await expect(pagination.getByRole("link", { name: "下一页", exact: true })).toHaveCount(0);
    assert.equal(page.url(), url);
    await pagination.getByRole("link", { name: "上一页", exact: true }).click();
    await expect(list.getByRole("listitem")).toHaveCount(10);
    await pagination.getByRole("link", { name: "下一页", exact: true }).click();
    await picker.getByLabel("搜索事件", { exact: true }).fill("分页事件 12");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(pagination).toContainText("共 1 条 · 第 1 / 1 页");
    await picker.getByLabel("搜索事件", { exact: true }).fill("没有这个事件");
    await expect(list.getByRole("listitem")).toHaveCount(0);
    await expect(pagination).toContainText("共 0 条 · 第 0 / 0 页");
    await expect(picker.getByText("没有匹配事件，请调整搜索条件。", { exact: true })).toBeVisible();
    await picker.getByLabel("搜索事件", { exact: true }).clear();
    await expect(pagination).toContainText("第 1 / 2 页");
    await pagination.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(pagination).toBeInViewport();
    await expect(picker.getByRole("button", { name: "取消", exact: true })).toBeInViewport();
    assert.equal(await picker.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await list.getByRole("button", { name: /^分页事件 12 / }).click();
    const operation = child(page, "关联到此事件");
    await expect(operation).toContainText("分页事件 12");
    await operation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    assert.equal(fixture.writes.length, 0);
    assert.equal(page.url(), url);
  } finally { await page.close(); }
});

for (const product of platforms) test(`${product.product}: association summary opens separate selectors and stages an existing source before saving`, async () => {
  const page = await browser.newPage();
  try {
    const url = await open(page, product, "&association=unlinked&from=2026-10-01&to=2026-10-31&page=2");
    assert.ok(fixture.requests.includes(`${product.api}/posts/post-3`));
    await expect(dialog(page).getByLabel("当前来源帖子", { exact: true })).toHaveCount(0);
    await expect(dialog(page).getByText("待核对的独立帖子", { exact: true })).toHaveCount(0);
    await expect(dialog(page).locator("input, select, textarea")).toHaveCount(0);
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeDisabled();
    const heading = await dialog(page).getByRole("heading", { name: "当前关联", exact: true }).boundingBox();
    const operation = await dialog(page).getByRole("button", { name: "关联已有事件", exact: true }).boundingBox();
    assert.ok(heading && operation && operation.x > heading.x + heading.width && Math.abs(operation.y + operation.height / 2 - heading.y - heading.height / 2) < 16);
    await stageSource(page, product);
    assert.equal(fixture.writes.length, 0, "child dialogs must not preview or commit changes");
    await expect(dialog(page).getByText("待补充来源", { exact: true })).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeEnabled();
    const body = await preview(page);
    assert.deepEqual(body.actions, { create: [], update: [] }); assert.deepEqual(body.events, { create: [], update: [] });
    assert.deepEqual(body.sources, { add: [{ actionId: "announce-action", postId: "post-3" }], remove: [] });
    await submit(page);
    await expect(page).toHaveURL(url); await expect(card(page)).toHaveCount(0);
    const stored = fixture.associationActions.get(product.platform)!.find(action => action.id === "announce-action")!;
    assert.deepEqual(stored.sources, [{ postId: "post-1" }, { postId: "post-3" }]);
    assert.equal(fixture.state.processingStatus, "needs_attention"); assert.equal(fixture.state.reviewReason, "来源关系需要管理员核对");
  } finally { await page.close(); }
});

for (const product of platforms) test(`${product.product}: a new event and its first action stay draft until the main dialog previews and saves`, async () => {
  const page = await browser.newPage();
  try {
    const url = await open(page, product), title = `${product.product} 新一期额度活动`;
    await stageNewEvent(page, title);
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.createdEvents.length, 0);
    await expect(dialog(page).getByText("待添加", { exact: true })).toBeVisible();
    let body = await preview(page);
    await expect(dialog(page).getByLabel("识别进度变化", { exact: true })).toContainText("待处理 → 已处理");
    await expect(dialog(page).getByText("处理说明将清空。", { exact: true })).toBeVisible();
    assert.equal(fixture.state.processingStatus, "needs_attention", "preview must not complete recognition");
    assert.equal(fixture.createdEvents.length, 0, "preview cannot leave an empty event");
    assert.equal(body.events.create.length, 1); assert.equal(body.events.create[0].title.zh, title);
    assert.equal(body.actions.create.length, 1); assert.equal(body.actions.create[0].eventKey, body.events.create[0].localKey);
    assert.deepEqual(body.sources.add, [{ actionKey: body.actions.create[0].localKey, postId: "post-3" }]);
    await dialog(page).getByRole("button", { name: "撤销：新一期额度活动预告", exact: true }).click();
    await expect(dialog(page).getByLabel("变更预览", { exact: true })).toHaveCount(0);
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeDisabled();
    await stageNewEvent(page, title); body = await preview(page);
    assert.equal(body.actions.create[0].summary.zh, "当前帖子明确预告下一轮额度活动");
    await submit(page); await expect(page).toHaveURL(url);
    await expect(card(page).getByText("已关联", { exact: true })).toBeVisible();
    await expect(card(page).getByText("已处理", { exact: true })).toBeVisible();
    assert.equal(fixture.state.processingStatus, "processed"); assert.equal(fixture.state.reviewReason, null);
    assert.equal(fixture.createdEvents.length, 1); assert.equal(fixture.createdEvents[0]!.actions.length, 1);
    assert.deepEqual(fixture.createdEvents[0]!.actions[0]!.sources, [{ postId: "post-3" }]);
    assert.ok(fixture.writes.every(write => !write.path.endsWith("/events")), "standalone event creation must not be used");
  } finally { await page.close(); }
});

test("several targets compose one transaction, staged sources cannot be selected twice, and undo invalidates the preview", async () => {
  const page = await browser.newPage();
  try {
    await open(page, platforms[0]);
    await stageSource(page, platforms[0]);
    let picker = await sourcePicker(page, platforms[0]);
    await expect(picker.getByRole("radio", { name: /额度活动预告/ })).toBeDisabled();
    await picker.getByRole("button", { name: "取消", exact: true }).click();
    await stageNewAction(page, platforms[0], "另一期发放进展", "另一期额度活动");
    await stageNewEvent(page, "同时新增的事件");
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.createdEvents.length, 0);
    let body = await preview(page);
    assert.equal(body.events.create.length, 1); assert.equal(body.actions.create.length, 2); assert.equal(body.sources.add.length, 3);
    assert.equal(body.actions.create.find((action: { eventId?: string }) => action.eventId === "event-2").title.zh, "另一期发放进展");
    await dialog(page).getByRole("button", { name: "撤销：额度活动预告", exact: true }).click();
    await expect(dialog(page).getByLabel("变更预览", { exact: true })).toHaveCount(0);
    picker = await sourcePicker(page, platforms[0]);
    await expect(picker.getByRole("radio", { name: /额度活动预告/ })).toBeEnabled();
    await picker.getByRole("button", { name: "取消", exact: true }).click();
    body = await preview(page); assert.equal(body.sources.add.length, 2);
    await submit(page);
    assert.equal(fixture.createdEvents.length, 1);
    assert.equal(fixture.associationActions.get("codex")!.filter(action => action.sources.some(source => source.postId === "post-3")).length, 2);
  } finally { await page.close(); }
});

test("official evidence can correct a source-less confirmation without changing its identity or type", async () => {
  fixture.state.emptyConfirmation = true;
  const page = await browser.newPage();
  try {
    await open(page, platforms[0]);
    const picker = await sourcePicker(page, platforms[0]);
    await picker.getByRole("radio", { name: /已到预告时间/ }).check();
    await picker.getByRole("checkbox", { name: "同时更新确认内容", exact: true }).check();
    await expect(picker.getByLabel("动作", { exact: true })).toHaveValue("confirm");
    await expect(picker.getByLabel("动作", { exact: true })).toBeDisabled();
    await expect(picker.getByLabel("动作标题（中文）", { exact: true })).toHaveValue("已到预告时间");
    await picker.getByLabel("动作标题（中文）", { exact: true }).fill("官方确认额度已重置");
    await picker.getByLabel("动作摘要（中文）", { exact: true }).fill("官方帖子明确表示重置完成");
    await picker.getByLabel("明确业务时间", { exact: true }).fill("2026-10-23T08:00:00Z");
    await picker.getByRole("button", { name: "确定", exact: true }).click();
    assert.equal(fixture.writes.length, 0);
    const body = await preview(page);
    assert.equal(body.actions.create.length, 0); assert.equal(body.actions.update[0].id, "confirm-action");
    assert.equal(body.actions.update[0].action, "confirm");
    assert.deepEqual(body.sources.add, [{ actionId: "confirm-action", postId: "post-3" }]);
    await submit(page);
    const action = fixture.associationActions.get("codex")!.find(action => action.id === "confirm-action")!;
    assert.equal(action.title.zh, "官方确认额度已重置"); assert.equal(action.sequence, 2); assert.deepEqual(action.sources, [{ postId: "post-3" }]);
  } finally { await page.close(); }
});

test("creating an official confirmation upgrades the current source-less action and disables choosing it twice", async () => {
  fixture.state.emptyConfirmation = true;
  const page = await browser.newPage();
  try {
    await open(page, platforms[0]);
    const form = await newConfirmation(page, "从新增入口补充官方确认");
    await form.getByRole("button", { name: "确定", exact: true }).click();
    await expect(form).toHaveCount(0); assert.equal(fixture.writes.length, 0);
    const picker = await sourcePicker(page, platforms[0]);
    await expect(picker.getByRole("radio", { name: /已到预告时间/ })).toBeDisabled();
    await picker.getByRole("button", { name: "取消", exact: true }).click();
    const body = await preview(page);
    assert.deepEqual(body.actions.create, []); assert.equal(body.actions.update.length, 1);
    assert.equal(body.actions.update[0].id, "confirm-action"); assert.equal(body.actions.update[0].title.zh, "从新增入口补充官方确认");
    assert.deepEqual(body.sources.add, [{ actionId: "confirm-action", postId: "post-3" }]);
    await submit(page);
    const actions = fixture.associationActions.get("codex")!;
    assert.equal(actions.length, 3);
    const confirmation = actions.find(action => action.id === "confirm-action")!;
    assert.equal(confirmation.sequence, 2); assert.equal(confirmation.title.zh, "从新增入口补充官方确认");
    assert.deepEqual(confirmation.sources, [{ postId: "post-3" }]);
  } finally { await page.close(); }
});

test("two new confirmation drafts cannot upgrade the same source-less action or overwrite the first draft", async () => {
  fixture.state.emptyConfirmation = true;
  const page = await browser.newPage();
  try {
    await open(page, platforms[0]);
    let form = await newConfirmation(page, "第一次确认更正");
    await form.getByRole("button", { name: "确定", exact: true }).click();
    await expect(form).toHaveCount(0);
    form = await newConfirmation(page, "第二次确认不得覆盖");
    await form.getByRole("button", { name: "确定", exact: true }).click();
    await expect(form.getByRole("alert")).toHaveText("此动作已在待保存列表中，请先撤销对应变更。");
    await expect(form.getByLabel("动作标题（中文）", { exact: true })).toHaveValue("第二次确认不得覆盖");
    assert.equal(fixture.writes.length, 0);
    await form.getByRole("button", { name: "取消", exact: true }).click();
    const body = await preview(page);
    assert.deepEqual(body.actions.create, []); assert.equal(body.actions.update.length, 1);
    assert.equal(body.actions.update[0].title.zh, "第一次确认更正"); assert.equal(body.sources.add.length, 1);
    await submit(page);
    assert.equal(fixture.associationActions.get("codex")!.find(action => action.id === "confirm-action")!.title.zh, "第一次确认更正");
  } finally { await page.close(); }
});

test("a staged source-less confirmation correction blocks the new-action entry from overwriting it", async () => {
  fixture.state.emptyConfirmation = true;
  const page = await browser.newPage();
  try {
    await open(page, platforms[0]);
    const picker = await sourcePicker(page, platforms[0]);
    await picker.getByRole("radio", { name: /已到预告时间/ }).check();
    await picker.getByRole("checkbox", { name: "同时更新确认内容", exact: true }).check();
    await picker.getByLabel("动作标题（中文）", { exact: true }).fill("已有动作入口更正");
    await picker.getByRole("button", { name: "确定", exact: true }).click();
    const form = await newConfirmation(page, "新增入口不得覆盖");
    await form.getByRole("button", { name: "确定", exact: true }).click();
    await expect(form.getByRole("alert")).toHaveText("此动作已在待保存列表中，请先撤销对应变更。");
    await expect(form.getByLabel("动作标题（中文）", { exact: true })).toHaveValue("新增入口不得覆盖");
    assert.equal(fixture.writes.length, 0);
    await form.getByRole("button", { name: "取消", exact: true }).click();
    const body = await preview(page);
    assert.deepEqual(body.actions.create, []); assert.equal(body.actions.update.length, 1);
    assert.equal(body.actions.update[0].title.zh, "已有动作入口更正"); assert.equal(body.sources.add.length, 1);
    await submit(page);
    assert.equal(fixture.associationActions.get("codex")!.find(action => action.id === "confirm-action")!.title.zh, "已有动作入口更正");
  } finally { await page.close(); }
});

test("removal opens its own dialog, can be undone, and is saved with additions only from the main dialog", async () => {
  const page = await browser.newPage();
  try {
    await open(page, platforms[0], "", "post-1");
    await dialog(page).getByRole("button", { name: "移除关联：额度活动预告", exact: true }).click();
    const removal = child(page, "移除关联");
    await expect(removal).toContainText("最后一条来源");
    await removal.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog(page).getByRole("button", { name: "移除关联：额度活动预告", exact: true })).toBeFocused();
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeDisabled();
    await stageRemove(page, "额度活动预告");
    await expect(dialog(page).getByText("待移除", { exact: true })).toBeVisible();
    await dialog(page).getByRole("button", { name: "撤销：额度活动预告", exact: true }).click();
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeDisabled();
    await stageRemove(page, "额度活动预告");
    await stageSource(page, platforms[0], "另一期活动预告", "另一期额度活动");
    assert.equal(fixture.writes.length, 0);
    const body = await preview(page);
    assert.deepEqual(body.sources.remove, [{ actionId: "announce-action", postId: "post-1" }]);
    assert.deepEqual(body.sources.add, [{ actionId: "other-action", postId: "post-1" }]);
    await expect(dialog(page).getByLabel("变更预览", { exact: true })).toContainText("最后一条来源");
    await submit(page);
    const actions = fixture.associationActions.get("codex")!;
    assert.equal(actions.some(action => action.id === "announce-action"), false);
    assert.deepEqual(actions.find(action => action.id === "confirm-action")!.sources, [{ postId: "post-1" }, { postId: "post-2" }]);
    assert.equal(fixture.state.processingStatus, "needs_attention");
  } finally { await page.close(); }
});

test("cancelling child forms and the main dialog discards all additions without writing", async () => {
  const page = await browser.newPage();
  try {
    await open(page, platforms[0]);
    const newTrigger = dialog(page).getByRole("button", { name: "新建事件", exact: true });
    await newTrigger.click();
    const form = child(page, "新建事件并关联");
    await form.getByLabel("标题（中文）", { exact: true }).fill("取消的子弹框");
    await form.getByRole("button", { name: "取消", exact: true }).click();
    await expect(newTrigger).toBeFocused();
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeDisabled();
    await stageNewEvent(page, "取消的批量草稿"); await stageSource(page, platforms[0]);
    await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0); assert.equal(fixture.writes.length, 0); assert.equal(fixture.createdEvents.length, 0);
    await expect(card(page).getByRole("button", { name: "关联事件", exact: true })).toBeFocused();
    await card(page).getByRole("button", { name: "关联事件", exact: true }).click();
    await expect(dialog(page).getByText("待添加", { exact: true })).toHaveCount(0);
    await expect(dialog(page).getByText("待补充来源", { exact: true })).toHaveCount(0);
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeDisabled();
  } finally { await page.close(); }
});

test("read failures retry, failed saves preserve staged changes, and conflicts require reloading and a fresh preview", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset?kind=posts`);
    const trigger = card(page).getByRole("button", { name: "关联事件", exact: true });
    let failRead = true, failSubmit = true;
    await page.route("**/api/admin/codex-reset/posts/post-3", async route => {
      if (failRead) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "读取暂时不可用" }) }); else await route.continue();
    });
    await trigger.click(); await expect(dialog(page).getByRole("alert")).toContainText("读取暂时不可用");
    failRead = false; await dialog(page).getByRole("button", { name: "重新读取", exact: true }).click();
    await stageNewAction(page, platforms[0], "失败保留的动作"); await preview(page);
    await page.route("**/api/admin/codex-reset/posts/post-3/review", async route => {
      if (failSubmit) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "保存暂时不可用" }) }); else await route.continue();
    });
    await dialog(page).getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toBeVisible();
    await expect(dialog(page).getByText("失败保留的动作", { exact: false })).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeEnabled();
    failSubmit = false; fixture.state.previewConflict = true;
    await dialog(page).getByRole("button", { name: "预览影响", exact: true }).click();
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeDisabled();
    fixture.state.previewConflict = false; await dialog(page).getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(dialog(page).getByText("失败保留的动作", { exact: false })).toHaveCount(0);
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeDisabled();
    await stageSource(page, platforms[0]); await preview(page); await submit(page);
    await expect(card(page).getByText("已关联", { exact: true })).toBeVisible();
  } finally { await page.close(); }
});

for (const width of [1280, 390]) test(`nested association dialogs keep actions visible and return focus without closing the main dialog at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  try {
    await open(page, platforms[2]);
    const trigger = dialog(page).getByRole("button", { name: "新建事件", exact: true });
    await trigger.click();
    const form = child(page, "新建事件并关联");
    await form.getByLabel("标题（中文）", { exact: true }).fill("布局核对");
    await form.getByLabel("摘要（中文）", { exact: true }).fill("很长的摘要\n".repeat(30));
    await form.getByLabel("动作标题（中文）", { exact: true }).fill("预告");
    assert.equal(await form.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await expect(form.getByRole("button", { name: "确定", exact: true })).toBeInViewport();
    await form.getByRole("button", { name: "确定", exact: true }).focus(); await page.keyboard.press("Tab");
    await expect(form.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(form).toHaveCount(0);
    await expect(dialog(page)).toBeVisible(); await expect(trigger).toBeFocused();
    await expect(dialog(page).getByRole("button", { name: "预览影响", exact: true })).toBeInViewport();
    await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "关联事件", exact: true })).toBeFocused(); assert.equal(fixture.writes.length, 0);
  } finally { await page.close(); }
});
