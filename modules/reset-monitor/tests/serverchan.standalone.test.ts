import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { serverChan, sendServerChan, sendServerChanWithTransport } from "../backend/serverchan.ts";

const key = "SCTSyntheticProviderTestKey";
const message = { title: "[Codex] 帖子待人工核对", description: "帖子：Synthetic post\n\n[到后台处理](https://example.test/admin?kind=posts&q=123)" };
beforeEach(() => { process.env.SERVERCHAN_ENABLED = "false"; process.env.SERVERCHAN_SENDKEY = key; });
afterEach(() => { mock.restoreAll(); delete process.env.SERVERCHAN_SENDKEY; assert.equal(process.env.SERVERCHAN_ENABLED, "false"); });

test("the real transport entry point never invokes fetch while disabled", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("real fetch must not run"); });
  assert.equal(serverChan.enabled(), false);
  assert.deepEqual(await sendServerChan(message), { status: "disabled" });
  delete process.env.SERVERCHAN_SENDKEY; assert.equal(serverChan.enabled(), false);
  assert.deepEqual(await sendServerChan(message), { status: "disabled" });
  assert.equal(fetch.mock.callCount(), 0);
});

test("missing, blank and malformed SendKeys fail before invoking any transport", async () => {
  const transport = mock.fn<typeof fetch>(async () => { throw new Error("transport must not be called"); });
  for (const value of [undefined, "", " ", "not-a-turbo-key", "SCTbad/key", "SCTbad?secret=key"]) {
    const result = await sendServerChanWithTransport(value, message, transport);
    assert.deepEqual(result, { status: "failed", error: { code: "invalid_key" } });
  }
  assert.equal(transport.mock.callCount(), 0);
});

test("success uses a form POST, disallows redirects and supplies a timeout signal", async () => {
  const transport = mock.fn<typeof fetch>(async (url, init) => {
    assert.equal(url, `https://sctapi.ftqq.com/${key}.send`);
    assert.equal(init!.method, "POST"); assert.equal(init!.redirect, "error");
    assert.ok(init!.signal instanceof AbortSignal); assert.equal(init!.signal!.aborted, false);
    assert.ok(init!.body instanceof URLSearchParams);
    assert.equal(init!.body.get("title"), message.title); assert.equal(init!.body.get("desp"), message.description);
    return Response.json({ code: 0, data: { pushid: "synthetic" } });
  });
  assert.deepEqual(await sendServerChanWithTransport(key, message, transport), { status: "sent" });
  assert.equal(transport.mock.callCount(), 1);
  assert.equal(process.env.SERVERCHAN_ENABLED, "false");
});

test("HTTP refusal returns only the status and never leaks a credential-bearing response body", async () => {
  const transport = mock.fn<typeof fetch>(async () => new Response(`secret=${key}`, { status: 503 }));
  const result = await sendServerChanWithTransport(key, message, transport);
  assert.deepEqual(result, { status: "failed", error: { code: "http", status: 503 } });
  assert.equal(JSON.stringify(result).includes(key), false); assert.equal(transport.mock.callCount(), 1);
});

test("nonzero provider code is a terminal failure without echoing supplier messages or credentials", async () => {
  const transport = mock.fn<typeof fetch>(async () => Response.json({ code: 40001, message: `https://sctapi.ftqq.com/${key}.send` }));
  const result = await sendServerChanWithTransport(key, message, transport);
  assert.deepEqual(result, { status: "failed", error: { code: "rejected", providerCode: 40001 } });
  assert.equal(JSON.stringify(result).includes(key), false); assert.equal(transport.mock.callCount(), 1);
});

for (const response of [{}, { code: "0" }, { code: 0.1 }, { code: Number.MAX_SAFE_INTEGER + 1 }, { data: { code: 0 } }, null]) test(`ambiguous JSON ${JSON.stringify(response)} is unknown and is not retried`, async () => {
  const transport = mock.fn<typeof fetch>(async () => Response.json(response));
  const result = await sendServerChanWithTransport(key, message, transport);
  assert.deepEqual(result, { status: "unknown", error: { code: "unconfirmed" } });
  assert.equal(transport.mock.callCount(), 1);
});

test("unreadable response is unknown and cannot expose the secret-bearing body", async () => {
  const transport = mock.fn<typeof fetch>(async () => new Response(`invalid JSON https://sctapi.ftqq.com/${key}.send`));
  const result = await sendServerChanWithTransport(key, message, transport);
  assert.deepEqual(result, { status: "unknown", error: { code: "unconfirmed" } });
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(transport.mock.callCount(), 1);
});

test("the configured timeout aborts the transport once and leaves an unknown, sanitized outcome", async () => {
  const controller = new AbortController();
  mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 10_000); return controller.signal;
  });
  const transport = mock.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    queueMicrotask(() => controller.abort(new DOMException(`timeout https://sctapi.ftqq.com/${key}.send`, "TimeoutError")));
  }));
  const result = await sendServerChanWithTransport(key, message, transport);
  assert.equal(controller.signal.aborted, true); assert.equal(result.status, "unknown");
  assert.deepEqual(result, { status: "unknown", error: { code: "transport" } });
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(transport.mock.callCount(), 1);
});

for (const name of ["TimeoutError", "TypeError"]) test(`${name} is unknown, sanitized and never retried`, async () => {
  const transport = mock.fn<typeof fetch>(async () => {
    const error = new Error(`failed to fetch https://sctapi.ftqq.com/${key}.send`);
    error.name = name; throw error;
  });
  const result = await sendServerChanWithTransport(key, message, transport);
  assert.deepEqual(result, { status: "unknown", error: { code: "transport" } });
  assert.equal(JSON.stringify(result).includes(key), false); assert.equal(JSON.stringify(result).includes("sctapi.ftqq.com"), false);
  assert.equal(transport.mock.callCount(), 1);
});
