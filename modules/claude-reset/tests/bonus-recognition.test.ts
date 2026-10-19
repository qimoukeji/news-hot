import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { inMonitor } from "@aihot/reset-monitor/backend/context";
import { recognizePost } from "@aihot/reset-monitor/backend/recognize";
import { applyRecognition } from "@aihot/reset-monitor/backend/assemble";
import { resetPage } from "@aihot/reset-monitor/backend/read";
import { backendDefinition } from "../backend-definition.ts";
import server from "../server.ts";
import { cloudBonus } from "./cloud-bonus.fixture.ts";
import { bonusRecognition } from "./bonus-credit.fixture.ts";

installModules([server]);
const requests: Record<string, any>[] = [];
const provider = await stub((_hit, req) => {
  requests.push(JSON.parse(req.body));
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(bonusRecognition()) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "local-bonus-model", MONITOR_MODEL: "default" });
after(async () => { await provider.close(); await closeDb(); });

test("shared model receipts carry a bonus classification into scoped facts without using deadline as landing", async () => {
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,raw)
    VALUES ('claude',${cloudBonus.id},'ClaudeDevs',${new Date(cloudBonus.publishedAt)},${cloudBonus.text},${`https://x.com/ClaudeDevs/status/${cloudBonus.id}`},${sql.json({ context: cloudBonus.context })})`;
  const recognition = await inMonitor(backendDefinition, () => recognizePost({ id: cloudBonus.id, text: cloudBonus.text,
    publishedAt: cloudBonus.publishedAt, context: cloudBonus.context, openEvents: [] }));
  assert.equal(recognition.propositions[0]!.kind, "bonus_credit");
  assert.equal(recognition.model, "default");
  assert.match(requests[0]!.messages[0].content, /bonus_credit/);
  assert.match(requests[0]!.messages[0].content, /各句不能互借时区、年份/);
  assert.match(requests[0]!.messages[1].content, /one time bonus credit/);
  const applied = await inMonitor(backendDefinition, () => applyRecognition(cloudBonus.id, recognition));
  assert.equal(applied.eventIds.length, 1);
  const [receipt] = await sql`SELECT status,model,purpose,request,attempts FROM receipts WHERE id=${recognition.receiptId}`;
  assert.equal(receipt!.status, "completed");
  assert.equal(receipt!.purpose, "reset_monitor.claude.recognize");
  assert.equal(receipt!.attempts, 1);
  assert.equal(receipt!.request.promptVersion, backendDefinition.promptVersion);
  const page = await inMonitor(backendDefinition, () => resetPage(Date.parse("2026-10-07T00:00:00Z")));
  assert.equal(page.events[0]!.presentation!.status, "available");
  assert.deepEqual(page.events[0]!.presentation!.bonusCredit!.claimDeadline, {
    source: "Run /claim-credit in Claude Code by Oct 7 at 11:59pm PT.", at: null,
  });
  assert.equal(page.events[0]!.presentation!.bonusCredit!.expiresAt!.at, null);
  assert.equal(page.events[0]!.schedule, null);
  assert.equal(page.current, null);
  assert.equal(requests.length, 1);
  assert.equal((await sql`SELECT 1 FROM monitor_state WHERE monitor_id='claude' AND key LIKE 'cursor:%'`).length, 0);
  await inMonitor(backendDefinition, () => resetPage());
  assert.equal(requests.length, 1, "public projection must not call the model");
});
