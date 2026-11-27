import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { audit, Conflict } from "@aihot/backend/audit";
import { closeDb, sql, type Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { RESET_MONITOR_BACKENDS } from "@aihot/site/reset-monitor-backends";
import { languages, reduceEvent, type EditorialScope } from "../actions.ts";
import { localizedTextSchema } from "../public-v2.ts";
import { loadActionInput, rowVersion } from "../backend/action-store.ts";
import { inMonitor, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { editorialStatus, saveEditorialState } from "../backend/event-editorial.ts";
import { defaultScopeLabel, fixedScopeNote, hasCustomScopeNote, scopeForWrite } from "../backend/scope-labels.ts";
import { loadWebhookBaselines, readyEvent, replaceWebhookFingerprint } from "../backend/webhook-events.ts";
import { verifyActionBackup } from "../backend/backup.ts";

const reviewFields = {
  monitorId: z.string(), id: z.string(), summary: localizedTextSchema.optional(),
  actions: z.array(z.strictObject({ id: z.string(), summary: localizedTextSchema })).optional(),
};
const reviewedScope = z.discriminatedUnion("audience", [
  z.strictObject({ ...reviewFields, audience: z.literal("single"), note: localizedTextSchema }),
  z.strictObject({ ...reviewFields, audience: z.enum(["multiple", "all", "paid", "unknown"]) }),
]);
const reviewSchema = z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), selected: z.array(reviewedScope) });
const fixedAudience = { all: "all_users", paid: "paid_users", unknown: "unknown" } as const;
const keyOf = (monitorId: string, id: string) => JSON.stringify([monitorId, id]);
const needsReview = (scope: EditorialScope | null) => scope?.type === "selected_users" || hasCustomScopeNote(scope?.note);
const fingerprintOf = (value: unknown) => sha256(stableJson(value));

function previousLabelFingerprint(event: NonNullable<ReturnType<typeof readyEvent>>) {
  const { type, note } = event.scope;
  const all = fixedScopeNote("all_users");
  // Before the label change, an unknown audience with an all-users label was projected as unspecified.
  if (type === "unknown" && note && languages.every(language => [all[language], all.zh, all.en].includes(note[language].trim()))) {
    return fingerprintOf({ ...event, scope: { type, note: defaultScopeLabel(type) } });
  }
  return null;
}

async function snapshot(db: Db, definitions: readonly ResetMonitorBackendDefinition[], now: number) {
  const monitors = [];
  for (const definition of definitions) monitors.push(await inMonitor(definition, async () => {
    const input = await loadActionInput(db);
    const baselines = definition.publicV2 ? await loadWebhookBaselines(db) : null;
    const rebase = new Map<string, string>();
    const unpublished = [];
    if (baselines) for (const row of input.events) {
      const changesScope = needsReview(row.scope) || stableJson(row.scope) !== stableJson(scopeForWrite(row.scope));
      if (!changesScope && row.scope?.type !== "unknown") continue;
      const baseline = baselines.get(row.id);
      if (baseline?.historicalPending && !baseline.fingerprint && !baseline.notified) continue;
      if (row.withdrawn || !reduceEvent(row, input)) {
        if (changesScope && baseline && !baseline.withdrawn && (baseline.fingerprint || baseline.notified)) unpublished.push(row.id);
        continue;
      }
      const event = readyEvent(row, input, now);
      const current = event ? fingerprintOf(event) : null;
      const previous = event ? previousLabelFingerprint(event) : null;
      if (!changesScope && !previous) continue;
      if (baseline?.fingerprint && !baseline.withdrawn && [current, previous].includes(baseline.fingerprint)) {
        rebase.set(row.id, baseline.fingerprint);
      } else unpublished.push(row.id);
    }
    return { definition, input, baselines, rebase, unpublished };
  }));
  const fingerprint = fingerprintOf(monitors.map(({ definition, input, baselines, unpublished }) => ({
    monitorId: definition.monitorId,
    events: input.events.map(rowVersion),
    actions: input.actions.map(rowVersion),
    posts: input.posts.map(rowVersion),
    editorials: input.editorials,
    baselines: baselines === null ? null : [...baselines],
    unpublished,
  })));
  return { monitors, fingerprint };
}

