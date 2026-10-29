import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { createMonitorFixture, platforms } from "./fixtures/reset-monitor.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

const fixture = createMonitorFixture();
let browser: Browser, web: WebServer;
before(async () => { web = await startWebServer(fixture.api); browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close(); await web?.stop(); });

for (const product of platforms) test(`${product.product} shows the saved audience label on cards and in the editor`, async () => {
  const note = "所有用户";
  fixture.state.eventScope = { type: "unknown", productCodes: [], planCodes: ["pro"], quotaWindowCodes: ["weekly"],
    note: { en: note, zh: note, "zh-Hant": note, ja: note, ko: note, ru: note, es: note } };
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}${product.path}?from=2026-10-01&to=2026-10-31`);
    await expect(page.getByText(note, { exact: true })).toBeVisible();
    await expect(page.getByText(/unknown/)).toHaveCount(0);
    await page.goto(`${web.origin}${product.admin}`);
    await expect(page.getByText(note, { exact: true })).toBeVisible();
    await expect(page.getByText(/unknown/)).toHaveCount(0);
    const card = page.getByRole("article", { name: `事件：${product.product} 官方活动`, exact: true });
    await card.getByRole("button", { name: "编辑", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("影响范围（中文）", { exact: true })).toHaveValue(note);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(fixture.writes.length, 0);
  } finally { fixture.state.eventScope = undefined; await page.close(); }
});

test("an unknown audience without an editorial note omits the unknown prefix on cards", async () => {
  fixture.state.eventScope = { type: "unknown", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null };
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/admin/codex-reset`);
    await expect(page.getByText("所有用户", { exact: true })).toBeVisible();
    await expect(page.getByText("unknown 所有用户", { exact: true })).toHaveCount(0);
    assert.equal(fixture.state.eventScope.type, "unknown");
  } finally { fixture.state.eventScope = undefined; await page.close(); }
});
