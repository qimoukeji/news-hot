import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { startWebServer, type WebServer } from "./web-server.ts";
import { createMonitorFixture, at, day, platforms, instant, dayInstant, range } from "./fixtures/reset-monitor.ts";
import { beijingDate } from "@aihot/contracts/time";
import { formatBusinessTime } from "../../../modules/reset-monitor/business-time.ts";

const fixture = createMonitorFixture();
let web: WebServer;
let browser: Browser;
before(async () => { web = await startWebServer(fixture.api); browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close(); await web?.stop(); });

for (const product of platforms) test(`${product.product} announcement keeps business time while the mobile timeline shows publication time`, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.clock.install({ time: new Date("2026-11-02T00:00:00Z") });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  fixture.state.status = "announced";
  await page.route(`${web.origin}/**`, route => route.continue());
  try {
    for (const [value, headline] of [
      [range("2026-10-31T05:42:26Z", "2026-11-02T05:42:26Z"), "13:42 前重置"],
      [dayInstant("2026-11-02"), "11月3日 02:00"],
      [instant("2026-12-31T23:59:07.123Z"), "1月1日 07:59"],
      [{ kind: "deadline", at: "2026-11-02T05:42:26Z" }, "11月2日 13:42 之前"],
    ] as const) {
      fixture.state.actionTimes = [value, instant(at)];
      await page.goto(`${web.origin}${product.path}/history/${day}`);
      if (value.kind === "range") await expect(page.getByRole("region", { name: "公开预告", exact: true }).getByText(formatBusinessTime(value), { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "公开预告", exact: true }).locator("p").first()).toHaveText(headline);
      await expect(page.getByRole("region", { name: "公开预告", exact: true }).locator("p").first()).toHaveAttribute("title", formatBusinessTime(value));
      const actionTime = page.getByRole("list", { name: "事件动作" }).locator("time").first();
      await expect(actionTime).toHaveText("2026-10-23 00:30");
      await expect(actionTime).toHaveAttribute("datetime", at);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    }
    assert.deepEqual(errors, []);
  } finally { fixture.state.status = "completed"; fixture.state.actionTimes = undefined; await page.close(); }
});

for (const width of [320, 1280]) for (const theme of ["light", "dark"]) test(`range announcements update Beijing midnight without changing API state at ${width}px in ${theme} mode`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.addInitScript(theme => localStorage.setItem("aihot-theme", theme), theme);
  await page.clock.install({ time: new Date("2026-11-02T15:59:50Z") });
  fixture.state.status = "announced";
  fixture.state.actionTimes = [range("2026-10-31T05:42:26Z", "2026-11-02T16:30:26Z"), instant(at)];
  try {
    await page.goto(`${web.origin}/codex-reset?month=2026-11`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const card = page.getByRole("region", { name: "公开预告", exact: true });
    await expect(card.locator("p").first()).toHaveText("11月3日 00:30 前重置");
    await expect(card.getByText("2026/10/31 13:42:26 – 2026/11/03 00:30:26", { exact: true })).toBeVisible();
    fixture.requests.length = 0;
    await page.clock.runFor(40_000);
    await expect(card.locator("p").first()).toHaveText("00:30 前重置");
    await page.clock.runFor(31 * 60_000);
    await expect(card.locator("p").first()).toHaveText("00:30 前重置");
    await expect(card).toHaveAttribute("data-forecast-state", "announced");
    assert.deepEqual(fixture.requests.filter(path => path.startsWith("/api/v2/")), []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  } finally { fixture.state.status = "completed"; fixture.state.actionTimes = undefined; await page.close(); }
});

test("range announcement and exact endpoints are available before hydration", async () => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 900 } });
  const page = await context.newPage();
  fixture.state.status = "announced";
  fixture.state.actionTimes = [range("2020-01-01T00:00:00Z", "2020-01-02T02:30:26Z"), instant(at)];
  try {
    await page.goto(`${web.origin}/codex-reset?month=2026-11`);
    const card = page.getByRole("region", { name: "公开预告", exact: true });
    await expect(card.locator("p").first()).toHaveText("1月2日 10:30 前重置");
    await expect(card.getByText("2020/01/01 08:00:00 – 2020/01/02 10:30:26", { exact: true })).toBeVisible();
    await expect(card).toHaveAttribute("data-forecast-state", "announced");
  } finally { fixture.state.status = "completed"; fixture.state.actionTimes = undefined; await context.close(); }
});