export async function inventoryScopeLabels(db: Db, definitions = RESET_MONITOR_BACKENDS, now = Date.now()) {
  const { monitors, fingerprint } = await snapshot(db, definitions, now);
  const selected = monitors.flatMap(({ definition, input }) => input.events.filter(event => needsReview(event.scope)).map(event => {
    const actions = input.actions.filter(action => action.event_id === event.id);
    return {
      monitorId: definition.monitorId, id: event.id, title: event.title, summary: event.summary, scope: event.scope,
      actions: actions.map(action => ({ id: action.id, action: action.action, summary: action.summary, sources: action.sources })),
      sources: [...new Set(actions.flatMap(action => action.sources.map(source => source.postId)))].map(postId => {
        const post = input.posts.find(row => row.id === postId);
        return post ? { postId, url: post.url, text: post.text } : { postId };
      }),
    };
  }));
  const unpublished = monitors.flatMap(({ definition, unpublished }) => unpublished.map(id => ({ monitorId: definition.monitorId, id })));
  return { fingerprint, selected, unpublished, events: monitors.reduce((total, { input }) => total + input.events.length, 0) };
}

export async function applyScopeLabels(db: Db, value: unknown, definitions = RESET_MONITOR_BACKENDS, now = Date.now()) {
  const review = reviewSchema.parse(value);
  await db`SET LOCAL lock_timeout='5s'`;
  await db`LOCK TABLE monitor_event_records,monitor_event_actions,monitor_source_posts,monitor_state,monitor_webhook_deliveries IN SHARE ROW EXCLUSIVE MODE`;
  const { fingerprint, monitors } = await snapshot(db, definitions, now);
  if (fingerprint !== review.fingerprint) throw new Conflict("范围数据已变化，请重新盘点");
  const [pending] = await db`SELECT 1 FROM monitor_webhook_deliveries WHERE status IN ('pending','sending') LIMIT 1`;
  if (pending) throw new Conflict("先处理待发或发送中的 Webhook");
  if (monitors.some(({ unpublished }) => unpublished.length)) throw new Conflict("先处理尚未发布的 Webhook 变更");
  const byId = new Map(review.selected.map(row => [keyOf(row.monitorId, row.id), row]));
  const expected = monitors.flatMap(({ definition, input }) =>
    input.events.filter(event => needsReview(event.scope)).map(event => keyOf(definition.monitorId, event.id)));
  if (byId.size !== review.selected.length || byId.size !== expected.length || !expected.every(key => byId.has(key)))
    throw new Error("每条历史特定用户或自定义范围说明需要一项范围核对");
  let changed = 0, rebased = 0;
  for (const { definition, input, rebase } of monitors) await inMonitor(definition, async () => {
    for (const row of input.events) {
      const reviewed = byId.get(keyOf(definition.monitorId, row.id));
      let scope = scopeForWrite(row.scope);
      if (reviewed) {
        if (reviewed.audience === "single" || reviewed.audience === "multiple") {
          scope = { type: "selected_users", note: reviewed.audience === "single" ? reviewed.note : fixedScopeNote("paid_users") };
        } else scope = scopeForWrite({ type: fixedAudience[reviewed.audience], note: null });
      }
      const summary = reviewed?.summary ?? row.summary;
      const summaryChanged = stableJson(summary) !== stableJson(row.summary);
      if (stableJson(scope) === stableJson(row.scope) && !summaryChanged && !reviewed?.actions?.length) continue;
      const actions = input.actions.filter(action => action.event_id === row.id);
      const corrections = new Map(reviewed?.actions?.map(action => [action.id, action.summary]));
      if (corrections.size !== (reviewed?.actions?.length ?? 0) || [...corrections.keys()].some(id => !actions.some(action => action.id === id))) {
        throw new Error(`范围核对的动作重复或不属于事件 ${row.id}`);
      }
      if (hasCustomScopeNote(row.scope?.note)) {
        const sourced = actions.filter(action => action.sources.length > 0);
        const eligible = sourced.length ? sourced : actions.filter(action => action.action === "confirm");
        const complete = actions.length ? eligible.some(action => localizedTextSchema.safeParse(corrections.get(action.id) ?? action.summary).success)
          : localizedTextSchema.safeParse(summary).success;
        if (!complete) throw new Error(`请在事件 ${row.id} 的对应摘要中保留已核对资格，填写七种语言`);
      }
      for (const action of actions) if (corrections.has(action.id) && stableJson(corrections.get(action.id)) === stableJson(action.summary)) corrections.delete(action.id);
      if (stableJson(scope) === stableJson(row.scope) && !summaryChanged && !corrections.size) continue;
      const status = summaryChanged ? "ready" : corrections.size ? null : editorialStatus(row, input);
      for (const action of actions) {
        const next = corrections.get(action.id);
        if (!next) continue;
        await db`UPDATE monitor_event_actions SET summary=${db.json(next)},updated_at=clock_timestamp()
          WHERE monitor_id=${definition.monitorId} AND id=${action.id}`;
        action.summary = next;
      }
      await db`UPDATE monitor_event_records SET scope=${db.json(scope)},summary=${summary ? db.json(summary) : null},updated_at=clock_timestamp()
        WHERE monitor_id=${definition.monitorId} AND id=${row.id}`;
      row.scope = scope;
      row.summary = summary;
      if (status) await saveEditorialState(db, row, input, status);
      changed++;
    }
    for (const row of input.events) {
      const before = rebase.get(row.id);
      if (before) {
        const event = readyEvent(row, input, now);
        if (!event) throw new Error(`回填后无法重算事件 ${row.id} 的 Webhook 基线`);
        const fingerprint = fingerprintOf(event);
        if (before !== fingerprint) {
          await replaceWebhookFingerprint(db, row.id, fingerprint);
          rebased++;
        }
      }
    }
  });
  if (changed || rebased) await audit("operator", "reset_monitor.scope_labels", "reset-monitors", "统一事件范围展示文案",
    { fingerprint }, { changed, rebased }, { db });
  return { changed, reviewed: expected.length };
}

