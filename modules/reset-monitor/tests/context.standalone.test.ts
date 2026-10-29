import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { inMonitor, monitor, purpose, auditSubject, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { createMonitorServer, monitorNames } from "../server.ts";
import { createMonitorModule } from "../module.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";

export const third: ResetMonitorBackendDefinition = {
  ...claude, monitorId: "testai", moduleName: "testai-reset", authors: [{ handle: "TestAI", name: "TestAI" }], authorName: "TestAI", product: "TestAI",
  pagePath: "/testai-reset", adminPath: "/admin/testai-reset", adminApiPath: "/api/admin/testai-reset",
  publicApiPath: "/api/v2/testai-resets", agentPath: "/testai-resets",
  mcpTool: "get_testai_resets", names: monitorNames("testai"), providerEnv: "TESTAI_RESET_PROVIDER",
  scanMinutesEnv: "TESTAI_RESET_SCAN_MINUTES",
};

test("monitor scopes follow parallel awaits and restore the caller scope", async () => {
  assert.throws(() => monitor(), /requires a bound definition/);
  const seen = await Promise.all([codex, claude, third].map((definition) => inMonitor(definition, async () => {
    await Promise.resolve();
    assert.equal(monitor().monitorId, definition.monitorId);
    await inMonitor(third, async () => { await Promise.resolve(); assert.equal(monitor().monitorId, "testai"); });
    assert.equal(monitor().monitorId, definition.monitorId);
    return [purpose("recognize"), auditSubject("post", "shared-id")];
  })));
  assert.deepEqual(seen, [
    ["monitor.recognize", "monitor-post:shared-id"],
    ["reset_monitor.claude.recognize", "reset_monitor.claude-post:shared-id"],
    ["reset_monitor.testai.recognize", "reset_monitor.testai-post:shared-id"],
  ]);
  assert.throws(() => monitor(), /requires a bound definition/);
});

test("a third monitor registers unique backend and page entries without engine edits", () => {
  const backend = createMonitorServer(third);
  assert.equal(backend.name, "testai-reset");
  assert.deepEqual(backend.schedules!.map((schedule) => [schedule.name, schedule.retryLimit]), [["testai-reset.translate", 0], ["testai-reset.tick", 0]]);
  assert.equal(backend.models!.monitor!.env, "MONITOR_MODEL");
  assert.equal(backend.agent!.abilities![0]!.mcp.tool, "get_testai_resets");
  assert.match(JSON.stringify(createMonitorModule(third)), /testai-reset/);
  assert.throws(() => createMonitorServer({ ...third, monitorId: "untrusted/monitor" }), /Invalid reset monitor ID/);
  assert.throws(() => createMonitorServer({ ...third, collection: { includeReplies: true, includeSelfReplies: true, resetOnly: true, keywords: [] } }), /Invalid reset monitor collection/);
});
