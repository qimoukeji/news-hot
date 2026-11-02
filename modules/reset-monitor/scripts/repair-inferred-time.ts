import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { beijingDate } from "@aihot/contracts/time";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import type { Db } from "@aihot/backend/db";
import { type ActionInput, type ActionRow } from "../actions.ts";
import { announcementBasis, inferenceBoundary, inferredConfirmationTime } from "../backend/confirmation.ts";
import { editorialKey, editorialRecordVersion, editorialVersion } from "../backend/event-editorial.ts";
import type { ResetMonitorBackendDefinition } from "../backend/context.ts";
import { convertLegacyTime, type LegacyInput } from "./business-time-upgrade.ts";

export interface RepairState { key: string; value: Record<string, unknown> }
interface Delivery { id: string; eventId: string; status: string; updatedAt: string }
export interface DefaultsEvidence { actionId: string; eventId: string; sequence: number; originalTime: null; sources: string[]; publishedAt: string }
interface RepairSnapshot {
  input: ActionInput;
  states: RepairState[];
  versions: Array<{ kind: string; id: string; at: string }>;
  deliveries: Delivery[];
  defaultsEvidence: DefaultsEvidence[];
}
interface Change { actionId: string; eventId: string; idProof: "structured-plan" | "scalar-plan" | "scalar-defaults"; before: NonNullable<ActionRow["time"]>; after: { kind: "instant"; at: string } }
interface Problem { actionId: string; reason: string }
export interface InferredTimePlan {
  fingerprint: string;
  changes: Change[];
  problems: Problem[];
  cancelledDeliveryIds: string[];
  after: ActionInput;
}
export interface InferredTimePreview {
  format: 1;
  monitors: Array<{ monitorId: string; fingerprint: string; changes: Change[]; problems: Problem[]; cancelledDeliveryIds: string[]; defaultsEvidence: DefaultsEvidence[] }>;
}
const same = (left: unknown, right: unknown) => stableJson(left) === stableJson(right);

/** The ab9c102 scalar-to-JSONB upgrade preserved action IDs. Reproduce only its exact historical ID input. */
function scalarPlanId(eventId: string, basis: NonNullable<ReturnType<typeof announcementBasis>>, defaultsEvidence: DefaultsEvidence[] = []): string | null {
  const revisions: Array<{ id: string; action: string; time: string | null }> = [];
  for (const { action, publishedAt } of basis.official.actions) {
    if (action.action !== "announce" && !action.invalidates_event && !(action.action === "amend" && action.time !== null)) continue;
    const time = action.time;
    if (time?.kind === "deadline" || time?.kind === "date" && time.timeZone !== "Asia/Shanghai") return null;
    let scalar = time === null ? null : time.kind === "date" ? time.date : time.kind === "range" ? `${time.from}/${time.through}` : time.at;
    if (!same(convertLegacyTime(scalar), time)) return null;
    const evidence = defaultsEvidence.find(row => row.actionId === action.id);
    if (evidence) {
      if (action.action !== "announce" || time?.kind !== "date" || time.timeZone !== "Asia/Shanghai" || time.date !== beijingDate(publishedAt)
        || evidence.originalTime !== null || evidence.eventId !== eventId || evidence.sequence !== action.sequence || evidence.publishedAt !== publishedAt
        || !same(evidence.sources, action.sources.map(source => source.postId).sort())) return null;
      scalar = null;
    }
    revisions.push({ id: action.id, action: action.invalidates_event ? "cancel" : action.action, time: scalar });
  }
  return `inferred-${sha256(stableJson({ event: eventId, plan: sha256(stableJson(revisions)) }))}`;
}

function safeInput(input: ActionInput): ActionInput {
  return { ...structuredClone(input), posts: input.posts.map(post => ({ ...structuredClone(post), text: null, quoted_post: null })) };
}

