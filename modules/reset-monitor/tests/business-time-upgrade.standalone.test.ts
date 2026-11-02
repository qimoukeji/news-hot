import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type postgres from "postgres";
import { fixture } from "./action-fixture.ts";
import { editorialFacts, editorialPromptVersion, editorialRecordVersion, editorialVersion } from "../backend/event-editorial.ts";
import { convertLegacyInput, convertLegacyTime, planUpgradeStates, timeUpgradeDigest, upgradeHash, verifyBusinessTimeUpgrade, verifyConvertedTime, type LegacyInput, type UpgradeState, type UpgradeTimeRow } from "../scripts/business-time-upgrade.ts";

test("offline scalar conversion preserves precision and existing date semantics without inventing deadline metadata", () => {
  assert.deepEqual(convertLegacyTime(null), null);
  assert.deepEqual(convertLegacyTime("2026-11-02"), { kind: "date", date: "2026-11-02", timeZone: "Asia/Shanghai" });
  assert.deepEqual(convertLegacyTime("2026-11-02T13:42:26.123456789+08:00"), { kind: "instant", at: "2026-11-02T05:42:26.123456789Z" });
  assert.deepEqual(convertLegacyTime("2026-11-02T13:00:00+08:00/2026-11-02T14:00:00+08:00"), { kind: "range", from: "2026-11-02T05:00:00Z", through: "2026-11-02T06:00:00Z" });
  for (const value of ["11月02日 18:00:00", "2026-02-30", "2026-11-02T12:00:00", "2026-11-02T13:00:00Z/2026-11-02T12:00:00Z", { kind: "instant", at: "2026-11-02T00:00:00Z" }]) assert.throws(() => convertLegacyTime(value));
});

test("partial conversion can be verified repeatedly but a mismatch stops cleanup", () => {
  const row = { id: "action", time: "2026-11-02", business_time: convertLegacyTime("2026-11-02") };
  assert.doesNotThrow(() => verifyConvertedTime(row));
  assert.doesNotThrow(() => verifyConvertedTime(structuredClone(row)));
  assert.throws(() => verifyConvertedTime({ ...row, business_time: null }), /not been converted/);
  assert.throws(() => verifyConvertedTime({ ...row, business_time: { kind: "date", date: "2026-11-02", timeZone: "UTC" } }), /not been converted/);
});

test("source-free confirmations require a valid saved time before any upgrade writes", () => {
  const before = fixture() as unknown as LegacyInput;
  before.actions[0]!.sources = [];
  assert.throws(() => convertLegacyInput(before), /source-free/);
  before.actions[0]!.time = "2026-11-02T05:00:00Z";
  assert.equal(convertLegacyInput(before).actions[0]!.time?.kind, "instant");
  before.actions[0]!.action = "announce";
  assert.throws(() => convertLegacyInput(before), /source-free/);
});

test("only valid overview bindings and same-version translation failures advance to object facts", () => {
  const before = fixture() as unknown as LegacyInput;
  before.actions[0]!.time = "2026-11-02";
  const after = convertLegacyInput(before), event = after.events[0]!;
  const facts = editorialFacts(event, after)!;
  const legacyVersion = upgradeHash({ prompt: editorialPromptVersion, facts: { ...facts, actions: facts.actions.map(action => ({ ...action, time: before.actions.find(old => old.id === action.id)!.time })) } });
  for (const status of ["ready", "edited", "failed", "needs_review"]) {
    const states: UpgradeState[] = [
      { key: `public_v2:overview:${event.id}`, value: { status, version: legacyVersion, recordVersion: editorialRecordVersion(event), receiptId: 12 } },
      { key: `public_v2:translation:action:${before.actions[0]!.id}`, value: { status: "failed", version: upgradeHash(before.actions[0]), receiptId: 13 } },
      { key: `webhook:event:${event.id}`, value: { revision: 7, fingerprint: "old-scalar-fingerprint", notified: true, withdrawn: false } },
    ];
    const raw = { id: event.id, time: after.actions[0]!.time };
    const updates = planUpgradeStates(before, after, states, [raw]);
    assert.deepEqual(updates[0]!.value, { ...states[0]!.value, version: editorialVersion(event, after) });
    assert.deepEqual(updates[1]!.value, { ...states[1]!.value, version: upgradeHash(after.actions[0]) });
    assert.deepEqual(updates[2]!.value, { ...states[2]!.value, fingerprint: upgradeHash(raw) });
    assert.equal(states[0]!.value.version, legacyVersion, "planner never changes the backup");
  }
  const expired: UpgradeState[] = [
    { key: `public_v2:overview:${event.id}`, value: { status: "ready", version: "stale", recordVersion: editorialRecordVersion(event) } },
    { key: `public_v2:translation:action:${before.actions[0]!.id}`, value: { status: "failed", version: "stale" } },
  ];
  assert.deepEqual(planUpgradeStates(before, after, expired), []);
});

function guardDb(rows: UpgradeTimeRow[], options: { shadow?: boolean; complete?: boolean; digest?: string; scalar?: boolean } = {}) {
  const calls: string[] = [];
  const db = { unsafe: async (query: string) => {
    calls.push(query);
    if (query.includes("pg_attribute")) return [{ attname: "time", type: options.scalar === false ? "jsonb" : "text" }, ...(options.shadow === false ? [] : [{ attname: "business_time", type: "jsonb" }])];
    if (query.includes("EXISTS")) return [{ populated: rows.length > 0 }];
    if (query.includes("FROM monitor_event_actions")) return query.includes("WHERE (monitor_id,id)") ? [] : rows;
    if (query.includes("FROM monitor_state")) return [{ value: { complete: options.complete ?? true, digest: options.digest ?? timeUpgradeDigest(rows) } }];
    throw new Error("Unexpected query");
  } } as unknown as Pick<postgres.Sql, "unsafe">;
  return { db, calls };
}
test("destructive migration requires exact converted rows and committed metadata, while empty installs pass", async () => {
  const rows: UpgradeTimeRow[] = [{ monitor_id: "codex", id: "one", time: "2026-11-02", business_time: convertLegacyTime("2026-11-02"), updated_at: "1793577600.000000" }];
  await verifyBusinessTimeUpgrade(guardDb(rows).db);
  await verifyBusinessTimeUpgrade(guardDb([], { shadow: false }).db);
  await assert.rejects(verifyBusinessTimeUpgrade(guardDb(rows, { shadow: false }).db), /--through 0146/);
  await assert.rejects(verifyBusinessTimeUpgrade(guardDb(rows, { complete: false }).db), /completed upgrade/);
  await assert.rejects(verifyBusinessTimeUpgrade(guardDb(rows, { digest: "old" }).db), /completed upgrade/);
  await assert.rejects(verifyBusinessTimeUpgrade(guardDb([{ ...rows[0]!, business_time: null }]).db), /converted and verified/);
  const { db, calls } = guardDb(rows, { scalar: false });
  await verifyBusinessTimeUpgrade(db);
  assert.equal(calls.length, 1, "completed JSONB schemas never enter scalar conversion");
  assert.ok(calls.every(query => /^SELECT\b/.test(query)), "guard only reads");
});
