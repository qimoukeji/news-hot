import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import type { WebhookDelivery, WebhookSubscription } from "../../../modules/reset-monitor/webhooks.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

const API = "/api/admin/reset-subscriptions";
const at = "2026-10-19T08:00:00.000Z";
const initial: WebhookSubscription = {
  id: "e2e9058c-bf76-4d41-9b26-4ba01836b730", name: "额度通知服务", url: "https://receiver.example/events",
  platforms: ["codex", "claude-code", "grok"], enabled: false, enabledAt: null, generation: 1, createdAt: at, updatedAt: at,
};
const deliveryFixture: WebhookDelivery = {
  id: "11969fad-2c8b-4d1c-8651-92542b5f7a96", subscriptionId: initial.id,
  notificationId: "382b3637-11e0-436a-9d1a-f63a1fcb224a", platform: "grok", eventId: "grok-event-42", action: "created", revision: 1,
  status: "failed", attempts: 5, nextAttemptAt: null, lastStatus: 503, lastError: "接收服务暂不可用", createdAt: at, sentAt: null,
};
const createdSecret = "fixture-created-secret-only-shown-once";
const rotatedSecret = "fixture-rotated-secret-only-shown-once";
const writes: Array<{ method: string; path: string; body: Record<string, unknown>; csrf: string | undefined; key: string | undefined }> = [];
const reads: string[] = [];
let subscriptions: WebhookSubscription[];
let delivery: WebhookDelivery;
let failRetry: boolean;
let web: WebServer;
let browser: Browser;

const api = createServer(async (req, res) => {
  const path = new URL(req.url!, "http://fixture").pathname;
  res.setHeader("Content-Type", "application/json");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (path === "/api/admin/me") return send({ name: "Fixture admin", csrf: "fixture-csrf", dev: true });
  if (["/api/admin/nav-counts", "/api/site/meta", "/api/health"].includes(path)) return send({});
  if (path === "/api/site/track") { res.statusCode = 204; return res.end(); }
  if (req.method === "GET" && path === API) { reads.push(path); return send({ subscriptions, pushEnabled: false }); }
  if (req.method === "GET" && path === `${API}/${initial.id}/deliveries`) { reads.push(path); return send({ deliveries: [delivery] }); }
  if (path.startsWith(API) && (req.method === "POST" || req.method === "PATCH")) {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as Record<string, unknown>;
    writes.push({ method: req.method, path, body, csrf: req.headers["x-csrf-token"] as string | undefined, key: req.headers["idempotency-key"] as string | undefined });
    if (req.method === "POST" && path === API) {
      const subscription: WebhookSubscription = { ...initial, id: "14647da0-520d-4a22-b575-31808b654a1d", name: String(body.name), url: String(body.url), platforms: body.platforms as WebhookSubscription["platforms"], enabled: false };
      subscriptions.push(subscription);
      return send({ subscription, secret: createdSecret });
    }
    if (req.method === "PATCH" && path === `${API}/${initial.id}`) {
      subscriptions[0] = { ...subscriptions[0]!, ...body, enabledAt: body.enabled ? at : null } as WebhookSubscription;
      return send(subscriptions[0]);
    }
    if (path === `${API}/${initial.id}/rotate-secret`) return send({ secret: rotatedSecret });
    if (path === `${API}/${initial.id}/deliveries/${delivery.id}/retry`) {
      if (failRetry) { failRetry = false; res.statusCode = 409; return send({ detail: "通知暂时不能重发，请稍后再试" }); }
      delivery = { ...delivery, status: "pending", nextAttemptAt: at, lastError: null };
      return send(delivery);
    }
  }
  res.statusCode = 404;
  send({ code: "not_found" });
});

before(async () => { web = await startWebServer(api); browser = await chromium.launch({ channel: "chromium" }); });
beforeEach(() => { subscriptions = [{ ...initial }]; delivery = { ...deliveryFixture }; failRetry = false; writes.length = 0; reads.length = 0; });
after(async () => { await browser?.close(); await web?.stop(); });