for (const product of platforms) test(`${product.product} public and admin timelines read each action's publication time independently of business time`, async () => {
  const page = await browser.newPage();
  await page.route(`${web.origin}/**`, route => route.continue()); // Each fixture edit must fetch fresh page data.
  fixture.state.actionPublishedAt = ["2026-10-22T16:31:07Z", "2026-10-22T16:30:06Z"];
  try {
    for (const time of [instant("2026-10-25T02:15:00Z"), dayInstant("2026-10-25"), range("2026-10-25T02:15:00Z", "2026-10-25T04:45:00Z")]) {
      fixture.state.actionTimes = [time, instant(at)];
      for (const path of [`${product.path}/history/${day}`, `${product.admin}?kind=events`]) {
        await page.goto(`${web.origin}${path}`);
        const row = page.locator("li").filter({ has: page.getByRole("heading", { name: /额度活动预告$/ }) });
        await expect(row.locator(":scope > time")).toHaveText("2026-10-23 00:31");
        await expect(row.locator(":scope > time")).toHaveAttribute("datetime", fixture.state.actionPublishedAt[0]);
        const confirmation = page.locator("li").filter({ has: page.getByRole("heading", { name: /额度活动状态确认$/ }) });
        await expect(confirmation.locator(":scope > time")).toHaveAttribute("datetime", fixture.state.actionPublishedAt[1]);
        await expect(confirmation.locator(":scope > time")).toHaveText("2026-10-23 00:30");
      }
    }
  } finally { fixture.state.actionTimes = undefined; fixture.state.actionPublishedAt = undefined; await page.close(); }
});

