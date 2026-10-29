import "./standalone.ts";
import { siteQueueSelection } from "./setup.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEPLOYMENT } from "@aihot/site";
import { ensureQueue, enqueue, enqueueOn, queueEnabled, QueueDisabledError, work, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { buildApp } from "../apps/api/src/app.ts";
import { adminHandler } from "../apps/api/src/routes/admin-auth.ts";
import { config } from "@aihot/backend/config";
import type { PgBoss } from "pg-boss";

afterEach(() => { DEPLOYMENT.queues = null; installModules([]); });
test("the site queue selection allows independent monitor translation, collection, confirmation checks and subscription delivery", () => {
  assert.deepEqual(siteQueueSelection?.slice().sort(), ["cron.claude-reset.tick", "cron.claude-reset.translate", "cron.codex-reset.translate", "cron.grok-reset.tick", "cron.grok-reset.translate", "cron.monitor.tick", "cron.reset-confirmations.check", "cron.reset-subscriptions.sweep", "reset-subscriptions.deliver"]);
  DEPLOYMENT.queues = siteQueueSelection;
  for (const name of siteQueueSelection!) assert.equal(queueEnabled(name), true);
  for (const name of ["content.analyze", "content.translate", "cron.content.translate", "sources.fetch", "reset.webhook", "cron.ops.recover"])
    assert.equal(queueEnabled(name), false, name);
  DEPLOYMENT.queues = [];
  assert.equal(queueEnabled("cron.monitor.tick"), false);
  DEPLOYMENT.queues = null;
  assert.equal(queueEnabled("content.analyze"), true);
});

test("disabled producers fail before any database or pg-boss connection can be opened", async () => {
  DEPLOYMENT.queues = siteQueueSelection;
  await assert.rejects(ensureQueue("content.analyze"), QueueDisabledError);
  await assert.rejects(enqueue("content.analyze", { articleId: "disabled" }), QueueDisabledError);
  await assert.rejects(enqueueOn({ name: "fixture.disabled", options: {}, worker: {}, run: async () => null }, {}), QueueDisabledError);
});

test("disabled framework and module consumers do not create or register queues", async () => {
  DEPLOYMENT.queues = siteQueueSelection;
  const boss = { work() { throw new Error("Disabled consumer was registered"); } } as unknown as PgBoss;
  await work(boss, "content.analyze", {}, async () => null);
  installModules([{ name: "fixture", queues: [{ name: "fixture.disabled", options: {}, worker: {}, run: async () => null }] }]);
  await workModuleQueues(boss);
});

test("API queue refusal identifies the disabled site configuration without a retry hint", async () => {
  DEPLOYMENT.queues = siteQueueSelection;
  const app = await buildApp();
  app.post("/api/queue-selection-test", async () => enqueue("content.analyze", { articleId: "disabled" }));
  app.post("/api/admin/queue-selection-test", adminHandler(async () => enqueue("content.analyze", { articleId: "disabled" })));
  const originalAdmin = config.devAdmin;
  config.devAdmin = { displayName: "Queue policy fixture" };
  try {
    for (const url of ["/api/queue-selection-test", "/api/admin/queue-selection-test"]) {
      const response = await app.inject({ method: "POST", url, headers: { "x-csrf-token": "dev" } });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().code, "queue_disabled");
      assert.match(response.json().detail, /content\.analyze.*disabled by site configuration/);
      assert.equal(response.headers["retry-after"], undefined);
    }
  } finally { config.devAdmin = originalAdmin; await app.close(); }
});
