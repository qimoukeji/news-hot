import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { capabilities, invalidateModelCache } from "@aihot/backend/editorial/models";
import { inMonitor } from "@aihot/reset-monitor/backend/context";
import { recognizePost } from "@aihot/reset-monitor/backend/recognize";
import { backendDefinition } from "../../claude-reset/backend-definition.ts";
import server from "../../claude-reset/server.ts";
import codexServer from "../../codex-reset/server.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import grokServer from "../../grok-reset/server.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";

installModules([codexServer, server, grokServer]);
const requests: Record<string, unknown>[] = [];
const provider = await stub((_hit, req) => {
  requests.push(JSON.parse(req.body));
  return { choices: [{ message: { content: JSON.stringify({ relevant: false, translationZh: "普通消息", contextZh: [], outage: null, needsReview: false, propositions: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "shared-llm", DEEPSEEK_BASE_URL: `${provider.url}/v1`, DEEPSEEK_API_KEY: "test-key", MONITOR_MODEL: "deepseek-flash", MODEL_CALLS_ENABLED: "true" });
after(async () => { await provider.close(); await closeDb(); });

test("Codex, Claude and Grok share MONITOR_MODEL, its default and one admin choice", async () => {
  const capability = capabilities().monitor!;
  assert.equal(capability.env, "MONITOR_MODEL");
  assert.deepEqual(capability.purposes.sort(), ["monitor.recognize", "reset_monitor.claude.recognize", "reset_monitor.grok.recognize"]);
  const recognize = (definition: typeof backendDefinition, id: string) => inMonitor(definition, () => recognizePost({ id, text: "An ordinary announcement.", publishedAt: new Date().toISOString(), context: [], openEvents: [] }));
  for (const definition of [codex, backendDefinition, grok]) {
    const result = await recognize(definition, `${definition.monitorId}-shared-model`);
    assert.equal(result.model, "deepseek-flash");
    assert.equal(requests.at(-1)!.model, "deepseek-flash");
    const [receipt] = await sql`SELECT service,model,purpose FROM receipts WHERE id=${result.receiptId}`;
    assert.equal(receipt!.service, "deepseek");
    assert.equal(receipt!.purpose, `${definition.names.purposePrefix}.recognize`);
  }
  delete process.env.MONITOR_MODEL;
  for (const definition of [codex, backendDefinition, grok]) {
    assert.equal((await recognize(definition, `${definition.monitorId}-default-model`)).model, "default");
    assert.equal(requests.at(-1)!.model, "shared-llm");
  }
  process.env.MONITOR_MODEL = "deepseek-flash";
  await sql`INSERT INTO settings (key,value) VALUES ('models.monitor', '{"model":"default"}'::jsonb)`;
  invalidateModelCache();
  for (const definition of [codex, backendDefinition, grok]) {
    assert.equal((await recognize(definition, `${definition.monitorId}-admin-model`)).model, "default");
    assert.equal(requests.at(-1)!.model, "shared-llm");
  }
  assert.equal(requests.length, 9);
});
