import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { sql, closeDb } from "@aihot/backend/db";
import { offlineBundleSchema, offlinePlan, offlineSnapshot, clearOfflineMonitor, importOfflineBundle, finishOfflineImport, type OfflineBundle } from "../backend/offline-import.ts";
import { properName } from "../backend/public-v2.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor, isAuthor } from "../backend/context.ts";
import { RESET_MONITORS } from "@aihot/site/reset-monitors";

const originalPath = process.env.PATH;
for (const directory of [".data/local-preview/reset-monitor-postgres/clients", ".data/local-preview/reset-monitor-postgres/package/native/bin"]) {
  const absolute = path.resolve(directory);
  if (existsSync(path.join(absolute, process.platform === "win32" ? "pg_restore.exe" : "pg_restore"))) process.env.PATH = `${absolute}${path.delimiter}${process.env.PATH ?? ""}`;
}
Object.assign(process.env, { COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", WEBHOOK_PUSH_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" });
after(async () => { process.env.PATH = originalPath; await closeDb(); });
const at = "2026-10-10T12:00:00.000Z", text = "We reset usage.", account = "thsottiaux";
type Recognition = NonNullable<Extract<OfflineBundle["sources"][number], { status: "observed" }>["recognition"]>;
function recognized(): Recognition {
  return { relevant: true, needsReview: false, title: properName("Usage reset"), summary: properName("Usage restored"), actions: [{ eventId: null, localEventKey: "new-1", existingActionId: null, kind: "direct_reset" as const, kindExplicit: true, action: "confirm" as const, invalidatesEvent: false, real: true, role: "action" as const, excerpt: text, title: properName("Usage reset"), summary: properName("Usage restored"), timeExcerpt: null,
    rawScope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null }, scope: { type: "all_users" as const, productCodes: [], planCodes: [], quotaWindowCodes: [], note: properName("All users") }, scopeExcerpt: null }] };
}

test("offline bundles reject duplicate identifiers, mismatched X authors and missing original fields", () => {
  const source = { monitorId: "codex", status: "observed", id: "101", url: "https://x.com/thsottiaux/status/101", author: account, publishedAt: at, text: "  Original text  ", evidencePath: "observed.json" };
  const bundle = { version: 1, capturedAt: at, sources: [source] };
  assert.equal(offlineBundleSchema.parse(bundle).sources[0]!.status, "observed");
  assert.equal((offlineBundleSchema.parse(bundle).sources[0] as { text: string }).text, source.text, "normalization must not trim original evidence");
  assert.throws(() => offlineBundleSchema.parse({ ...bundle, sources: [source, source] }), /Duplicate/);
  assert.throws(() => offlineBundleSchema.parse({ ...bundle, sources: [{ ...source, author: "other" }] }), /Source URL/);
  assert.throws(() => offlineBundleSchema.parse({ ...bundle, sources: [{ ...source, publishedAt: undefined }] }));
  assert.throws(() => offlineBundleSchema.parse({ ...bundle, sources: [{ ...source, id: "102" }] }), /Source URL/);
});