/** Only the generated ID and its original official plan establish repair authority. */
export function planInferredTimeRepair(input: ActionInput, states: RepairState[] = [], versions: RepairSnapshot["versions"] = [], deliveries: Delivery[] = [], defaultsEvidence: DefaultsEvidence[] = []): InferredTimePlan {
  const before = safeInput(input), after = structuredClone(before), changes: Change[] = [], problems: Problem[] = [];
  for (const action of before.actions) {
    if (!action.id.startsWith("inferred-") || action.action !== "confirm" || action.sources.length) continue;
    const fail = (reason: string) => problems.push({ actionId: action.id, reason });
    const event = before.events.find(row => row.id === action.event_id);
    if (!event || action.invalidates_event) { fail("Generated confirmation has no valid event"); continue; }
    const prefix = { ...before, actions: before.actions.filter(row => row.event_id !== event.id || row.sequence < action.sequence) };
    try {
      const basis = announcementBasis({ ...event, withdrawn: false }, prefix);
      if (!basis || basis.official.status !== "announced" || !basis.plan) { fail("Original announcement plan is no longer provable"); continue; }
      const expectedId = `inferred-${sha256(stableJson({ event: event.id, plan: basis.version }))}`;
      const idProof = action.id === expectedId ? "structured-plan" : action.id === scalarPlanId(event.id, basis) ? "scalar-plan"
        : defaultsEvidence.length && action.id === scalarPlanId(event.id, basis, defaultsEvidence) ? "scalar-defaults" : null;
      if (!idProof) { fail("Generated confirmation ID does not match its original plan"); continue; }
      if (!Number.isFinite(new Date(action.created_at).getTime()) || new Date(action.created_at).getTime() < inferenceBoundary(basis.plan)) {
        fail("Confirmation predates its announcement boundary"); continue;
      }
      const time = inferredConfirmationTime(basis.plan);
      if (same(action.time, time)) continue;
      if (!same(action.time, basis.plan)) { fail("Confirmation time differs from both its original plan and inferred instant"); continue; }
      changes.push({ actionId: action.id, eventId: event.id, idProof, before: action.time!, after: time });
      after.actions.find(row => row.id === action.id)!.time = time;
    } catch { fail("Original announcement time or evidence is invalid"); }
  }
  const affected = new Set(changes.map(change => change.eventId));
  return { fingerprint: sha256(stableJson({ input: before, states, versions, deliveries, defaultsEvidence })), changes, problems,
    cancelledDeliveryIds: deliveries.filter(row => affected.has(row.eventId) && ["pending", "sending", "failed"].includes(row.status)).map(row => row.id).sort(), after };
}

/** Rebind only matching metadata, including failures; stale results remain stale. */
export function planInferredTimeStates(before: ActionInput, after: ActionInput, states: RepairState[]): RepairState[] {
  const updates: RepairState[] = [];
  for (const original of states) {
    const state = structuredClone(original);
    for (const event of before.events) {
      const next = after.events.find(row => row.id === event.id)!;
      if (state.key === editorialKey(event.id) && state.value.version === editorialVersion(event, before)) {
        if (["ready", "edited"].includes(String(state.value.status)) && state.value.recordVersion !== editorialRecordVersion(event)) continue;
        state.value.version = editorialVersion(next, after);
      }
      if (state.key === `public_v2:translation:event:${event.id}` && state.value.version === sha256(stableJson(event))) state.value.version = sha256(stableJson(next));
    }
    for (const action of before.actions) {
      if (state.key === `public_v2:translation:action:${action.id}` && state.value.version === sha256(stableJson(action)))
        state.value.version = sha256(stableJson(after.actions.find(row => row.id === action.id)!));
    }
    if (!same(state, original)) updates.push(state);
  }
  return updates;
}