async function main() {
  const { values } = parseArgs({ options: { inventory: { type: "string" }, apply: { type: "string" },
    "database-backup": { type: "string" }, "verification-database-env": { type: "string" }, "worker-stopped": { type: "boolean" } } });
  if (Boolean(values.apply) === Boolean(values.inventory)) throw new Error("Use --inventory NEW_FILE or --apply REVIEW --worker-stopped --database-backup DUMP");
  if (values.inventory) {
    const result = await sql.begin("isolation level repeatable read read only", db => inventoryScopeLabels(db));
    await writeFile(values.inventory, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ events: result.events, selected: result.selected.length, unpublished: result.unpublished.length }));
    return;
  }
  if (!values["worker-stopped"] || !values["database-backup"]) throw new Error("Apply requires stopped writers and a verified complete backup");
  const variable = values["verification-database-env"];
  if (variable && !process.env[variable]) throw new Error("Backup verification database environment variable is missing");
  const review: unknown = JSON.parse(await readFile(values.apply!, "utf8"));
  reviewSchema.parse(review);
  await verifyActionBackup(values["database-backup"], variable ? process.env[variable] : undefined);
  console.log(JSON.stringify(await sql.begin("read write", db => applyScopeLabels(db, review))));
}
if (import.meta.main) {
  try { await main(); }
  finally { await closeDb(); }
}
