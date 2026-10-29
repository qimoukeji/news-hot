import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { startWebServer, type WebServer } from "./web-server.ts";
import { createMonitorFixture, day } from "./fixtures/reset-monitor.ts";

const fixture = createMonitorFixture();
let web: WebServer;
let browser: Browser;
before(async () => { fixture.state.type = "bonus_credit"; fixture.state.status = "completed"; web = await startWebServer(fixture.api); browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close(); await web?.stop(); });

test("bonus events use the shared states without implying personal receipt", async () => {
  const page = await browser.newPage();
  try {
    for (const [status, label] of [["announced", "已预告"], ["in_progress", "进行中"], ["completed", "已完成"], ["cancelled", "已取消"]] as const) {
      fixture.state.status = status;
      await page.goto(`${web.origin}/claude-reset/history/${day}?state=${status}`);
      await expect(page.getByText(label, { exact: true })).toBeVisible();
      const event = page.locator("article").filter({ has: page.getByRole("heading", { name: "Claude 官方活动" }) });
      await expect(event.getByText("奖励额度", { exact: true })).toBeVisible();
      assert.doesNotMatch(await event.innerText(), /到账|恢复满额|预计|可领取|领取已截止|已到期/);
      await expect(event.locator('a[href="https://example.org/official-2"]')).toHaveCount(1);
      await expect(page.getByText("最近重置", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: status === "announced" ? "公开预告" : "预估时间", exact: true })).toBeVisible();
    }
  } finally { await page.close(); }
});

test("bonus review uses common actions and explicitly marks a cancellation amendment", async () => {
  const page = await browser.newPage();
  fixture.writes.length = 0;
  try {
    await page.goto(`${web.origin}/admin/claude-reset/events/event-1`);
    await page.getByRole("button", { name: "编辑动作：额度活动状态确认", exact: true }).click();
    for (const action of ["progress", "amend"] as const) {
      await page.getByLabel("动作", { exact: true }).last().selectOption(action);
      await expect(page.getByRole("button", { name: "确认提交", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "预览影响" }).click();
      await expect(page.getByRole("button", { name: "确认提交", exact: true })).toBeVisible();
      const draft = fixture.writes.at(-1)!.body.actions.update[0];
      assert.equal(draft.action, action);
      assert.equal(draft.invalidatesEvent, false);
      assert.equal("result" in draft, false);
      assert.equal("scope" in draft, false);
      assert.equal(draft.time, null);
    }
    for (const action of ["cancel", "close", "expire", "reopen", "restore"]) await expect(page.getByLabel("动作", { exact: true }).last().locator(`option[value="${action}"]`)).toHaveCount(0);
    await page.getByLabel("动作", { exact: true }).last().selectOption("amend");
    await page.getByRole("checkbox", { name: "取消活动，使事件失效", exact: false }).check();
    await expect(page.getByRole("button", { name: "确认提交", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "预览影响" }).click();
    assert.equal(fixture.writes.at(-1)!.body.actions.update[0].invalidatesEvent, true);
    await expect(page.getByRole("region", { name: "动作事实变化" }).getByText("修订 · 已取消", { exact: false })).toBeVisible();
    await page.getByLabel("动作", { exact: true }).last().selectOption("progress");
    await page.getByRole("button", { name: "预览影响" }).click();
    assert.equal(fixture.writes.at(-1)!.body.actions.update[0].invalidatesEvent, false);
  } finally { await page.close(); }
});
