import { createHash } from "node:crypto";
import type postgres from "postgres";
import { Temporal } from "@js-temporal/polyfill";
import { calendarDate, timestampSchema, type BusinessTime } from "../public-v2.ts";
import { reduceEvent, translated, type ActionInput, type ActionRow } from "../actions.ts";
import { editorialFacts, editorialKey, editorialPromptVersion, editorialRecordVersion } from "../backend/event-editorial.ts";
import { projectPublicV2, projectRawV2 } from "../backend/public-v2.ts";
import { scopeReadyForPublication } from "../backend/scope-labels.ts";
import type { Db } from "@aihot/backend/db";
import type { ResetMonitorBackendDefinition } from "../backend/context.ts";
import { historicalDefault, legacyProjectedEvent, loadLegacyTimeInput, type LegacyTimeInput } from "./time-cutover.ts";

// The 0146–0153 ledger has its own contract, independent of the scope/time cutover.
export type ScalarUpgradeTime = BusinessTime | { kind: "date"; date: string; timeZone: string } | null;

export const timeUpgradeKey = "business-time:upgrade:v1";
export const timeUpgradeThrough = "0146_monitor_actions_business_time.sql";

function scalarUpgradeInstant(value: string) {
  if (/\.\d{10}/.test(value)) throw new Error("Historical timestamp exceeds nine fractional-second digits");
  const instant = Temporal.Instant.from(value);
  return value.endsWith("Z") ? value : instant.toString();
}

/** Historical scalar decoding belongs only to this offline upgrade, never to the application. */
export function convertLegacyTime(value: unknown): ScalarUpgradeTime {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Historical time must be an ISO timestamp, calendar date or timestamp interval");
  if (calendarDate.safeParse(value).success) return { kind: "date", date: value, timeZone: "Asia/Shanghai" };
  if (timestampSchema.safeParse(value).success) return { kind: "instant", at: scalarUpgradeInstant(value) };
  const parts = value.split("/");
  if (parts.length === 2 && parts.every(part => timestampSchema.safeParse(part).success)) {
    const from = scalarUpgradeInstant(parts[0]), through = scalarUpgradeInstant(parts[1]);
    if (Temporal.Instant.compare(through, from) < 0) throw new Error("Historical time interval ends before it starts");
    return { kind: "range", from, through };
  }
  throw new Error("Historical time is invalid; review the action before upgrading");
}

export function upgradeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Set ? [...item].sort() : item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
export const upgradeHash = (value: unknown) => createHash("sha256").update(upgradeJson(value)).digest("hex");
export type UpgradeTimeRow = { monitor_id: string; id: string; time: string | null; business_time: ScalarUpgradeTime; updated_at: string };

export function verifyConvertedTime(row: Pick<UpgradeTimeRow, "id" | "time" | "business_time">) {
  const expected = convertLegacyTime(row.time);
  if (upgradeJson(expected) !== upgradeJson(row.business_time)) throw new Error(`Action ${row.id} has not been converted and verified`);
}
export const timeUpgradeDigest = (rows: UpgradeTimeRow[]) => upgradeHash(rows.map(row => [row.id, row.time, row.business_time, row.updated_at]));

export type LegacyInput = Omit<ActionInput, "actions"> & { actions: Array<Omit<ActionRow, "time"> & { time: string | null }> };
export type StructuredUpgradeInput = Omit<LegacyTimeInput, "actions"> & { actions: Array<Omit<ActionRow, "time"> & { time: ScalarUpgradeTime }> };
export type UpgradeState = { key: string; value: Record<string, unknown> };
type UpgradeSetKey = { [K in keyof ActionInput]-?: NonNullable<ActionInput[K]> extends ReadonlySet<string> ? K : never }[keyof ActionInput];
export type UpgradeSetSnapshot = { [K in UpgradeSetKey]: string[] };
export function serializeUpgradeSets(input: Pick<ActionInput, UpgradeSetKey>): UpgradeSetSnapshot {
  return {
    standaloneFollowupIds: [...input.standaloneFollowupIds ?? []].sort(),
    invalidatedInferenceIds: [...input.invalidatedInferenceIds ?? []].sort(),
    manualConfirmationIds: [...input.manualConfirmationIds ?? []].sort(),
  };
}
export function restoreUpgradeSets(snapshot: UpgradeSetSnapshot): Required<Pick<ActionInput, UpgradeSetKey>> {
  return {
    standaloneFollowupIds: new Set(snapshot.standaloneFollowupIds),
    invalidatedInferenceIds: new Set(snapshot.invalidatedInferenceIds),
    manualConfirmationIds: new Set(snapshot.manualConfirmationIds),
  };
}
export function convertLegacyInput(before: LegacyInput): StructuredUpgradeInput {
  const after: StructuredUpgradeInput = { ...structuredClone(before), actions: before.actions.map(action => ({ ...structuredClone(action), time: convertLegacyTime(action.time) })) };
  for (const action of after.actions) {
    if (!action.sources.length && (action.action !== "confirm" || action.time === null || action.invalidates_event)) throw new Error(`Action ${action.id} has invalid source-free time`);
  }
  return after;
}

