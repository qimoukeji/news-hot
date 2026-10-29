import { RESET_MONITOR_BACKENDS } from "@aihot/site/reset-monitor-backends";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { quotedPostSchema, replyToSchema } from "../actions.ts";
import { actionRecognitionSchema } from "./recognize.ts";
import { applyOfflineRecognition } from "./assemble.ts";
import { storeCollectedPost, sourcePost, markPostReview, loadActionInput } from "./action-store.ts";
import { verifyActionBackup } from "./backup.ts";
import { inMonitor, type ResetMonitorBackendDefinition } from "./context.ts";
import { initializeWebhookBaselines } from "./webhook-events.ts";
import { sourceContentIssue } from "./source-completeness.ts";

export const offlineDefinitions: readonly ResetMonitorBackendDefinition[] = RESET_MONITOR_BACKENDS;
export const offlineClearTables = ["monitor_webhook_deliveries", "monitor_webhook_notifications", "monitor_event_actions", "monitor_event_records", "monitor_source_posts", "monitor_state"] as const;
export const offlinePreservedTables = ["monitor_webhook_subscriptions", "receipts", "audit_log"] as const;
const identitySchema = z.strictObject({ monitorId: z.enum(["codex", "claude", "grok"]), id: z.string().regex(/^\d+$/), url: z.url(), evidencePath: z.string().min(1) });
const observedSchema = identitySchema.extend({ status: z.literal("observed"), author: z.string().regex(/^[A-Za-z0-9_]{1,15}$/), publishedAt: z.iso.datetime(), text: z.string().refine(value => !!value.trim(), "Original text is required"), quotedPost: quotedPostSchema.nullable().optional(), replyTo: replyToSchema.nullable().optional(), recognition: actionRecognitionSchema.optional(), reason: z.string().min(1).optional() });
const unavailableSchema = identitySchema.extend({ status: z.literal("unavailable"), reason: z.string().min(1) });
export const offlineBundleSchema = z.strictObject({ version: z.literal(1), capturedAt: z.iso.datetime(), sources: z.array(z.discriminatedUnion("status", [observedSchema, unavailableSchema])).min(1) }).superRefine((bundle, ctx) => {
  const ids = new Set<string>();
  for (const [index, source] of bundle.sources.entries()) {
    const key = `${source.monitorId}:${source.id}`;
    if (ids.has(key)) ctx.addIssue({ code: "custom", path: ["sources", index], message: "Duplicate monitor/post ID" });
    ids.add(key);
    const url = new URL(source.url), match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
    if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname) || url.username || url.password || !match || match[2] !== source.id || source.status === "observed" && match[1]!.toLowerCase() !== source.author.toLowerCase()) {
      ctx.addIssue({ code: "custom", path: ["sources", index, "url"], message: "Source URL must identify the observed X author and post" });
    }
  }
});
export type OfflineBundle = z.infer<typeof offlineBundleSchema>;
export type OfflinePhase = "clear" | "import" | "finish";

