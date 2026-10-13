import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { buildApp } from "../../../apps/api/src/app.ts";
import { createMonitorServer } from "../server.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";

after(async () => { installModules([]); await closeDb(); });

test("every monitor sitemap URL uses the publication origin once and resolves to its page", async () => {
  const definitions = [codex, claude, grok];
  installModules(definitions.map(createMonitorServer));
  const app = await buildApp();
  try {
    const response = await app.inject("/sitemap.xml");
    assert.equal(response.statusCode, 200);
    const locations = Array.from(response.body.matchAll(/<loc>([^<]+)<\/loc>/g), match => match[1]!);
    for (const definition of definitions) {
      const expected = new URL(definition.pagePath, config.siteUrl).href;
      const matching = locations.filter(loc => loc.includes(definition.pagePath));
      assert.deepEqual(matching, [expected]);
      assert.equal(new URL(matching[0]!).pathname, definition.pagePath);
    }
  } finally {
    await app.close();
  }
});