test("offline rebuilding clears only reviewed tables atomically, preserves subscriptions and costs, then resumes without extra receipts", async () => {
  const scratch = await mkdtemp(path.join(process.env.AIHOT_DATA_DIR ?? tmpdir(), "offline-import-")), backup = path.join(scratch, "before.dump"), evidencePath = path.join(scratch, "evidence.json");
  await writeFile(evidencePath, JSON.stringify({ origin: "browser", text }));
  await sql`INSERT INTO monitor_webhook_subscriptions(id,name,url,platforms,secret) VALUES('10000000-0000-4000-8000-000000000001','Preserved subscription','https://example.test/hook',ARRAY['codex'],'synthetic')`;
  await sql`INSERT INTO audit_log(actor,action,subject) VALUES('test','preserve','offline-test')`;
  await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,response) VALUES('offline-preserved-receipt','synthetic','synthetic','synthetic','completed','{}'::jsonb)`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex','old-state','{}'::jsonb)`;
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,text) VALUES('codex','old-post','source',${at},'https://example.test/old','Preserved until apply')`;
  execFileSync("pg_dump", ["--format=custom", "--file", backup, process.env.DATABASE_URL!], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const preview = await offlinePlan("clear"), options = { target: preview.target, fingerprint: preview.fingerprint, workerStopped: true, backup };
  await assert.rejects(clearOfflineMonitor({ ...options, workerStopped: false }), /Stop/);
  await assert.rejects(clearOfflineMonitor({ ...options, target: "wrong" }), /identity/);
  await assert.rejects(clearOfflineMonitor({ ...options, fingerprint: "wrong" }), /changed/);
  assert.deepEqual(await offlinePlan("clear"), preview, "preview and rejected commands never mutate rows");
  await sql`CREATE FUNCTION block_offline_delete() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic rollback''; END'`;
  await sql`CREATE TRIGGER block_offline_delete BEFORE DELETE ON monitor_state FOR EACH STATEMENT EXECUTE FUNCTION block_offline_delete()`;
  try { await assert.rejects(clearOfflineMonitor(options), /synthetic rollback/); }
  finally { await sql`DROP TRIGGER block_offline_delete ON monitor_state`; await sql`DROP FUNCTION block_offline_delete()`; }
  assert.deepEqual(await offlinePlan("clear"), preview, "a deletion failure rolls back earlier table deletions");
  await clearOfflineMonitor(options);
  const cleared = await offlineSnapshot();
  for (const row of cleared.tables) {
    if (["receipts", "audit_log", "monitor_webhook_subscriptions"].includes(row.table)) assert.deepEqual(row, preview.tables.find(before => before.table === row.table));
    else assert.equal(row.count, 0);
  }
  const bundle: OfflineBundle = { version: 1, capturedAt: at, sources: [
    { monitorId: "codex", id: "101", url: `https://x.com/${account}/status/101`, status: "observed", author: account, publishedAt: at, text, evidencePath },
    { monitorId: "claude", id: "101", url: "https://x.com/OtherSource/status/101", status: "observed", author: "OtherSource", publishedAt: at, text: "No relevant event.", evidencePath, recognition: { relevant: false, needsReview: false, title: properName("Other update"), summary: null, actions: [] } },
    { monitorId: "grok", id: "999", url: "https://x.com/grok/status/999", status: "unavailable", reason: "Deleted post", evidencePath },
  ] };
  mock.method(globalThis, "fetch", () => { throw new Error("Offline import must never make paid or external calls"); });
  async function run(input = bundle) { const plan = await offlinePlan("import", input); return importOfflineBundle(input, { target: plan.target, fingerprint: plan.fingerprint, workerStopped: true }); }
  try {
    const first = await run();
    assert.deepEqual(first.results.map(row => [row.monitorId, row.status]), [["claude", "processed"], ["codex", "pending"], ["grok", "unavailable"]]);
    let finishPlan = await offlinePlan("finish");
    await assert.rejects(finishOfflineImport({ ...finishPlan, workerStopped: true }), /pending/);
    bundle.sources[0] = { ...bundle.sources[0]!, recognition: recognized() } as OfflineBundle["sources"][number];
    const resumed = await run();
    assert.equal(resumed.results.find(row => row.monitorId === "codex")!.status, "processed");
    assert.equal(resumed.results.find(row => row.monitorId === "codex")!.eventIds.length, 1);
    assert.deepEqual((await run()).results, resumed.results, "completed posts are not recognized again");
    const duplicate = recognized();
    duplicate.actions[0]!.eventId = "source:101";
    duplicate.actions[0]!.existingActionId = "source:101";
    duplicate.actions[0]!.localEventKey = null;
    const additional: OfflineBundle = { version: 1, capturedAt: at, sources: [{ monitorId: "codex", id: "102", url: `https://x.com/${account}/status/102`, status: "observed", author: account, publishedAt: "2026-10-10T12:01:00.000Z", text, evidencePath, recognition: duplicate }] };
    const linked = await run(additional);
    assert.deepEqual(linked.results[0]!.eventIds, resumed.results.find(row => row.monitorId === "codex")!.eventIds, "explicit source references reuse the verified event and action");
    const eventId = linked.results[0]!.eventIds[0]!;
    await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,sources) VALUES('codex','synthetic-second-confirm',${eventId},2,'confirm',${sql.json(properName("Second confirmation"))},'[{"postId":"101"}]'::jsonb)`;
    additional.sources[0] = { ...additional.sources[0]!, id: "103", url: `https://x.com/${account}/status/103` } as OfflineBundle["sources"][number];
    const ambiguous = await run(additional);
    assert.equal(ambiguous.results[0]!.status, "needs_attention");
    assert.match(ambiguous.results[0]!.reason!, /唯一匹配动作/, "ambiguous source references must never choose the first action");
    const [ambiguousText] = await sql`SELECT title,summary FROM monitor_source_posts WHERE monitor_id='codex' AND id='103'`;
    assert.deepEqual(ambiguousText!.title, duplicate.title); assert.deepEqual(ambiguousText!.summary, duplicate.summary);
    await sql`INSERT INTO monitor_event_records(monitor_id,id,type,created_at) VALUES('codex','synthetic-second-event','direct_reset',${at})`;
    await sql`INSERT INTO monitor_event_actions(monitor_id,id,event_id,sequence,action,title,sources) VALUES('codex','synthetic-second-event-confirm','synthetic-second-event',1,'confirm',${sql.json(properName("Another event"))},'[{"postId":"101"}]'::jsonb)`;
    additional.sources[0] = { ...additional.sources[0]!, id: "105", url: `https://x.com/${account}/status/105` } as OfflineBundle["sources"][number];
    const ambiguousEvent = await run(additional);
    assert.equal(ambiguousEvent.results[0]!.status, "needs_attention");
    assert.match(ambiguousEvent.results[0]!.reason!, /唯一事件/);
    additional.sources[0] = { monitorId: "codex", id: "104", url: `https://x.com/${account}/status/104`, status: "observed", author: account, publishedAt: at, text: "https://x.com/i/article/123456", evidencePath, recognition: recognized() };
    const incompleteArticle = await run(additional);
    assert.equal(incompleteArticle.results[0]!.status, "needs_attention");
    assert.match(incompleteArticle.results[0]!.reason!, /正文未保存/);
    const [incompleteText] = await sql`SELECT title,summary FROM monitor_source_posts WHERE monitor_id='codex' AND id='104'`;
    assert.deepEqual(incompleteText!.title, recognized().title); assert.deepEqual(incompleteText!.summary, recognized().summary);
    const [costs] = await sql`SELECT count(*)::int AS count FROM receipts`;
    assert.equal(costs!.count, preview.tables.find(row => row.table === "receipts")!.count);
    const posts = await sql`SELECT source_receipt_id,model_receipt_id FROM monitor_source_posts`;
    assert.ok(posts.every(post => post.source_receipt_id === null && post.model_receipt_id === null));
    finishPlan = await offlinePlan("finish");
    await finishOfflineImport({ ...finishPlan, workerStopped: true });
    const [pending] = await sql`SELECT count(*)::int AS count FROM monitor_state WHERE key LIKE 'public_v2:pending:%' OR key LIKE '%cursor%'`;
    assert.equal(pending!.count, 0);
    const [notifications] = await sql`SELECT (SELECT count(*) FROM monitor_webhook_notifications)::int AS notifications,(SELECT count(*) FROM monitor_webhook_deliveries)::int AS deliveries`;
    assert.deepEqual(notifications, { notifications: 0, deliveries: 0 });
  } finally { mock.restoreAll(); }
});

