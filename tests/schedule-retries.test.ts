import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { registerSchedules } from "../apps/worker/src/schedules.ts";

after(async () => { await stopBoss(); await closeDb(); });

test("a schedule without retries repairs its existing queue and jobs, and a failed run executes once", async () => {
  const boss = await getBoss();
  const queue = "cron.fixture.no-retry";
  await boss.createQueue(queue, { policy: "singleton", retryLimit: 1, retryDelay: 3600 });
  const retryId = (await boss.send(queue, {}, { singletonKey: "retry" }))!;
  assert.equal((await boss.fetch(queue))[0]?.id, retryId);
  await boss.fail(queue, retryId, { error: "previous failed request" });
  assert.equal((await boss.getJobById(queue, retryId))?.state, "retry");
  const activeId = (await boss.send(queue, {}, { singletonKey: "active" }))!;
  assert.equal((await boss.fetch(queue))[0]?.id, activeId);
  const futureId = (await boss.send(queue, {}, { singletonKey: "future", startAfter: "2099-01-01" }))!;
  let calls = 0;
  installModules([{ name: "fixture", schedules: [
    { name: "fixture.no-retry", cron: "0 0 1 1 *", retryLimit: 0, run: async () => {
      calls += 1;
      throw new Error("paid request result unknown");
    } },
    { name: "fixture.default-retry", cron: "0 0 1 1 *", run: async () => ({}) },
  ] }]);
  await registerSchedules(boss);
  assert.equal((await boss.getQueue(queue))?.retryLimit, 0);
  assert.equal((await boss.getQueue("cron.fixture.default-retry"))?.retryLimit, 1);
  const previous = await boss.getJobById(queue, retryId);
  assert.equal(previous?.state, "failed", "an already-failed round cannot run again");
  assert.ok(previous?.completedOn);
  for (const id of [retryId, activeId, futureId]) assert.equal((await boss.getJobById(queue, id))?.retryLimit, 0);
  await boss.fail(queue, activeId, { error: "in-flight request failed" });
  assert.equal((await boss.getJobById(queue, activeId))?.state, "failed");
  const newId = (await boss.send(queue, {}, { singletonKey: "new" }))!;
  const deadline = Date.now() + 30_000;
  while ((await boss.getJobById(queue, newId))?.state !== "failed" && Date.now() < deadline) await setTimeout(100);
  const failed = await boss.getJobById(queue, newId);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.retryCount, 0);
  // An unchanged retry policy would start the same job again at the worker's next pickup.
  await setTimeout(16_000);
  assert.equal(calls, 1);
  const runs = await sql`SELECT status FROM job_runs WHERE job = 'fixture.no-retry'`;
  assert.deepEqual(runs.map(row => row.status), ["failed"]);
  assert.equal((await boss.getJobById(queue, futureId))?.state, "created");
});
