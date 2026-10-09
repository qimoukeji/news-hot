import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { z } from "zod";
import { sql, closeDb } from "@aihot/backend/db";
import { chatJson, MODELS } from "@aihot/backend/providers/llm";
import { ReceiptUnknownError } from "@aihot/backend/providers/receipts";

after(closeDb);
const keys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_EXTRA_JSON", "LLM_TEMPERATURE", "LLM_MAX_TOKENS", "LLM_TIMEOUT_MS", "LLM_REASONING_TOKENS", "LLM_JSON_MODE"];
let saved: Array<[string, string | undefined]>;
beforeEach(() => {
  saved = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
});
afterEach(() => {
  for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});
const answer = () => ({ choices: [{ message: { content: '{"ok":true}' } }] });
const opts = { model: "default", purpose: "test.request.config", subject: "test", promptVersion: "test", system: "", user: "hello", schema: z.object({ ok: z.boolean() }), temperature: 0.1, maxTokens: 6000 };
function configure(url: string) {
  Object.assign(process.env, { LLM_BASE_URL: url, LLM_API_KEY: "test-key", LLM_MODEL: "stub" });
}

test("configured zero temperature and small total output cap replace step defaults and reasoning budget", async () => {
  let body: Record<string, unknown> = {};
  const model = await stub((_hit, req) => { body = JSON.parse(req.body); return answer(); });
  try {
    configure(model.url);
    Object.assign(process.env, { LLM_TEMPERATURE: "0", LLM_MAX_TOKENS: "256", LLM_REASONING_TOKENS: "4000", LLM_JSON_MODE: "false" });
    const result = await chatJson(opts);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 256);
    assert.equal(body.response_format, undefined);
    const [receipt] = await sql`SELECT request FROM receipts WHERE id=${result.receiptId}`;
    assert.equal(receipt!.request.temperature, 0);
    assert.equal(receipt!.request.maxTokens, 256);
  } finally { await model.close(); }
});

test("extra configuration wins over per-call fields and receipt identity tracks actual parameters", async () => {
  const bodies: Record<string, unknown>[] = [];
  const model = await stub((_hit, req) => { bodies.push(JSON.parse(req.body)); return answer(); });
  try {
    configure(model.url);
    Object.assign(process.env, { LLM_TEMPERATURE: "0.9", LLM_MAX_TOKENS: "5000", LLM_EXTRA_JSON: '{"temperature":0,"max_tokens":128,"thinking":{"type":"enabled"}}' });
    const first = await chatJson({ ...opts, extra: { thinking: { type: "disabled" } } });
    const same = await chatJson({ ...opts, temperature: 0.7, maxTokens: 9000, extra: { thinking: { type: "disabled" } } });
    assert.equal(same.reused, true);
    assert.equal(same.receiptId, first.receiptId);
    assert.deepEqual(bodies[0]!.thinking, { type: "enabled" });
    assert.equal(bodies[0]!.temperature, 0);
    assert.equal(bodies[0]!.max_tokens, 128);
    process.env.LLM_EXTRA_JSON = '{"temperature":0.4,"max_tokens":256,"thinking":{"type":"enabled"}}';
    const changed = await chatJson({ ...opts, extra: { thinking: { type: "disabled" } } });
    assert.notEqual(changed.receiptId, first.receiptId);
    assert.equal(bodies[1]!.temperature, 0.4);
    assert.equal(bodies[1]!.max_tokens, 256);
    assert.equal(model.hits(), 2);
  } finally { await model.close(); }
});

test("missing configuration uses capability defaults, then generic defaults", async () => {
  const bodies: Record<string, unknown>[] = [];
  const model = await stub((_hit, req) => { bodies.push(JSON.parse(req.body)); return answer(); });
  try {
    configure(model.url);
    process.env.LLM_REASONING_TOKENS = "4000";
    await chatJson(opts);
    assert.equal(bodies[0]!.temperature, 0.1);
    assert.equal(bodies[0]!.max_tokens, 10000);
    delete process.env.LLM_REASONING_TOKENS;
    await chatJson({ ...opts, subject: "generic", temperature: undefined, maxTokens: undefined });
    assert.equal(bodies[1]!.temperature, 0.2);
    assert.equal(bodies[1]!.max_tokens, 1500);
  } finally { await model.close(); }
});

test("configured timeout replaces a shorter per-call timeout; absent configuration uses the call timeout", async () => {
  const model = await stub(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return answer(); });
  try {
    configure(model.url);
    process.env.LLM_TIMEOUT_MS = "2000";
    const success = await chatJson({ ...opts, timeoutMs: 10 });
    const [receipt] = await sql`SELECT request FROM receipts WHERE id=${success.receiptId}`;
    assert.equal(receipt!.request.timeoutMs, 2000);
    delete process.env.LLM_TIMEOUT_MS;
    await assert.rejects(chatJson({ ...opts, subject: "timeout", user: "timeout", timeoutMs: 10 }), ReceiptUnknownError);
  } finally { await model.close(); }
});

test("named models use their own parameter configuration rather than the default model environment", async () => {
  let body: Record<string, unknown> = {};
  const model = await stub((_hit, req) => { body = JSON.parse(req.body); return answer(); });
  MODELS["test-configured"] = { key: "test-configured", service: "llm", model: "named", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY", jsonMode: true, temperature: 0.3, maxTokens: 700, timeoutMs: 2000, reasoningTokens: 4000, extra: { thinking: { type: "enabled" } } };
  try {
    configure(model.url);
    Object.assign(process.env, { LLM_TEMPERATURE: "0.9", LLM_MAX_TOKENS: "10000" });
    await chatJson({ ...opts, model: "test-configured", extra: { thinking: { type: "disabled" } } });
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_tokens, 700);
    assert.deepEqual(body.thinking, { type: "enabled" });
  } finally { delete MODELS["test-configured"]; await model.close(); }
});

test("invalid configuration fails before a paid attempt instead of silently using defaults", async () => {
  const model = await stub(answer);
  try {
    configure(model.url);
    const [before] = await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
    for (const [key, value] of [["LLM_TEMPERATURE", "nope"], ["LLM_MAX_TOKENS", "0"], ["LLM_TIMEOUT_MS", "-1"], ["LLM_EXTRA_JSON", "[]"], ["LLM_EXTRA_JSON", '{"max_tokens":null}']] as const) {
      process.env[key] = value;
      await assert.rejects(chatJson(opts));
      delete process.env[key];
    }
    const [after] = await sql`SELECT count(*)::int AS n FROM receipt_attempts`;
    assert.equal(after!.n, before!.n);
    assert.equal(model.hits(), 0);
  } finally { await model.close(); }
});