interface TableDigest { table: string; count: number; digest: string }
export async function offlineSnapshot(db: Db = sql) {
  const [identity] = await db`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port`;
  const tables: TableDigest[] = [];
  for (const table of [...offlineClearTables, ...offlinePreservedTables]) {
    const [row] = await db<{ count: number; digest: string }[]>`SELECT count(*)::integer AS count,md5(coalesce(string_agg(row_to_json(t)::text,E'\n' ORDER BY row_to_json(t)::text),'')) AS digest FROM ${db(table)} t`;
    tables.push({ table, count: row!.count, digest: row!.digest });
  }
  return { target: sha256(stableJson(identity)), identity, tables };
}
export async function offlinePlan(phase: OfflinePhase, requested?: unknown, db: Db = sql) {
  const bundle = requested === undefined ? null : offlineBundleSchema.parse(requested);
  if (phase === "import" && !bundle) throw new Error("Import requires a browser evidence bundle");
  const snapshot = await offlineSnapshot(db);
  return { phase, target: snapshot.target, identity: snapshot.identity, fingerprint: sha256(stableJson({ phase, snapshot, bundle })), tables: snapshot.tables,
    sources: bundle ? { total: bundle.sources.length, observed: bundle.sources.filter(source => source.status === "observed").length, unavailable: bundle.sources.filter(source => source.status === "unavailable").length } : null };
}
interface ApplyOptions { target: string; fingerprint: string; workerStopped: boolean }
function assertOffline(options: ApplyOptions) {
  if (!options.workerStopped) throw new Error("Stop the API and workers before offline changes");
  for (const key of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "WEBHOOK_PUSH_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
    if (process.env[key] === "true") throw new Error(`${key} must stay disabled for offline changes`);
  }
}
async function checkPlan(phase: OfflinePhase, options: ApplyOptions, bundle?: unknown, db: Db = sql) {
  assertOffline(options);
  const plan = await offlinePlan(phase, bundle, db);
  if (plan.target !== options.target) throw new Error("Offline target database identity does not match the reviewed target");
  if (plan.fingerprint !== options.fingerprint) throw new Error("Offline input changed after preview; review a new fingerprint");
  return plan;
}
export async function clearOfflineMonitor(options: ApplyOptions & { backup: string }) {
  assertOffline(options);
  await verifyActionBackup(options.backup);
  return sql.begin(async tx => {
    await tx`SET TRANSACTION READ WRITE`;
    await tx`SET LOCAL lock_timeout='5s'`;
    await tx`LOCK TABLE monitor_webhook_deliveries,monitor_webhook_notifications,monitor_event_actions,monitor_event_records,monitor_source_posts,monitor_state,monitor_webhook_subscriptions,receipts,audit_log IN ACCESS EXCLUSIVE MODE`;
    const plan = await checkPlan("clear", options, undefined, tx);
    for (const table of offlineClearTables) await tx`DELETE FROM ${tx(table)}`;
    return { cleared: plan.tables.filter(table => (offlineClearTables as readonly string[]).includes(table.table)), target: plan.target };
  });
}

async function resolveReferences(body: z.infer<typeof actionRecognitionSchema>) {
  const recognition = structuredClone(body), saved = await loadActionInput();
  for (const action of recognition.actions) {
    if (action.eventId?.startsWith("source:")) {
      const postId = action.eventId.slice(7), ids = new Set(saved.actions.filter(row => row.sources.some(source => source.postId === postId)).map(row => row.event_id));
      if (ids.size !== 1) return { reason: `来源 ${postId} 未关联唯一事件`, recognition };
      action.eventId = [...ids][0]!;
    }
    if (action.existingActionId?.startsWith("source:")) {
      const postId = action.existingActionId.slice(7), matches = saved.actions.filter(row => row.event_id === action.eventId && row.action === action.action && row.invalidates_event === action.invalidatesEvent && row.sources.some(source => source.postId === postId));
      if (matches.length !== 1) return { reason: `来源 ${postId} 未关联唯一匹配动作`, recognition };
      action.existingActionId = matches[0]!.id;
    }
  }
  return { recognition, reason: null };
}

