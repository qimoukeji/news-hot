import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { reduceEvent, type ActionInput, type EventRow } from "../actions.ts";
import type { Db } from "@aihot/backend/db";
import { monitorId } from "./context.ts";

export const editorialKey = (id: string) => `public_v2:overview:${id}`;
export const editorialPromptVersion = "reset-monitor-overview-2026-10-31.1";

/** Generated fields and record timestamps must not invalidate their own input. */
export function editorialFacts(row: EventRow, input: ActionInput) {
  const reduced = reduceEvent(row, input);
  if (!reduced) return null;
  const actions = reduced.actions.map(({ action, publishedAt }) => ({
    id: action.id, action: action.action, invalidatesEvent: action.invalidates_event, sequence: action.sequence,
    time: action.time, title: action.title, summary: action.summary, publishedAt,
    sources: action.sources.map(source => source.postId).sort(),
  }));
  return { type: row.type, scope: row.scope, withdrawn: row.withdrawn, actions };
}
export const editorialVersion = (row: EventRow, input: ActionInput) => sha256(stableJson({ prompt: editorialPromptVersion, facts: editorialFacts(row, input) }));
export const editorialRecordVersion = (row: Pick<EventRow, "title" | "summary">) => sha256(stableJson({ title: row.title, summary: row.summary }));
export function editorialStatus(row: EventRow, input: ActionInput): "ready" | "edited" | null {
  const state = input.editorials?.[row.id];
  if (!state || state.status !== "ready" && state.status !== "edited") return null;
  return state.version === editorialVersion(row, input) && state.recordVersion === editorialRecordVersion(row) ? state.status : null;
}
export function editorialReady(row: EventRow, input: ActionInput) {
  return editorialStatus(row, input) === "ready";
}
export async function saveEditorialState(db: Db, row: EventRow, input: ActionInput, status: "ready" | "edited") {
  const value = { status, version: editorialVersion(row, input), recordVersion: editorialRecordVersion(row) };
  await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${editorialKey(row.id)},${db.json(value)})
    ON CONFLICT(monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`;
}

/** Only sourced facts and their official state may enter the overview model. */
export function officialEditorialInput(row: EventRow, input: ActionInput) {
  const officialInput = { ...input, actions: input.actions.filter(action => action.sources.length > 0) };
  const official = reduceEvent(row, officialInput);
  if (!official) return null;
  return { type: row.type, scope: row.scope, status: official.status, time: official.time,
    actions: official.actions.map(({ action, publishedAt }) => ({
      action: action.action, invalidatesEvent: action.invalidates_event, sequence: action.sequence,
      title: action.title, summary: action.summary, time: action.time, publishedAt,
    })),
  };
}
