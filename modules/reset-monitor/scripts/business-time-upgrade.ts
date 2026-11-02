import { createHash } from "node:crypto";
import type postgres from "postgres";
import { businessTimeSchema, calendarDate, normalizePublicTime, timestampSchema, type BusinessTime } from "../public-v2.ts";
import { reduceEvent, translated, type ActionInput, type ActionRow } from "../actions.ts";
import { editorialFacts, editorialKey, editorialPromptVersion, editorialRecordVersion, editorialVersion } from "../backend/event-editorial.ts";
import { scopeReadyForPublication } from "../backend/scope-labels.ts";

export const timeUpgradeKey = "business-time:upgrade:v1";
export const timeUpgradeThrough = "0146_monitor_actions_business_time.sql";

/** Historical scalar decoding belongs only to this offline upgrade, never to the application. */
export function convertLegacyTime(value: unknown): BusinessTime | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Historical time must be an ISO timestamp, calendar date or timestamp interval");
  if (calendarDate.safeParse(value).success) return { kind: "date", date: value, timeZone: "Asia/Shanghai" };
  if (timestampSchema.safeParse(value).success) return normalizePublicTime({ kind: "instant", at: value });
  const parts = value.split("/");
  if (parts.length === 2 && parts.every(part => timestampSchema.safeParse(part).success)) {
    return normalizePublicTime(businessTimeSchema.parse({ kind: "range", from: parts[0], through: parts[1] }));
  }
  throw new Error("Historical time is invalid; review the action before upgrading");
}

export function upgradeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
export const upgradeHash = (value: unknown) => createHash("sha256").update(upgradeJson(value)).digest("hex");
export type UpgradeTimeRow = { monitor_id: string; id: string; time: string | null; business_time: BusinessTime | null; updated_at: string };

export function verifyConvertedTime(row: Pick<UpgradeTimeRow, "id" | "time" | "business_time">) {
  const expected = convertLegacyTime(row.time);
  if (upgradeJson(expected) !== upgradeJson(row.business_time)) throw new Error(`Action ${row.id} has not been converted and verified`);
}
export const timeUpgradeDigest = (rows: UpgradeTimeRow[]) => upgradeHash(rows.map(row => [row.id, row.time, row.business_time, row.updated_at]));

export type LegacyInput = Omit<ActionInput, "actions"> & { actions: Array<Omit<ActionRow, "time"> & { time: string | null }> };
export type UpgradeState = { key: string; value: Record<string, unknown> };
export function convertLegacyInput(before: LegacyInput): ActionInput {
  const after: ActionInput = { ...structuredClone(before), actions: before.actions.map(action => ({ ...structuredClone(action), time: convertLegacyTime(action.time) })) };
  for (const action of after.actions) {
    if (!action.sources.length && (action.action !== "confirm" || action.time === null || action.invalidates_event)) throw new Error(`Action ${action.id} has invalid source-free time`);
  }
  return after;
}

/** Preserve bindings only if they matched the scalar facts; never revive an outdated overview.
 * Failed same-version translations/overviews must remain failed after a representation change. */
export function planUpgradeStates(before: LegacyInput, after: ActionInput, states: UpgradeState[], rawEvents: Array<{ id: string }> = []) {
  const oldActions = new Map(before.actions.map(action => [action.id, action]));
  const result = states.map(state => ({ key: state.key, value: structuredClone(state.value) }));
  for (const event of after.events) {
    const state = result.find(state => state.key === editorialKey(event.id));
    if (!state) continue;
    const facts = editorialFacts(event, after);
    const legacyFacts = facts ? { ...facts, actions: facts.actions.map(action => ({ ...action, time: oldActions.get(action.id)!.time })) } : null;
    if (state.value.version !== upgradeHash({ prompt: editorialPromptVersion, facts: legacyFacts })) continue;
    if (["ready", "edited"].includes(String(state.value.status)) && state.value.recordVersion !== editorialRecordVersion(event)) continue;
    state.value.version = editorialVersion(event, after);
  }
  for (const action of after.actions) {
    const state = result.find(state => state.key === `public_v2:translation:action:${action.id}`);
    if (state?.value.version === upgradeHash(oldActions.get(action.id))) state.value.version = upgradeHash(action);
  }
  for (const event of after.events) {
    const state = result.find(state => state.key === `webhook:event:${event.id}`);
    if (!state) continue;
    const reduced = reduceEvent(event, after);
    const ready = !event.withdrawn && reduced && scopeReadyForPublication(reduced.scope)
      && reduced.actions.every(({ action }) => !action.sources.length || translated(action.title) && (!action.summary || translated(action.summary)));
    const raw = ready ? rawEvents.find(row => row.id === event.id) : undefined;
    if (raw) state.value.fingerprint = upgradeHash(raw);
  }
  after.editorials = Object.fromEntries(result.filter(state => state.key.startsWith("public_v2:overview:")).map(state => [state.key.slice("public_v2:overview:".length), state.value])) as ActionInput["editorials"];
  return result.filter(state => upgradeJson(state.value) !== upgradeJson(states.find(old => old.key === state.key)!.value));
}

/** Before dropping the scalar column, require an exact conversion and committed metadata refresh.
 * The runner invokes this before its batch and again while holding the destructive DDL lock. */
export async function verifyBusinessTimeUpgrade(db: Pick<postgres.Sql, "unsafe">) {
  const columns = await db.unsafe<{ attname: string; type: string }[]>("SELECT attname,atttypid::regtype::text AS type FROM pg_attribute WHERE attrelid=to_regclass('monitor_event_actions') AND attnum>0 AND NOT attisdropped AND attname IN ('time','business_time')");
  if (!columns.some(column => column.attname === "time" && column.type === "text")) return;
  const [{ populated }] = await db.unsafe<{ populated: boolean }[]>("SELECT EXISTS(SELECT 1 FROM monitor_event_actions LIMIT 1) AS populated");
  if (!populated) return;
  const guidance = `Stop all writers and deliveries, run migrations --through ${timeUpgradeThrough}, then run the authorized business-time upgrade before cleanup`;
  if (!columns.some(column => column.attname === "business_time" && column.type === "jsonb")) throw new Error(guidance);
  const grouped = new Map<string, UpgradeTimeRow[]>();
  let cursor: [string, string] | null = null;
  for (;;) {
    const rows: UpgradeTimeRow[] = await db.unsafe<UpgradeTimeRow[]>(`SELECT monitor_id,id,time,business_time,extract(epoch from updated_at)::text AS updated_at FROM monitor_event_actions ${cursor ? "WHERE (monitor_id,id)>($1,$2)" : ""} ORDER BY monitor_id,id LIMIT 500`, cursor ?? []);
    if (!rows.length) break;
    for (const row of rows) {
      try { verifyConvertedTime(row); }
      catch (error) { throw new Error(`${(error as Error).message}. ${guidance}`, { cause: error }); }
      const group = grouped.get(row.monitor_id) ?? [];
      group.push(row); grouped.set(row.monitor_id, group);
    }
    cursor = [rows.at(-1)!.monitor_id, rows.at(-1)!.id];
  }
  for (const [monitor, rows] of grouped) {
    const [state] = await db.unsafe<{ value: { complete?: boolean; digest?: string } }[]>("SELECT value FROM monitor_state WHERE monitor_id=$1 AND key=$2", [monitor, timeUpgradeKey]);
    if (state?.value.complete !== true || state.value.digest !== timeUpgradeDigest(rows)) throw new Error(`Monitor ${monitor} has no matching completed upgrade. ${guidance}`);
  }
}