async function snapshot(db: Db, defaultsEvidence: DefaultsEvidence[] = []): Promise<RepairSnapshot> {
  const { loadActionInput } = await import("../backend/action-store.ts");
  const { monitorId } = await import("../backend/context.ts");
  const id = monitorId();
  return {
    defaultsEvidence,
    input: safeInput(await loadActionInput(db)),
    states: await db<RepairState[]>`SELECT key,value FROM monitor_state WHERE monitor_id=${id}
      AND (key LIKE 'public_v2:overview:%' OR key LIKE 'public_v2:translation:action:%' OR key LIKE 'public_v2:translation:event:%' OR key LIKE 'webhook:event:%') ORDER BY key`,
    versions: await db<RepairSnapshot["versions"]>`SELECT 'event' AS kind,id,updated_at::text AS at FROM monitor_event_records WHERE monitor_id=${id}
      UNION ALL SELECT 'action',id,updated_at::text FROM monitor_event_actions WHERE monitor_id=${id}
      UNION ALL SELECT 'post',id,updated_at::text FROM monitor_source_posts WHERE monitor_id=${id}
      UNION ALL SELECT 'state',key,updated_at::text FROM monitor_state WHERE monitor_id=${id}
        AND (key LIKE 'public_v2:overview:%' OR key LIKE 'public_v2:translation:action:%' OR key LIKE 'public_v2:translation:event:%' OR key LIKE 'webhook:event:%') ORDER BY kind,id`,
    deliveries: await db<Delivery[]>`SELECT d.id,n.event_id AS "eventId",d.status,d.updated_at::text AS "updatedAt"
      FROM monitor_webhook_deliveries d JOIN monitor_webhook_notifications n ON n.id=d.notification_id
      WHERE n.monitor_id=${id} AND d.status IN ('pending','sending','failed') ORDER BY d.id`,
  };
}
function planned(value: RepairSnapshot) { return planInferredTimeRepair(value.input, value.states, value.versions, value.deliveries, value.defaultsEvidence); }
function previewRow(monitorId: string, plan: InferredTimePlan, defaultsEvidence: DefaultsEvidence[] = []): InferredTimePreview["monitors"][number] {
  return { monitorId, fingerprint: plan.fingerprint, changes: plan.changes, problems: plan.problems, cancelledDeliveryIds: plan.cancelledDeliveryIds, defaultsEvidence };
}
async function definitions() { return (await import("@aihot/site/reset-monitor-backends")).RESET_MONITOR_BACKENDS; }

export async function previewInferredTimeRepair(output: string, priorDefaults?: string): Promise<InferredTimePreview> {
  const { sql } = await import("@aihot/backend/db");
  const { inMonitor } = await import("../backend/context.ts");
  const { projectPublicV2 } = await import("../backend/public-v2.ts");
  const result: InferredTimePreview = { format: 1, monitors: [] };
  await mkdir(path.resolve(output), { recursive: false });
  await sql.begin("isolation level repeatable read read only", async db => {
    for (const definition of await definitions()) await inMonitor(definition, async () => {
      const defaultsEvidence: DefaultsEvidence[] = [];
      if (priorDefaults) {
        const prior = JSON.parse(await readFile(path.join(priorDefaults, `${definition.monitorId}-before.json`), "utf8")) as LegacyInput;
        for (const action of prior.actions.filter(row => row.action === "announce" && row.time === null)) {
          const posts = action.sources.map(source => prior.posts.find(post => post.id === source.postId)).filter(post => post && !post.context_only)
            .sort((a, b) => new Date(a!.published_at).getTime() - new Date(b!.published_at).getTime() || a!.id.localeCompare(b!.id));
          if (!posts.length) continue;
          defaultsEvidence.push({ actionId: action.id, eventId: action.event_id, sequence: action.sequence, originalTime: null,
            sources: action.sources.map(source => source.postId).sort(), publishedAt: new Date(posts[0]!.published_at).toISOString() });
        }
      }
      const before = await snapshot(db, defaultsEvidence), plan = planned(before);
      projectPublicV2(plan.after, definition);
      await writeFile(path.join(output, `${definition.monitorId}-before.json`), JSON.stringify(before, null, 2), { flag: "wx" });
      const saved = JSON.parse(await readFile(path.join(output, `${definition.monitorId}-before.json`), "utf8")) as RepairSnapshot;
      assert.deepEqual(previewRow(definition.monitorId, planned(saved), defaultsEvidence), previewRow(definition.monitorId, plan, defaultsEvidence), "Repair snapshot failed read-back verification");
      await writeFile(path.join(output, `${definition.monitorId}-after.json`), JSON.stringify({ input: plan.after, stateUpdates: planInferredTimeStates(before.input, plan.after, before.states) }, null, 2), { flag: "wx" });
      result.monitors.push(previewRow(definition.monitorId, plan, defaultsEvidence));
    });
  });
  await writeFile(path.join(output, "preview.json"), JSON.stringify(result, null, 2), { flag: "wx" });
  return result;
}

