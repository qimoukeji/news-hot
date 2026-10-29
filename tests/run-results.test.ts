import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { runsOverview } from "@aihot/backend/admin/runs";

after(async () => { installModules([]); await stopBoss(); await closeDb(); });

test("latest runs and timeline share safe business statistics without publishing arbitrary task details", async () => {
  await getBoss();
  installModules([{ name: "run-result-test", admin: { currentJobs: async () => ["monitor.tick", "grok-reset.tick", "generic.task"] } }]);
  const reviewed = { processed: 5, reviewed: 3, failed: 0, schemaFailures: 1, rawResponse: { text: "private-job-payload" }, sourceText: "private-job-payload" };
  const partial = { outcome: "partial", complete: false, collectionComplete: false, pages: 5, windowPages: 10, reason: "page_limit", stored: 20 };
  await sql`INSERT INTO job_runs(job,status,finished_at,detail) VALUES
    ('monitor.tick','ok',now(),${sql.json(reviewed)}),
    ('grok-reset.tick','ok',now(),${sql.json(partial)}),
    ('generic.task','ok',now(),' {"text":"private-job-payload"}'::jsonb)`;
  const overview = await runsOverview();
  for (const rows of [overview.jobs, overview.timeline]) {
    assert.deepEqual(rows.find(row => row.job === "monitor.tick")!.detail, { processed: 5, reviewed: 3, failed: 0, schemaFailures: 1 });
    assert.deepEqual(rows.find(row => row.job === "grok-reset.tick")!.detail, partial);
    assert.equal(rows.find(row => row.job === "generic.task")!.detail, null);
  }
  assert.doesNotMatch(JSON.stringify({ jobs: overview.jobs, timeline: overview.timeline }), /private-job-payload/);
});