test("historical author trust is limited to observed sources in this monitor and bundle, never quote metadata or daily configuration", async () => {
  const scratch = await mkdtemp(path.join(process.env.AIHOT_DATA_DIR ?? tmpdir(), "offline-author-trust-"));
  const evidencePath = path.join(scratch, "evidence.json"), historicalAuthor = "ArchiveSource";
  await writeFile(evidencePath, JSON.stringify({ origin: "browser", text: "Synthetic source evidence" }));
  const dailyAuthors = structuredClone(RESET_MONITORS.grok.authors);
  const definitionAuthors = structuredClone(grok.authors);
  assert.equal(inMonitor(grok, () => isAuthor(historicalAuthor)), false);
  const original = "We reset Grok usage for everyone.", repeated = "Grok usage limits reset.";
  const observed = (id: string, author: string, sourceText: string, publishedAt: string) => ({
    monitorId: "grok" as const, status: "observed" as const, id, author,
    url: `https://x.com/${author}/status/${id}`, publishedAt, text: sourceText, evidencePath,
  });
  function reset(sourceText: string, reference?: string): Recognition {
    const result = recognized(), action = result.actions[0]!;
    action.excerpt = sourceText;
    action.rawScope.productsZh = "Grok";
    action.scope.productCodes = ["grok"];
    action.scopeExcerpt = sourceText;
    if (reference) {
      action.eventId = `source:${reference}`;
      action.existingActionId = `source:${reference}`;
      action.localEventKey = null;
    }
    return result;
  }
  const quotedPost = { id: "201", author: historicalAuthor, relation: "quote" as const, text: original, publishedAt: at,
    url: `https://x.com/${historicalAuthor}/status/201` };
  const bundle: OfflineBundle = { version: 1, capturedAt: at, sources: [
    { ...observed("202", "grok", repeated, "2026-10-10T12:01:00.000Z"), quotedPost, recognition: reset(repeated, "201") },
    { ...observed("201", historicalAuthor, original, at), recognition: reset(original) },
  ] };
  const [before] = await sql`SELECT count(*)::integer AS count FROM receipts`;
  mock.method(globalThis, "fetch", () => { throw new Error("Author verification must not call any external service"); });
  const run = async (input: OfflineBundle) => {
    const plan = await offlinePlan("import", input);
    return importOfflineBundle(input, { target: plan.target, fingerprint: plan.fingerprint, workerStopped: true });
  };
  try {
    const accepted = await run(bundle);
    assert.deepEqual(accepted.results.map(row => row.status), ["processed", "processed"], JSON.stringify(accepted.results));
    assert.deepEqual(accepted.results[0]!.eventIds, accepted.results[1]!.eventIds, "a verified historical quote adds a source to the same action");
    const [saved] = await sql`SELECT sources FROM monitor_event_actions WHERE monitor_id='grok' AND sources @> '[{"postId":"201"}]'::jsonb`;
    assert.deepEqual(saved!.sources, [{ postId: "201" }, { postId: "202" }]);
    assert.deepEqual(grok.authors, definitionAuthors);
    assert.deepEqual(RESET_MONITORS.grok.authors, dailyAuthors);
    assert.equal(inMonitor(grok, () => isAuthor(historicalAuthor)), false, "temporary authority cannot escape the import's async scope");

    const later: OfflineBundle = { version: 1, capturedAt: at, sources: [
      { ...observed("203", "LaterOfficial", repeated, "2026-10-10T12:02:00.000Z"), quotedPost, recognition: reset(repeated, "201") },
      { monitorId: "grok", status: "unavailable", id: "204", url: `https://x.com/${historicalAuthor}/status/204`, reason: "Unavailable source", evidencePath },
      { monitorId: "claude", status: "observed", id: "205", url: `https://x.com/${historicalAuthor}/status/205`, author: historicalAuthor,
        text: "An unrelated update.", publishedAt: at, evidencePath,
        recognition: { relevant: false, needsReview: false, title: properName("Other update"), summary: null, actions: [] } },
    ] };
    const rejected = await run(later), reply = rejected.results.find(row => row.monitorId === "grok" && row.id === "203")!;
    assert.equal(reply.status, "needs_attention");
    assert.match(reply.reason!, /跨作者关联/,
      "quote author, an unavailable URL and an observed author in another monitor do not grant Grok authority");
    const [unchanged] = await sql`SELECT sources FROM monitor_event_actions WHERE monitor_id='grok' AND sources @> '[{"postId":"201"}]'::jsonb`;
    assert.deepEqual(unchanged!.sources, saved!.sources);
    assert.equal(inMonitor(grok, () => isAuthor(historicalAuthor)), false);
    assert.equal(inMonitor(grok, () => isAuthor("LaterOfficial")), false);
    assert.deepEqual(RESET_MONITORS.grok.authors, dailyAuthors);
    const [after] = await sql`SELECT count(*)::integer AS count FROM receipts`;
    assert.equal(after!.count, before!.count);
  } finally { mock.restoreAll(); }
});