for (const product of platforms) test(`${product.product} public page reads v2 and renders actions with every saved source`, async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  fixture.requests.length = 0;
  try {
    await page.goto(`${web.origin}${product.path}/history/${day}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${product.product} 今天会重置吗？`);
    const accounts = { codex: "@thsottiaux", "claude-code": "@ClaudeDevs", grok: "@bot、@grok" }[product.platform];
    await expect(page.getByText(`关注 ${accounts} 发布的消息，筛选重置信号，推送提醒，省得你反复刷推`, { exact: true })).toBeVisible();
    const overview = page.locator('dl[aria-label="重置概览"]');
    await expect(overview.getByText(formatBusinessTime(instant(at)), { exact: true })).toBeVisible();
    await expect(overview.getByText("3.06 天", { exact: true })).toBeVisible();
    await expect(overview.getByRole("link", { name: "官方账号 1", exact: true })).toHaveAttribute("href", "https://example.org/account-0");
    await expect(overview.getByRole("link", { name: "官方账号 2", exact: true })).toHaveAttribute("href", "https://example.org/account-1");
    await expect(page.getByRole("region", { name: "预估时间", exact: true }).getByText("10月28日", { exact: true })).toBeVisible();
    const timeline = page.getByRole("list", { name: "事件动作" });
    await expect(timeline.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "额度活动状态确认" }) })).toHaveCount(1);
    await expect(timeline.getByRole("heading", { name: "额度活动预告" })).toBeVisible();
    await expect(timeline.locator('a[href="https://example.org/official-1"]')).toHaveCount(2);
    await expect(timeline.locator('a[href="https://example.org/official-2"]')).toHaveCount(1);
    await expect(page.getByText("已完成", { exact: true })).toBeVisible();
    await expect(page.getByText("仅限 Pro 用户", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /原文|回执核对/ })).toHaveCount(0);
    assert.ok(fixture.requests.includes("/api/v2/overview"));
    const query = fixture.requests.find(path => path.startsWith(`${product.list}?`));
    assert.ok(query);
    const url = new URL(query, "http://fixture");
    assert.equal(url.searchParams.get("timeZone"), "Asia/Shanghai");
    assert.equal(url.searchParams.get("from"), "2026-10-01");
    assert.equal(url.searchParams.get("to"), "2026-10-31");
    assert.equal(fixture.requests.some(path => /^\/api\/(v1|site\/.*reset)/.test(path)), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("calendar uses Beijing dates, filters selected day and navigates complete months", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/claude-reset?month=2026-10`);
    await expect(page.getByRole("button", { name: `${day}，1 个事件`, exact: true })).toBeVisible();
    fixture.requests.length = 0;
    await page.getByRole("button", { name: `${day}，1 个事件`, exact: true }).click();
    await expect(page.getByRole("heading", { name: "10 月 23 日", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Claude 官方活动" })).toBeVisible();
    await page.getByRole("button", { name: "2026-10-22，无事件", exact: true }).click();
    await expect(page.getByText("这段时间没有已收录的事件。")).toBeVisible();
    await page.getByRole("button", { name: "查看整月" }).click();
    await expect(page.getByRole("heading", { name: "Claude 官方活动" })).toBeVisible();
    assert.deepEqual(fixture.requests.filter(path => path.startsWith("/api/v2/")), []);
    fixture.requests.length = 0;
    await page.getByRole("link", { name: "下月 →", exact: true }).click();
    await expect(page).toHaveURL(/month=2026-11/);
    assert.ok(fixture.requests.some(path => path.includes("from=2026-11-01") && path.includes("to=2026-11-30")));
  } finally { await page.close(); }
});

for (const product of platforms) test(`${product.product} loads a full month once and filters or expands locally`, async () => {
  const page = await browser.newPage();
  fixture.state.publicEventCount = 26;
  fixture.requests.length = 0;
  const localRequests: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith(".data") || path.startsWith("/api/v2/")) localRequests.push(request.url());
  });
  try {
    await page.goto(`${web.origin}${product.path}?month=2026-10`);
    const list = page.getByRole("region", { name: "事件列表" });
    const cards = list.locator("article");
    const more = list.getByRole("button", { name: "显示更多", exact: true });
    await expect(cards).toHaveCount(3);
    const firstTitles = await cards.locator("h3").allTextContents();
    const initialQueries = fixture.requests.filter(path => path.startsWith(`${product.list}?`));
    assert.equal(initialQueries.length, 1);
    const query = new URL(initialQueries[0]!, "http://fixture");
    assert.equal(query.searchParams.get("from"), "2026-10-01");
    assert.equal(query.searchParams.get("to"), "2026-10-31");
    assert.equal(query.searchParams.has("limit"), false);
    assert.equal(fixture.requests.filter(path => path === "/api/v2/overview").length, 1);
    fixture.requests.length = 0; localRequests.length = 0;
    await more.click(); await expect(cards).toHaveCount(13);
    assert.deepEqual((await cards.locator("h3").allTextContents()).slice(0, 3), firstTitles);
    await more.click(); await expect(cards).toHaveCount(23);
    await more.click(); await expect(cards).toHaveCount(26);
    await expect(more).toHaveCount(0);

    const selectedDay = page.getByRole("button", { name: `${day}，16 个事件`, exact: true });
    await expect(selectedDay).toHaveAttribute("title", `${day}：16 个事件`);
    await selectedDay.hover();
    await selectedDay.click(); await expect(cards).toHaveCount(3);
    await expect(selectedDay).toHaveAttribute("aria-pressed", "true");
    await more.click(); await expect(cards).toHaveCount(13);
    await more.click(); await expect(cards).toHaveCount(16);
    await expect(more).toHaveCount(0);
    await selectedDay.click(); await expect(cards).toHaveCount(3);
    await expect(selectedDay).toHaveAttribute("aria-pressed", "false");
    await expect(list.getByRole("heading", { name: "10 月", exact: true })).toBeVisible();

    const emptyDay = page.getByRole("button", { name: "2026-10-21，无事件", exact: true });
    await expect(emptyDay).toHaveAttribute("title", "2026-10-21：0 个事件");
    await emptyDay.click(); await expect(cards).toHaveCount(0);
    await expect(list.getByText("这段时间没有已收录的事件。")).toBeVisible();
    await expect(more).toHaveCount(0);
    await emptyDay.click(); await expect(cards).toHaveCount(3);
    await page.getByRole("button", { name: "2026-10-22，10 个事件", exact: true }).click();
    await list.getByRole("button", { name: "查看整月" }).click();
    await expect(cards).toHaveCount(3);
    await selectedDay.click();
    await page.getByRole("button", { name: "2026-10", exact: true }).click();
    await expect(cards).toHaveCount(3);
    await expect(selectedDay).toHaveAttribute("aria-pressed", "false");
    assert.deepEqual(localRequests, []);
    assert.deepEqual(fixture.requests.filter(path => path.startsWith("/api/v2/")), []);

    await more.click(); await expect(cards).toHaveCount(13);
    await page.getByRole("link", { name: "下月 →", exact: true }).click();
    await expect(page).toHaveURL(/month=2026-11$/);
    await expect(cards).toHaveCount(3);
    await expect(list.getByRole("heading", { name: "11 月", exact: true })).toBeVisible();
    const monthQueries = fixture.requests.filter(path => path.startsWith(`${product.list}?`));
    assert.equal(monthQueries.length, 1);
    assert.match(monthQueries[0]!, /from=2026-11-01&to=2026-11-30/);
    fixture.requests.length = 0;
    await page.getByRole("button", { name: "2026-11-23，16 个事件", exact: true }).click();
    await page.getByRole("link", { name: "← 上月", exact: true }).click();
    await expect(page).toHaveURL(/month=2026-10$/);
    await expect(cards).toHaveCount(3);
    await expect(list.getByRole("heading", { name: "10 月", exact: true })).toBeVisible();
    assert.equal(fixture.requests.filter(path => path.startsWith(`${product.list}?`)).length, 1);
  } finally { fixture.state.publicEventCount = 1; await page.close(); }
});

test("entry without a month loads the complete current Beijing month", async () => {
  const page = await browser.newPage();
  fixture.state.publicEventCount = 26;
  fixture.requests.length = 0;
  try {
    const month = beijingDate(new Date().toISOString()).slice(0, 7);
    const [year, number] = month.split("-").map(Number) as [number, number];
    await page.goto(`${web.origin}/codex-reset`);
    await expect(page.getByRole("region", { name: "事件列表" }).locator("article")).toHaveCount(3);
    const queries = fixture.requests.filter(path => path.startsWith("/api/v2/codex-resets?"));
    assert.equal(queries.length, 1);
    const query = new URL(queries[0]!, "http://fixture");
    assert.equal(query.searchParams.get("from"), `${month}-01`);
    assert.equal(query.searchParams.get("to"), `${month}-${new Date(Date.UTC(year, number, 0)).getUTCDate()}`);
    await expect(page.getByRole("button", { name: `${month}-23，16 个事件`, exact: true })).toBeVisible();
  } finally { fixture.state.publicEventCount = 1; await page.close(); }
});

test("a month with no events has no more button and date toggling stays local", async () => {
  const page = await browser.newPage();
  fixture.state.publicEventCount = 0;
  try {
    await page.goto(`${web.origin}/codex-reset?month=2026-10`);
    const list = page.getByRole("region", { name: "事件列表" });
    await expect(list.getByText("这段时间没有已收录的事件。")).toBeVisible();
    fixture.requests.length = 0;
    const date = page.getByRole("button", { name: `${day}，无事件`, exact: true });
    await date.click(); await expect(date).toHaveAttribute("aria-pressed", "true");
    await date.click(); await expect(date).toHaveAttribute("aria-pressed", "false");
    await expect(list.getByRole("button", { name: "显示更多" })).toHaveCount(0);
    assert.deepEqual(fixture.requests.filter(path => path.startsWith("/api/v2/")), []);
  } finally { fixture.state.publicEventCount = 1; await page.close(); }
});

test("invalid calendar dates are rejected before querying the event API", async () => {
  fixture.requests.length = 0;
  const response = await fetch(`${web.origin}/claude-reset/history/2026-02-30`);
  assert.equal(response.status, 404);
  assert.equal(fixture.requests.some(path => path.startsWith("/api/v2/claude-resets")), false);
});

test("a public announcement takes precedence over prediction and keeps the last reset independent", async () => {
  const page = await browser.newPage();
  fixture.state.status = "announced";
  try {
    await page.goto(`${web.origin}/claude-reset/history/${day}`);
    await expect(page.locator('dl[aria-label="重置概览"]').getByText(formatBusinessTime(instant("2026-10-20T16:30:00Z")), { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "公开预告", exact: true }).getByText("10月23日 00:30", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "预估时间", exact: true })).toHaveCount(0);
    fixture.state.predictedResetTime = null;
    await page.reload();
    await expect(page.getByRole("region", { name: "公开预告", exact: true }).getByText("10月23日 00:30", { exact: true })).toBeVisible();
  } finally { fixture.state.status = "completed"; fixture.state.predictedResetTime = "2026-10-28T00:00:00Z"; await page.close(); }
});

for (const product of platforms) test(`${product.product} saved announcement default stays public without using the prediction`, async () => {
  const page = await browser.newPage();
  fixture.state.status = "announced";
  fixture.state.actionTimes = [dayInstant("2026-10-22"), instant(at)];
  fixture.state.predictedResetTime = "2030-01-01T00:00:00Z";
  try {
    await page.goto(`${web.origin}${product.path}/history/${day}`);
    const announcement = page.getByRole("region", { name: "公开预告", exact: true });
    await expect(announcement).toHaveAttribute("data-forecast-state", "announced");
    await expect(announcement.locator("p").first()).toHaveText("10月23日 02:00");
    await expect(page.getByRole("region", { name: "预估时间", exact: true })).toHaveCount(0);
    const list = page.getByRole("region", { name: "事件列表" });
    await expect(list.getByText("时间未公布", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `${day}，1 个事件`, exact: true })).toBeVisible();
  } finally {
    fixture.state.status = "completed"; fixture.state.actionTimes = undefined;
    fixture.state.predictedResetTime = "2026-10-28T00:00:00Z"; await page.close();
  }
});

for (const product of platforms) test(`${product.product} forecast follows the API when dates elapse or forecast data is missing`, async () => {
  const page = await browser.newPage();
  fixture.state.status = "announced";
  fixture.state.actionTimes = [instant("2020-01-01T05:42:26Z"), instant(at)];
  fixture.state.predictedResetTime = "2030-01-01T00:00:00Z";
  await page.route(`${web.origin}/**`, route => route.continue());
  try {
    await page.goto(`${web.origin}${product.path}/history/${day}`);
    const announcement = page.getByRole("region", { name: "公开预告", exact: true });
    await expect(announcement).toHaveAttribute("data-forecast-state", "announced");
    await expect(announcement.locator("p").first()).toHaveText("1月1日 13:42");
    await expect(announcement).not.toContainText("已完成");
    fixture.state.status = "completed";
    fixture.state.predictedResetTime = "2020-01-01T05:42:26Z";
    await page.reload();
    const forecast = page.getByRole("region", { name: "预估时间", exact: true });
    await expect(forecast).toHaveAttribute("data-forecast-state", "estimated");
    await expect(forecast.locator("p").first()).toHaveText("1月1日");
    await expect(forecast.getByRole("status")).toHaveText("已过预估时间");
    fixture.state.predictedResetTime = null;
    await page.reload();
    await expect(forecast).toHaveAttribute("data-forecast-state", "missing");
    await expect(forecast.getByText("暂无数据", { exact: true })).toBeVisible();
    await expect(forecast).not.toContainText("2026");
    await expect(page.locator('dl[aria-label="重置概览"]').getByText(formatBusinessTime(instant(at)), { exact: true })).toBeVisible();
  } finally {
    fixture.state.status = "completed"; fixture.state.actionTimes = undefined;
    fixture.state.predictedResetTime = "2026-10-28T00:00:00Z"; await page.close();
  }
});

test("overview cards render UTC instant strings in Beijing time and preserve missing values", async () => {
  const page = await browser.newPage();
  try {
    fixture.state.typicalInterval = { value: 1.5, unit: "hour", sampleCount: 2 };
    fixture.state.resetTime = "2026-10-23T16:00:00Z";
    fixture.state.predictedResetTime = "2026-10-27T18:00:00Z";
    await page.goto(`${web.origin}/codex-reset?month=2026-10`);
    const overview = page.locator('dl[aria-label="重置概览"]');
    const prediction = page.getByRole("region", { name: "预估时间", exact: true });
    await expect(overview.getByText("2026/10/24 00:00:00", { exact: true })).toBeVisible();
    await expect(overview.getByText("1.5 小时", { exact: true })).toBeVisible();
    await expect(prediction.getByText("10月28日", { exact: true })).toBeVisible();
    fixture.state.resetTime = "2026-10-24T01:00:00.123456789Z";
    fixture.state.predictedResetTime = "2026-11-02T00:00:00.987654321Z";
    await page.reload();
    await expect(overview.getByText("2026/10/24 09:00:00", { exact: true })).toBeVisible();
    await expect(prediction.getByText("11月2日", { exact: true })).toBeVisible();
    await expect(prediction.locator("p").first()).toHaveAttribute("title", "2026/11/02 08:00:00");
    fixture.state.typicalInterval = null; fixture.state.predictedResetTime = null; fixture.state.resetTime = null;
    await page.reload();
    await expect(overview.getByText("暂无记录", { exact: true })).toBeVisible();
    await expect(overview.getByText("暂无数据", { exact: true })).toBeVisible();
    await expect(prediction.getByText("暂无数据", { exact: true })).toBeVisible();
  } finally {
    fixture.state.typicalInterval = { value: 3.0625, unit: "day", sampleCount: 5 };
    fixture.state.predictedResetTime = "2026-10-28T00:00:00Z";
    delete fixture.state.resetTime;
    await page.close();
  }
});

test("an expired prediction retains its supplied instant and only changes the notice", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
  await page.clock.install({ time: new Date("2026-11-02T05:42:00Z") });
  const predicted = "2026-11-02T05:42:26.123456789Z";
  fixture.state.predictedResetTime = predicted;
  try {
    await page.goto(`${web.origin}/codex-reset?month=2026-11`);
    const card = page.getByRole("region", { name: "预估时间", exact: true });
    await expect(card.locator("p").first()).toHaveText("11月2日");
    await expect(card.getByRole("status")).toHaveCount(0);
    fixture.requests.length = 0;
    await page.clock.runFor(30_000);
    await expect(card.getByRole("status")).toHaveText("已过预估时间");
    await expect(card.locator("p").first()).toHaveText("11月2日");
    await expect(card.locator("p").first()).toHaveAttribute("title", "2026/11/02 13:42:26");
    assert.equal(fixture.state.predictedResetTime, predicted);
    assert.deepEqual(fixture.requests.filter(path => path.startsWith("/api/v2/")), []);
  } finally { fixture.state.predictedResetTime = "2026-10-28T00:00:00Z"; await page.close(); }
});