export async function importOfflineBundle(requested: unknown, options: ApplyOptions) {
  const bundle = offlineBundleSchema.parse(requested);
  await checkPlan("import", options, bundle);
  // Historical source authors are authorized for this bundle only; scheduled collection keeps its site definition.
  const definitions = offlineDefinitions.map(definition => {
    const authors = [...definition.authors];
    for (const source of bundle.sources) if (source.status === "observed" && source.monitorId === definition.monitorId
      && !authors.some(author => author.handle.toLowerCase() === source.author.toLowerCase())) {
      authors.push({ handle: source.author, name: `@${source.author}` });
    }
    return { ...definition, authors };
  });
  const sources = [...bundle.sources].sort((a, b) => a.monitorId.localeCompare(b.monitorId)
    || (a.status === "observed" ? Date.parse(a.publishedAt) : Infinity) - (b.status === "observed" ? Date.parse(b.publishedAt) : Infinity)
    || a.id.localeCompare(b.id));
  const evidence = new Map<string, string>();
  for (const source of sources) {
    const filename = resolve(source.evidencePath);
    if (!(await stat(filename)).isFile()) throw new Error(`Evidence is not a regular file: ${source.monitorId}:${source.id}`);
    evidence.set(`${source.monitorId}:${source.id}`, sha256(await readFile(filename, "utf8")));
  }
  // Save all original posts before recognition so saved parents can supply context without another request.
  for (const source of sources) if (source.status === "observed") {
    const definition = definitions.find(item => item.monitorId === source.monitorId)!;
    await inMonitor(definition, async () => {
      const existing = await sourcePost(source.id);
      if (existing && (existing.author.toLowerCase() !== source.author.toLowerCase() || new Date(existing.published_at).toISOString() !== new Date(source.publishedAt).toISOString() || existing.url !== source.url || existing.text !== source.text || stableJson(existing.quoted_post) !== stableJson(source.quotedPost ?? null) || stableJson(existing.reply_to) !== stableJson(source.replyTo ?? null))) throw new Error(`Saved original differs from browser bundle: ${source.monitorId}:${source.id}`);
      await storeCollectedPost({ id: source.id, author: source.author, publishedAt: source.publishedAt, url: source.url, text: source.text, quotedPost: source.quotedPost, replyTo: source.replyTo, receiptId: null });
    });
  }
  const results: Array<{ monitorId: string; id: string; status: string; reason: string | null; evidenceSha256: string; eventIds: string[] }> = [];
  for (const source of sources) {
    const evidenceSha256 = evidence.get(`${source.monitorId}:${source.id}`)!;
    if (source.status === "unavailable") { results.push({ monitorId: source.monitorId, id: source.id, status: "unavailable", reason: source.reason, evidenceSha256, eventIds: [] }); continue; }
    await inMonitor(definitions.find(item => item.monitorId === source.monitorId)!, async () => {
      let post = (await sourcePost(source.id))!;
      if (post.processing_status === "pending") {
        const issue = source.reason ?? sourceContentIssue(post.text!);
        if (issue) await markPostReview(post.id, issue, post.version, undefined, sql, source.recognition);
        else if (source.recognition) {
          const resolved = await resolveReferences(source.recognition);
          if (resolved.reason) await markPostReview(post.id, resolved.reason, post.version, undefined, sql, resolved.recognition);
          else await applyOfflineRecognition(post.id, resolved.recognition, post.version);
        }
      }
      post = (await sourcePost(source.id))!;
      const saved = await loadActionInput(), eventIds = [...new Set(saved.actions.filter(action => action.sources.some(item => item.postId === source.id)).map(action => action.event_id))];
      results.push({ monitorId: source.monitorId, id: source.id, status: post.processing_status, reason: post.review_reason, evidenceSha256, eventIds });
    });
  }
  return { target: options.target, capturedAt: bundle.capturedAt, results };
}

export async function finishOfflineImport(options: ApplyOptions) {
  await checkPlan("finish", options);
  const [incomplete] = await sql<{ count: number }[]>`SELECT count(*)::integer AS count FROM monitor_source_posts WHERE processing_status IN ('pending','failed')`;
  if (incomplete!.count) throw new Error(`Offline import still has ${incomplete!.count} pending or failed posts`);
  await sql.begin(async tx => {
    await tx`SET TRANSACTION READ WRITE`;
    // These tables were explicitly cleared for rebuilding; remove only historical work generated by this import.
    await tx`DELETE FROM monitor_webhook_deliveries`;
    await tx`DELETE FROM monitor_webhook_notifications`;
    await tx`DELETE FROM monitor_state WHERE key LIKE 'webhook:%' OR key LIKE 'public_v2:pending:%'`;
    for (const definition of offlineDefinitions) await tx`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${definition.monitorId},'actions:notification_baseline',${tx.json({ convertedBefore: new Date().toISOString() })}) ON CONFLICT(monitor_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
  });
  await initializeWebhookBaselines(offlineDefinitions);
  return { finished: true, snapshot: await offlineSnapshot() };
}
