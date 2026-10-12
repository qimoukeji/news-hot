import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import timers from "node:timers/promises";
import { setImmediate } from "node:timers/promises";
import { ProviderNotSentError } from "@aihot/backend/providers/receipts";
import { pacedTwitterApiRequest } from "../backend/providers/twitterapi-pacing.ts";

test("TwitterAPI.io serializes requests with a fixed interval and releases failures without retrying", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const waits: number[] = [];
  t.mock.method(timers, "setTimeout", async (ms: number) => { waits.push(ms); t.mock.timers.tick(ms); });
  const started: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = pacedTwitterApiRequest(async () => { started.push(Date.now()); await held; throw new Error("provider refusal"); }).catch((error) => error);
  await setImmediate();
  const second = pacedTwitterApiRequest(async () => { started.push(Date.now()); return "Claude response"; });
  await setImmediate();
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

test("cancelling a queued request releases only its slot and cannot overtake an in-flight request", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 200000 });
  t.mock.method(timers, "setTimeout", async (ms: number) => { t.mock.timers.tick(ms); });
  const started: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = pacedTwitterApiRequest(async () => { started.push("first"); await held; return "saved first"; });
  await setImmediate();
  const controller = new AbortController();
  const cancelled = pacedTwitterApiRequest(async () => { started.push("cancelled"); }, controller.signal).catch(error => error);
  const following = pacedTwitterApiRequest(async () => { started.push("following"); return "saved following"; });
  controller.abort();
  assert.ok(await cancelled instanceof ProviderNotSentError);
  await setImmediate();
  assert.deepEqual(started, ["first"]);
  release();
  assert.equal(await first, "saved first");
  assert.equal(await following, "saved following");
  assert.deepEqual(started, ["first", "following"]);
});

test("cancelling the interval wait sends nothing and does not consume a new pacing interval", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 300000 });
  await pacedTwitterApiRequest(async () => "first");
  const waits: number[] = [];
  let waiting!: () => void;
  const entered = new Promise<void>(resolve => { waiting = resolve; });
  t.mock.method(timers, "setTimeout", async (ms: number, _value: unknown, options: { signal: AbortSignal }) => {
    waits.push(ms);
    if (waits.length === 1) {
      waiting();
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("timer cancelled")), { once: true }));
    }
    t.mock.timers.tick(ms);
  });
  const controller = new AbortController();
  let sent = 0;
  const cancelled = pacedTwitterApiRequest(async () => { sent++; }, controller.signal).catch(error => error);
  await entered;
  controller.abort();
  assert.ok(await cancelled instanceof ProviderNotSentError);
  assert.equal(sent, 0);
  await pacedTwitterApiRequest(async () => { sent++; });
  assert.equal(sent, 1);
  assert.deepEqual(waits, [5500, 5500]);
});

test("a stopped signal rejects before queueing while an already sent response is retained", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 400000 });
  t.mock.method(timers, "setTimeout", async (ms: number) => { t.mock.timers.tick(ms); });
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let sent = 0;
  const inFlight = pacedTwitterApiRequest(async () => { sent++; await held; return "received answer"; }, controller.signal);
  await setImmediate();
  controller.abort();
  await assert.rejects(pacedTwitterApiRequest(async () => { sent++; }, controller.signal), ProviderNotSentError);
  release();
  assert.equal(await inFlight, "received answer");
  assert.equal(sent, 1);
  assert.equal(await pacedTwitterApiRequest(async () => "next"), "next");
});
