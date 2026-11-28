import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createDatabase } from "@aihot/backend/db";
import { properName } from "../backend/public-v2.ts";

const script = fileURLToPath(new URL("../scripts/gemini-backfill.ts", import.meta.url));
const sourceUrl = new URL(process.env.DATABASE_URL!);
const start = new Date("2026-08-31T16:00:00Z").getTime();

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const noTestPacing = "data:text/javascript," + encodeURIComponent('import timers from "node:timers/promises"; timers.setTimeout = async () => {}');
    const child = spawn(process.execPath, ["--import", noTestPacing, script, ...args], { env, windowsHide: true });
    let out = "";
    child.stdout.on("data", data => { out += String(data); });
    child.stderr.on("data", data => { out += String(data); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, out }));
  });
}

test("isolated Gemini staging shares budget and syncs a historical baseline without any delivery", { timeout: 110_000 }, async () => {
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const stageName = "reset_" + randomUUID().replaceAll("-", "").slice(0, 12) + "_gemini_stage";
  const stageUrl = new URL(sourceUrl);
  stageUrl.pathname = "/" + stageName;
  const admin = createDatabase(adminUrl.toString());
  const ledger = createDatabase(sourceUrl.toString());
  const stage = createDatabase(stageUrl.toString());
  const directory = await mkdtemp(join(tmpdir(), "gemini-test-"));
  const bundle = join(directory, "bundle.json");
  const backup = join(directory, "backup.dump");
  let paid = 0;
  const fake = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    assert.equal(url.pathname, "/twitter/tweet/advanced_search");
    assert.ok(url.searchParams.get("query")?.startsWith("from:_mohansolo "));
    paid++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ tweets: [], has_next_page: false }));
  });
  await new Promise<void>(resolve => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address();
  assert.ok(address && typeof address === "object");
  try {
    await admin`CREATE DATABASE ${admin(stageName)} TEMPLATE ${admin(sourceUrl.pathname.slice(1))}`;
    await ledger`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('twitterapi_io',1,100,1000)
      ON CONFLICT(service) DO UPDATE SET per_minute=1,per_hour=100,per_day=1000`;
    await ledger`INSERT INTO monitor_webhook_subscriptions(id,name,url,platforms,enabled,enabled_at,secret)
      VALUES(${randomUUID()},'Synthetic Gemini','https://example.test/webhook',ARRAY['gemini'],true,now()-interval '1 day','synthetic')`;
    const env = { ...process.env, COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "true", WEBHOOK_PUSH_ENABLED: "false",
      SERVERCHAN_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false",
      ALLOW_PRIVATE_NETWORK_FETCH: "true", GEMINI_RESET_PROVIDER: "twitterapi_io", TWITTERAPI_IO_BASE_URL: "http://127.0.0.1:" + address.port,
      TWITTERAPI_IO_API_KEY: "synthetic", GEMINI_BACKFILL_LEDGER_DATABASE_URL: sourceUrl.toString(), DATABASE_URL: stageUrl.toString() };
    const stopped = await run(env, "collect");
    assert.equal(stopped.code, 75, stopped.out);
    assert.equal(paid, 1);
    const [attempt] = await ledger`SELECT count(*)::int AS count FROM receipt_attempts WHERE service='twitterapi_io'`;
    assert.equal(attempt.count, 1);
    assert.equal((await ledger`SELECT id FROM monitor_source_posts WHERE monitor_id='gemini'`).length, 0);
    await ledger`UPDATE budgets SET per_minute=100 WHERE service='twitterapi_io'`;
    const continued = await run(env, "collect");
    assert.equal(continued.code, 0, continued.out);
    assert.ok(JSON.parse(continued.out).ready);
    assert.equal(paid, Math.ceil((Date.parse(JSON.parse(continued.out).upper) - start) / (7 * 86_400_000)));
    const text = properName("Historical quota");
    await stage`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,processing_status,text,title)
      VALUES('gemini','300','_mohansolo','2026-09-01T01:00Z','https://x.com/_mohansolo/status/300','processed','Quota reset scheduled',${stage.json(text)})`;
    await stage`INSERT INTO monitor_event_records(monitor_id,id,type,title,scope,created_at,updated_at)
      VALUES('gemini','demo','direct_reset',${stage.json(text)},'{"type":"all_users","note":null}'::jsonb,now(),now())`;
    await stage`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,time,sources,created_at,updated_at)
      VALUES('gemini','announce-demo','demo',1,'announce',${stage.json(text)},'{"kind":"instant","at":"2026-09-02T01:00:00Z"}','[{"postId":"300"}]',now(),now())`;
    await stage`INSERT INTO monitor_state(monitor_id,key,value) VALUES('gemini','recognition:historical:300','{"suppressNotifications":true}')`;
    const exported = await run(env, "export", "--bundle", bundle);
    assert.equal(exported.code, 0, exported.out);
    const prod = { ...env, DATABASE_URL: sourceUrl.toString(), WEBHOOK_PUSH_ENABLED: "true" };
    for (const phase of ["preview", "gate"]) {
      const response = await run(prod, phase, "--bundle", bundle);
      assert.equal(response.code, 0, response.out);
    }
    execFileSync("pg_dump", ["--format=custom", "--file", backup, sourceUrl.toString()], { windowsHide: true });
    for (let i = 0; i < 2; i++) {
      const response = await run(prod, "apply", "--bundle", bundle, "--backup", backup);
      assert.equal(response.code, 0, response.out);
    }
    assert.equal((await ledger`SELECT id FROM monitor_event_actions WHERE monitor_id='gemini' AND action='confirm'`).length, 1);
    assert.equal((await ledger`SELECT id FROM monitor_webhook_notifications WHERE monitor_id='gemini'`).length, 0);
    const [coverage] = await ledger`SELECT value FROM monitor_state WHERE monitor_id='gemini' AND key='collection:coverage:v1:twitterapi_io'`;
    assert.equal(coverage.value.scopeEffectiveAt, JSON.parse(continued.out).upper);
  } finally {
    fake.closeAllConnections();
    await new Promise<void>(resolve => fake.close(() => resolve()));
    await stage.end({ timeout: 5 });
    await ledger.end({ timeout: 5 });
    try { await admin`DROP DATABASE IF EXISTS ${admin(stageName)} WITH (FORCE)`; }
    finally { await admin.end({ timeout: 5 }); await rm(directory, { recursive: true, force: true }); }
  }
});
