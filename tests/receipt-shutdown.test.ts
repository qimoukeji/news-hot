// Failure modes: stopping between paid pages/batches must not send the next request, consume a
// budget attempt, or create an unknown receipt; an in-flight answer must still save, and received
// or completed answers must remain reusable so business writes can finish during shutdown.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { shutdownSignal } from "@aihot/backend/jobs/queue";
import { assertRequestCanSend, completeReceipt, paidRequest, ProviderNotSentError, ProviderRejectedError } from "@aihot/backend/providers/receipts";

after(closeDb);

test("shutdown drains and reuses paid results while refusing new pages and retries before budget reservation", async () => {
  const service = `shutdown-${tag()}`;
  const request = (page: number) => ({ service, purpose: "source_fetch", identity: { page } });
  let calls = 0;
  await assert.rejects(paidRequest(request(0), async () => {
    calls += 1;
    throw new ProviderRejectedError("temporarily refused", 503, true);
  }), ProviderRejectedError);
  const asked = gate();
  const answer = gate();
  const running = paidRequest(request(1), async () => {
    calls += 1;
    asked.open();
    await answer.promise;
    return { response: { page: 1, next: 2 } };
  });
  await asked.promise;
  const queued = gate();
  const releaseQueued = gate();
  const waiting = paidRequest(request(3), async () => {
    queued.open();
    await releaseQueued.promise;
    await assertRequestCanSend(service);
    calls += 1;
    return { response: { page: 3 } };
  });
  const unsent = assert.rejects(waiting, ProviderNotSentError);
  await queued.promise;
  shutdownSignal.abort();
  releaseQueued.open();
  answer.open();
  const first = await running;
  await unsent;
  const next = async () => { calls += 1; return { response: { page: 2 } }; };
  assert.equal((await paidRequest(request(1), next)).reused, true, "received answer remains reusable");
  await completeReceipt(sql, first.receiptId);
  assert.equal((await paidRequest(request(1), next)).reused, true, "committed answer remains reusable");
  await assert.rejects(paidRequest(request(2), next), { name: "AbortError" });
  await assert.rejects(paidRequest(request(0), next), { name: "AbortError" });
  assert.equal(calls, 2);
  const receipts = await sql`SELECT status FROM receipts WHERE service=${service} ORDER BY id`;
  assert.deepEqual(receipts.map((row) => row.status), ["failed", "completed", "failed"]);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE service=${service}`).length, 3);
  assert.equal((await sql`SELECT status FROM receipt_attempts WHERE receipt_id IN (SELECT id FROM receipts WHERE service=${service}) ORDER BY id`)[2]!.status, "failed", "the queued reservation was never sent or billed as unknown");
});