/** Read the legacy column through its actual type instead of casting the current action store. */
export async function loadScalarUpgradeInput(db: Db, monitorId: string): Promise<LegacyInput> {
  const input = await loadLegacyTimeInput(db, monitorId);
  return { ...input, actions: input.actions.map(row => {
    if (row.time !== null && typeof row.time !== "string") throw new Error(`Action ${row.id} has no scalar time`);
    return { ...row, time: row.time };
  }) };
}

/** Temporary current-shaped projection values are replaced by the exact historical times before hashing. */
function projectionInput(input: StructuredUpgradeInput): ActionInput {
  return { ...input, actions: input.actions.map(action => {
    const time = action.time;
    if (time && time.kind !== "date") return { ...action, time };
    const post = input.posts.find(post => action.sources.some(source => source.postId === post.id));
    const at = new Date(post?.published_at ?? action.created_at).toISOString();
    return { ...action, time: time ? { kind: "instant", at: `${time.date}T10:00:00Z` } : historicalDefault(action.action, at) };
  }) };
}

export function upgradeEditorialFacts(row: ActionInput["events"][number], input: StructuredUpgradeInput) {
  const facts = editorialFacts(row, projectionInput(input));
  return facts && { ...facts, actions: facts.actions.map(action => ({ ...action, time: input.actions.find(old => old.id === action.id)!.time })) };
}
export const upgradeEditorialVersion = (row: ActionInput["events"][number], input: StructuredUpgradeInput) =>
  upgradeHash({ prompt: editorialPromptVersion, facts: upgradeEditorialFacts(row, input) });

export function projectUpgradeEvents(input: StructuredUpgradeInput, definition: ResetMonitorBackendDefinition) {
  const projected = projectionInput(input);
  projectPublicV2(projected, definition);
  return projectRawV2(projected, definition).events.flatMap(event => {
    const row = input.events.find(row => row.id === event.id)!;
    const old = legacyProjectedEvent(row, input, event, projected, definition.product);
    return old ? [old] : [];
  });
}

/** Preserve bindings only if they matched the scalar facts; never revive an outdated overview.
 * Failed same-version translations/overviews must remain failed after a representation change. */
export function planUpgradeStates(before: LegacyInput, after: StructuredUpgradeInput, states: UpgradeState[], rawEvents: Array<{ id: string }> = []) {
  const oldActions = new Map(before.actions.map(action => [action.id, action]));
  const result = states.map(state => ({ key: state.key, value: structuredClone(state.value) }));
  for (const event of after.events) {
    const state = result.find(state => state.key === editorialKey(event.id));
    if (!state) continue;
    const facts = upgradeEditorialFacts(event, after);
    const legacyFacts = facts ? { ...facts, actions: facts.actions.map(action => ({ ...action, time: oldActions.get(action.id)!.time })) } : null;
    if (state.value.version !== upgradeHash({ prompt: editorialPromptVersion, facts: legacyFacts })) continue;
    if (["ready", "edited"].includes(String(state.value.status)) && state.value.recordVersion !== editorialRecordVersion(event)) continue;
    state.value.version = upgradeEditorialVersion(event, after);
  }
  for (const action of after.actions) {
    const state = result.find(state => state.key === `public_v2:translation:action:${action.id}`);
    if (state?.value.version === upgradeHash(oldActions.get(action.id))) state.value.version = upgradeHash(action);
  }
  const projection = projectionInput(after);
  for (const event of after.events) {
    const state = result.find(state => state.key === `webhook:event:${event.id}`);
    if (!state) continue;
    const reduced = reduceEvent(event, projection);
    const ready = !event.withdrawn && reduced && scopeReadyForPublication(reduced.scope)
      && reduced.actions.every(({ action }) => !action.sources.length || translated(action.title) && (!action.summary || translated(action.summary)));
    const raw = ready ? rawEvents.find(row => row.id === event.id) : undefined;
    if (raw) state.value.fingerprint = upgradeHash(raw);
  }
  after.editorials = Object.fromEntries(result.flatMap(({ key, value }) => key.startsWith("public_v2:overview:")
    && typeof value.version === "string" && typeof value.status === "string"
    ? [[key.slice("public_v2:overview:".length), { version: value.version, status: value.status,
      ...(typeof value.recordVersion === "string" ? { recordVersion: value.recordVersion } : {}) }]] : []));
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