test("admin creates a disabled platform subscription and reveals signing secrets only in the current page", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${web.origin}/admin/reset-subscriptions`);
    await expect(page.getByRole("heading", { level: 1, name: "事件订阅", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "事件订阅", exact: true }).first()).toHaveAttribute("href", "/admin/reset-subscriptions");
    await expect(page.getByText("通知发送未开放", { exact: true })).toBeVisible();
    assert.ok(reads.includes(API));
    await page.getByRole("button", { name: "新增订阅", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("label").filter({ hasText: "名称" }).locator("input").fill("Codex 与 Grok 通知");
    await dialog.locator("label").filter({ hasText: "HTTPS 回调地址" }).locator("input").fill("https://new-receiver.example/events");
    await dialog.getByRole("checkbox", { name: "Claude", exact: true }).uncheck();
    await expect(dialog.getByRole("button", { name: "创建", exact: true })).toBeDisabled();
    await dialog.locator("textarea").fill("接入运营通知服务");
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByLabel("签名密钥", { exact: true })).toHaveValue(createdSecret);
    const created = writes.find(write => write.path === API)!;
    assert.deepEqual(created.body, { name: "Codex 与 Grok 通知", url: "https://new-receiver.example/events", platforms: ["codex", "grok"], reason: "接入运营通知服务" });
    assert.equal(created.csrf, "fixture-csrf");
    assert.ok(created.key);
    assert.equal(subscriptions.at(-1)!.enabled, false);
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.ok(!JSON.stringify(storage).includes(createdSecret));
    await page.getByRole("button", { name: "隐藏密钥", exact: true }).click();
    await expect(page.getByLabel("签名密钥", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "轮换密钥", exact: true }).first().click();
    await page.getByRole("dialog").locator("textarea").fill("更新接收服务凭据");
    await page.getByRole("dialog").getByRole("button", { name: "轮换", exact: true }).click();
    await expect(page.getByLabel("签名密钥", { exact: true })).toHaveValue(rotatedSecret);
    await page.reload();
    await expect(page.getByLabel("签名密钥", { exact: true })).toHaveCount(0);
    const html = await page.content();
    assert.ok(!html.includes(createdSecret) && !html.includes(rotatedSecret));
    assert.ok(!JSON.stringify(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).includes(rotatedSecret));
  } finally { await page.close(); }
});

test("admin enables a subscription and resends a failed delivery with an audited reason", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${web.origin}/admin/reset-subscriptions`);
    await page.getByRole("button", { name: "启用", exact: true }).click();
    await page.getByRole("dialog").locator("textarea").fill("接收服务已完成配置");
    await page.getByRole("dialog").getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.getByText("已启用", { exact: true })).toBeVisible();
    assert.deepEqual(writes[0]!.body, { enabled: true, reason: "接收服务已完成配置" });
    assert.equal(writes[0]!.method, "PATCH");
    await page.getByRole("link", { name: "投递记录", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`subscription=${initial.id}`));
    await expect(page.getByText("已失败", { exact: true })).toBeVisible();
    await expect(page.getByText("已尝试 5 次 · HTTP 503", { exact: true })).toBeVisible();
    await expect(page.getByText("接收服务暂不可用", { exact: true })).toBeVisible();
    assert.ok(reads.includes(`${API}/${initial.id}/deliveries`));
    failRetry = true;
    await page.getByRole("button", { name: "重新发送", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("textarea").fill("接收服务已经恢复");
    await dialog.getByRole("button", { name: "重新发送", exact: true }).click();
    await expect(page.getByText("通知暂时不能重发，请稍后再试", { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "重新发送", exact: true }).click();
    await expect(page.getByText("等待发送", { exact: true })).toBeVisible();
    await expect(page.getByText("已失败", { exact: true })).toHaveCount(0);
    const retries = writes.filter(write => write.path.endsWith("/retry"));
    assert.equal(retries.length, 2);
    assert.equal(retries[0]!.path, `${API}/${initial.id}/deliveries/${delivery.id}/retry`);
    assert.deepEqual(retries[1]!.body, { reason: "接收服务已经恢复" });
    assert.equal(retries[0]!.key, retries[1]!.key);
    assert.equal(retries[1]!.csrf, "fixture-csrf");
  } finally { await page.close(); }
});