export async function applyInferredTimeRepair(reviewed: InferredTimePreview, options: { output: string; databaseBackup: string; workerStopped: boolean; verificationDatabaseUrl?: string }) {
  if (!options.workerStopped) throw new Error("Stop API writers, workers and webhook deliveries before applying inferred-time repair");
  assert.equal(reviewed.format, 1, "Unsupported inferred-time preview");
  const configured = [...await definitions()].sort((a, b) => a.monitorId.localeCompare(b.monitorId));
  assert.deepEqual(reviewed.monitors.map(row => row.monitorId).sort(), configured.map(row => row.monitorId), "Reviewed preview must cover every configured monitor");
  if (reviewed.monitors.some(row => row.problems.length)) throw new Error("Resolve every inferred-time repair ambiguity before applying");
  const { verifyActionBackup } = await import("../backend/backup.ts");
  await verifyActionBackup(options.databaseBackup, options.verificationDatabaseUrl);
  const { sql } = await import("@aihot/backend/db");
  const { audit } = await import("@aihot/backend/audit");
  const { inMonitor, auditAction, auditSubject } = await import("../backend/context.ts");
  const { lockActionRecords } = await import("../backend/action-store.ts");
  const { lockWebhookMonitor, refreshWebhookBaseline } = await import("../backend/webhook-events.ts");
  const { projectPublicV2 } = await import("../backend/public-v2.ts");
  await mkdir(path.resolve(options.output), { recursive: false });
  const results = await sql.begin("read write", async db => {
    await db`SET LOCAL lock_timeout='5s'`;
    const prepared: Array<{ definition: ResetMonitorBackendDefinition; before: RepairSnapshot; plan: InferredTimePlan }> = [];
    for (const definition of configured) await inMonitor(definition, async () => {
      const [lock] = await db`SELECT pg_try_advisory_xact_lock(hashtext(${definition.names.tick})) AS acquired`;
      if (!lock?.acquired) throw new Error("Stop every monitor worker before applying inferred-time repair");
      const expected = reviewed.monitors.find(row => row.monitorId === definition.monitorId)!;
      const initial = await snapshot(db, expected.defaultsEvidence), initialPlan = planned(initial);
      const eventIds = [...new Set(initialPlan.changes.map(change => change.eventId))];
      const related = initial.input.actions.filter(row => eventIds.includes(row.event_id));
      await lockActionRecords(db, eventIds, related.map(row => row.id), related.flatMap(row => row.sources.map(source => source.postId)));
      await lockWebhookMonitor(db);
      for (const id of initialPlan.cancelledDeliveryIds) await db`SELECT id FROM monitor_webhook_deliveries WHERE id=${id} FOR UPDATE`;
      for (const state of initial.states) await db`SELECT key FROM monitor_state WHERE monitor_id=${definition.monitorId} AND key=${state.key} FOR UPDATE`;
      const before = await snapshot(db, expected.defaultsEvidence), plan = planned(before);
      assert.deepEqual(previewRow(definition.monitorId, plan, expected.defaultsEvidence), expected, "Repair evidence changed; review a fresh preview");
      if (plan.problems.length) throw new Error("Resolve every inferred-time repair ambiguity before applying");
      prepared.push({ definition, before, plan });
    });
    const results: Array<{ monitorId: string; repaired: number; cancelledDeliveries: number; applied: true }> = [];
    for (const { definition, before, plan } of prepared) await inMonitor(definition, async () => {
      await writeFile(path.join(options.output, `${definition.monitorId}-before.json`), JSON.stringify(before, null, 2), { flag: "wx" });
      const affected = [...new Set(plan.changes.map(change => change.eventId))];
      for (const change of plan.changes) {
        const rows = await db`UPDATE monitor_event_actions SET time=${db.json(change.after)},updated_at=clock_timestamp()
          WHERE monitor_id=${definition.monitorId} AND id=${change.actionId} AND action='confirm' AND sources='[]'::jsonb AND time=${db.json(change.before)} RETURNING id`;
        assert.equal(rows.length, 1, "Inferred confirmation changed while applying repair");
      }
      for (const id of affected) await db`UPDATE monitor_event_records SET updated_at=clock_timestamp() WHERE monitor_id=${definition.monitorId} AND id=${id}`;
      const saved = await snapshot(db, before.defaultsEvidence);
      for (const state of planInferredTimeStates(before.input, saved.input, before.states)) {
        await db`UPDATE monitor_state SET value=${db.json(state.value as never)},updated_at=clock_timestamp() WHERE monitor_id=${definition.monitorId} AND key=${state.key}`;
      }
      for (const id of plan.cancelledDeliveryIds) await db`UPDATE monitor_webhook_deliveries SET status='cancelled',last_error=NULL,updated_at=clock_timestamp()
        WHERE id=${id} AND status IN ('pending','sending','failed')`;
      for (const id of affected) await refreshWebhookBaseline(db, id);
      const after = await snapshot(db, before.defaultsEvidence);
      assert.equal(planned(after).changes.length, 0, "Repair did not reach a stable result");
      assert.equal(planned(after).problems.length, 0, "Repair introduced ambiguous inferred confirmations");
      projectPublicV2(after.input, definition);
      if (affected.length) await audit("operator", auditAction("repair_inferred_time"), auditSubject("event", "inferred-time"),
        "Normalize generated inferred confirmations to their announcement boundary without replaying historical notifications",
        { actions: before.input.actions.filter(row => plan.changes.some(change => change.actionId === row.id)) },
        { actions: after.input.actions.filter(row => plan.changes.some(change => change.actionId === row.id)), cancelledDeliveryIds: plan.cancelledDeliveryIds, backupVerified: true }, { db });
      await writeFile(path.join(options.output, `${definition.monitorId}-after.json`), JSON.stringify(after, null, 2), { flag: "wx" });
      results.push({ monitorId: definition.monitorId, repaired: plan.changes.length, cancelledDeliveries: plan.cancelledDeliveryIds.length, applied: true });
    });
    return results;
  });
  await writeFile(path.join(options.output, "result.json"), JSON.stringify(results, null, 2), { flag: "wx" });
  return results;
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: "string" }, apply: { type: "boolean" }, preview: { type: "string" }, "prior-defaults": { type: "string" },
    "worker-stopped": { type: "boolean" }, "database-backup": { type: "string" }, "verification-database-env": { type: "string" } } });
  if (!values.output) throw new Error("Usage: repair-inferred-time.ts --output NEW_DIRECTORY [--prior-defaults ORIGINAL_DEFAULTS_DIRECTORY] [--apply --preview REVIEWED/preview.json --worker-stopped --database-backup COMPLETE_DUMP] [--verification-database-env ENV_NAME]");
  const { closeDb } = await import("@aihot/backend/db");
  try {
    if (!values.apply) {
      const preview = await previewInferredTimeRepair(values.output, values["prior-defaults"]);
      console.log(JSON.stringify({ apply: false, monitors: preview.monitors.map(row => ({ monitorId: row.monitorId, changes: row.changes.length, problems: row.problems.length, cancelledDeliveries: row.cancelledDeliveryIds.length })) }));
    } else {
      if (!values.preview || !values["database-backup"] || !values["worker-stopped"]) throw new Error("Apply requires a reviewed preview, stopped writers/deliveries and a complete database backup");
      if (values["prior-defaults"]) throw new Error("Prior defaults evidence must be included in the reviewed preview, not changed during apply");
      const variable = values["verification-database-env"];
      if (variable && (!/^[A-Z][A-Z0-9_]*$/.test(variable) || !process.env[variable])) throw new Error("verification-database-env must name a configured process environment variable");
      const reviewed = JSON.parse(await readFile(values.preview, "utf8")) as InferredTimePreview;
      console.log(JSON.stringify(await applyInferredTimeRepair(reviewed, { output: values.output, databaseBackup: values["database-backup"],
        workerStopped: true, verificationDatabaseUrl: variable ? process.env[variable] : undefined })));
    }
  } finally { await closeDb(); }
}
if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database]") : "Inferred-time repair failed");
  process.exitCode = 1;
});
