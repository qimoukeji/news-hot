import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import timers from "node:timers/promises";
import { pacedTwitterApiRequest } from "../backend/providers/twitterapi-pacing.ts";

test("TwitterAPI.io serializes requests with a fixed interval and releases failures without retrying", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const waits: number[] = [];
  t.mock.method(timers, "setTimeout", async (ms: number) => { waits.push(ms); t.mock.timers.tick(ms); });
  const started: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = pacedTwitterApiRequest(async () => { started.push(Date.now()); await held; throw new Error("provider refusal"); }).catch((error) => error);
  await Promise.resolve();
  const second = pacedTwitterApiRequest(async () => { started.push(Date.now()); return "Claude response"; });
  await Promise.resolve();
  assert.deepEqual(started, [100000]);
  release();
  assert.match((await first).message, /provider refusal/);
  assert.equal(await second, "Claude response");
  assert.deepEqual(started, [100000, 105500]);
  assert.deepEqual(waits, [5500]);
  assert.equal(await pacedTwitterApiRequest(async () => { started.push(Date.now()); return "third response"; }), "third response");
  assert.deepEqual(started, [100000, 105500, 111000]);
  assert.deepEqual(waits, [5500, 5500]);
});
