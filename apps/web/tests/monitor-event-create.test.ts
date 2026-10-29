import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { createMonitorFixture, platforms } from "./fixtures/reset-monitor.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

const fixture = createMonitorFixture();
let browser: Browser, web: WebServer;
before(async () => { web = await startWebServer(fixture.api); browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close(); await web?.stop(); });

for (const product of platforms) test(`${product.product} creates an event first, then adds its first action in the list`, async () => {
  fixture.createdEvents.length = 0; fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}${product.admin}?kind=events&from=2020-01-01&to=2020-01-02&page=2`);
    await page.getByRole("button", { name: "创建事件", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "创建事件", exact: true })).toBeVisible();
    await expect(dialog.getByLabel(/理由|来源|动作|实际时间/)).toHaveCount(0);
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    assert.equal(fixture.writes.length, 0, "a title is required before creating an empty event");
    const title = `${product.product} 人工创建事件`;
    await dialog.getByLabel("标题（中文）", { exact: true }).fill(title);
    await dialog.getByLabel("摘要（中文）", { exact: true }).fill("管理员创建的活动");
    await dialog.getByLabel("影响范围（中文）", { exact: true }).fill("仅限特定用户");
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(`${web.origin}${product.admin}?kind=events`);
    const record = fixture.createdEvents[0]!;
    assert.equal(record.actions.length, 0);
    assert.equal(record.event.status, null);
    assert.equal(fixture.writes[0]!.path, `${product.api}/events`);
    assert.deepEqual(Object.keys(fixture.writes[0]!.body).sort(), ["scope", "summary", "title", "type"]);
    const card = page.getByRole("article", { name: `事件：${title}`, exact: true });
    await expect(card.getByText("缺少有效初始动作", { exact: true })).toBeVisible();
    await expect(card.getByText("尚无动作，请添加预告或确认动作。", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "撤回", exact: true })).toBeDisabled();
    let publicList = await (await fetch(`${web.origin}${product.list}`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(publicList.list.some((event: { id: string }) => event.id === record.event.id), false);
    await card.getByRole("button", { name: "添加动作", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "添加动作", exact: true });
    await dialog.getByLabel("动作", { exact: true }).selectOption("confirm");
    await dialog.getByLabel("明确业务时间", { exact: true }).fill("2026-10-23");
    await dialog.getByRole("button", { name: "预览影响", exact: true }).click();
    await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByText("人工核实已生效", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "撤回", exact: true })).toBeEnabled();
    assert.equal(record.actions.length, 1); assert.deepEqual(record.actions[0]!.sources, []);
    publicList = await (await fetch(`${web.origin}${product.list}`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(publicList.list.find((event: { id: string }) => event.id === record.event.id).updates.length, 1);
    await card.getByRole("button", { name: "编辑", exact: true }).first().click();
    dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-event-edit-fields]")).toBeVisible();
    await expect(dialog.getByLabel("标题（中文）", { exact: true })).toHaveValue(title);
    await expect(dialog.getByLabel("影响范围（中文）", { exact: true })).toHaveValue("仅限特定用户");
    await dialog.getByLabel("摘要（中文）", { exact: true }).fill("更正后的活动摘要");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(fixture.writes.at(-1)!.body.patch.summary.zh, "更正后的活动摘要");
  } finally { fixture.createdEvents.length = 0; await page.close(); }
});

test("creation cancellation writes nothing, failed submissions retain fields, and a pending submission cannot duplicate an event", async () => {
  fixture.createdEvents.length = 0; fixture.writes.length = 0;
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    const trigger = page.getByRole("button", { name: "创建事件", exact: true });
    await trigger.click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("标题（中文）", { exact: true }).fill("取消的事件");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused(); assert.equal(fixture.writes.length, 0);
    let fail = true, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/admin/codex-reset/events", async route => {
      if (route.request().method() !== "POST") return route.continue();
      if (fail) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "暂时无法创建" }) });
      await pending; await route.continue();
    });
    await trigger.click(); dialog = page.getByRole("dialog");
    await dialog.getByLabel("标题（中文）", { exact: true }).fill("保留输入的事件");
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByText("暂时无法创建", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("标题（中文）", { exact: true })).toHaveValue("保留输入的事件");
    assert.equal(fixture.createdEvents.length, 0);
    fail = false;
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "创建", exact: true })).toBeDisabled();
    await dialog.locator("form").evaluate(form => (form as HTMLFormElement).requestSubmit());
    release(); await expect(dialog).toHaveCount(0);
    assert.equal(fixture.createdEvents.length, 1);
  } finally { fixture.createdEvents.length = 0; await page.close(); }
});

test("the shared event form and create button fit on a phone", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${web.origin}/admin/grok-reset`);
    await page.getByRole("button", { name: "创建事件", exact: true }).click();
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(":modal")), true);
    await expect(dialog.getByRole("button", { name: "创建", exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await dialog.locator("[data-event-edit-fields]").evaluate(container => {
      const bounds = container.getBoundingClientRect();
      return [...container.querySelectorAll("input,select,textarea")].every(field => { const rect = field.getBoundingClientRect(); return rect.left >= bounds.left + 2 && rect.right <= bounds.right - 2; });
    }), true);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  } finally { await page.close(); }
});
