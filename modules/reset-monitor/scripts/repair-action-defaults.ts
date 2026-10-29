import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { defaultActionTime, sourcedActions, withoutPostOriginal, type ActionInput } from "../actions.ts";
import { defaultScopeLabel } from "../backend/scope-labels.ts";

/** Repair only missing times and obsolete generated labels; preserve accepted facts and codes. */
export function planActionDefaults(input: ActionInput, prior?: ActionInput) {
  const after = structuredClone(input);
  const actions: string[] = [], events: string[] = [];
  const priorDefaults = new Map(prior?.events.flatMap(event => sourcedActions(event, prior))
    .filter(({ action }) => action.action === "announce" && action.time === null).map(({ action, publishedAt }) => [action.id, publishedAt]));
  for (const event of after.events) {
    for (const { action, publishedAt } of sourcedActions(event, after)) {
      const oldDefault = priorDefaults.get(action.id);
      if (action.time === null || action.action === "announce" && oldDefault !== undefined && action.time === oldDefault) {
        action.time = defaultActionTime(action.action, oldDefault ?? publishedAt);
        actions.push(action.id);
      }
    }
    if (event.scope?.note && Object.values(event.scope.note).some(note => /\bunknown\b/i.test(note ?? ""))) {
      // These are the old generated labels, not arbitrary eligibility descriptions.
      const en = event.scope.note.en;
      if (!["unknown All users", "unknown All users · unknown All products", "All users · unknown All products", "Paid users · unknown All products", "unknown All products"].includes(en ?? ""))
        throw new Error(`Review custom scope note before repairing event ${event.id}`);
      event.scope.note = defaultScopeLabel(event.scope.type);
      events.push(event.id);
    }
  }
  if (after.actions.some(action => action.time === null)) throw new Error("Missing time has no valid source; review before repair");
  return { after, actions, events };
}

async function main() {
  const args = process.argv.slice(2), apply = args.includes("--apply"), index = args.indexOf("--output");
  const output = index >= 0 ? args[index + 1] : undefined;
  const priorIndex = args.indexOf("--prior-backup"), priorDirectory = priorIndex >= 0 ? args[priorIndex + 1] : undefined;
  if (!output || output.startsWith("--") || priorIndex >= 0 && (!priorDirectory || priorDirectory.startsWith("--")))
    throw new Error("Usage: repair-action-defaults.ts --output NEW_DIRECTORY [--prior-backup PREVIOUS_DIRECTORY] [--apply]");
  const { sql, closeDb } = await import("@aihot/backend/db");
  const { audit } = await import("@aihot/backend/audit");
  const { RESET_MONITOR_BACKENDS } = await import("@aihot/site/reset-monitor-backends");
  const { inMonitor, auditAction, auditSubject } = await import("../backend/context.ts");
  const { loadActionInput, lockActionRecords } = await import("../backend/action-store.ts");
  const { projectPublicV2 } = await import("../backend/public-v2.ts");
  const { enqueuePublicV2 } = await import("../backend/public-v2-work.ts");
  try {
    await mkdir(path.resolve(output), { recursive: false });
    const summary: Array<{ monitor: string; actions: number; events: number; applied: boolean }> = [];
    for (const definition of RESET_MONITOR_BACKENDS) await inMonitor(definition, async () => {
      const prior = priorDirectory ? JSON.parse(await readFile(path.join(priorDirectory, `${definition.monitorId}-before.json`), "utf8")) as ActionInput : undefined;
      const result = await sql.begin(apply ? "read write" : "read only", async db => {
        const initial = await loadActionInput(db), preview = planActionDefaults(initial, prior);
        const affected = [...new Set([...preview.events, ...initial.actions.filter(action => preview.actions.includes(action.id)).map(action => action.event_id)])];
        if (apply) await lockActionRecords(db, affected, preview.actions, initial.actions.filter(action => preview.actions.includes(action.id)).flatMap(action => action.sources.map(source => source.postId)));
        const before = await loadActionInput(db), planned = planActionDefaults(before, prior);
        assert.deepEqual(planned.actions, preview.actions, "Action set changed; rerun preview");
        assert.deepEqual(planned.events, preview.events, "Event set changed; rerun preview");
        const backup = path.join(output, `${definition.monitorId}-before.json`);
        await writeFile(backup, JSON.stringify({ ...before, posts: before.posts.map(withoutPostOriginal) }, null, 2), { flag: "wx" });
        const copy = JSON.parse(await readFile(backup, "utf8")) as ActionInput;
        const verified = planActionDefaults(copy, prior);
        assert.deepEqual(verified.actions, planned.actions);
        assert.deepEqual(verified.events, planned.events);
        projectPublicV2(verified.after, definition);
        await writeFile(path.join(output, `${definition.monitorId}-after.json`), JSON.stringify(verified.after, null, 2), { flag: "wx" });
        if (apply && affected.length) {
          await db`SELECT set_config('aihot.suppress_monitor_notifications','true',true)`;
          for (const id of planned.actions) {
            const row = planned.after.actions.find(action => action.id === id)!;
            await db`UPDATE monitor_event_actions SET time=${row.time},updated_at=clock_timestamp() WHERE monitor_id=${definition.monitorId} AND id=${id}`;
          }
          for (const id of affected) {
            const row = planned.after.events.find(event => event.id === id)!;
            await db`UPDATE monitor_event_records SET scope=${row.scope ? db.json(row.scope) : null},updated_at=clock_timestamp() WHERE monitor_id=${definition.monitorId} AND id=${id}`;
          }
          await audit("operator", auditAction("repair_defaults"), auditSubject("event", "defaults"), "Normalize audience labels and default unresolved times by action: Beijing date for announcements, publication instant for other actions",
            { events: before.events.filter(event => planned.events.includes(event.id)), actions: before.actions.filter(action => planned.actions.includes(action.id)) },
            { events: planned.after.events.filter(event => planned.events.includes(event.id)), actions: planned.after.actions.filter(action => planned.actions.includes(action.id)) }, { db });
          await enqueuePublicV2(db, affected);
          const saved = await loadActionInput(db);
          assert.equal(saved.actions.filter(action => action.time === null).length, 0);
          assert.equal(planActionDefaults(saved, prior).events.length, 0);
          assert.equal(planActionDefaults(saved, prior).actions.length, 0);
        }
        return { monitor: definition.monitorId, actions: planned.actions.length, events: planned.events.length, applied: apply };
      });
      summary.push(result);
      console.log(JSON.stringify(result));
    });
    await writeFile(path.join(output, "result.json"), JSON.stringify(summary, null, 2), { flag: "wx" });
  } finally { await closeDb(); }
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database]") : "Action defaults repair failed");
  process.exitCode = 1;
});
