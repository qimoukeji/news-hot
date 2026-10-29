import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb, type Db } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../../../apps/api/src/app.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { setWithdrawn } from "../backend/admin.ts";
import { monitorEventDetail, previewMonitorEventReview, submitMonitorEventReview } from "../backend/manual-review.ts";
import { exportPublicV2, applyPublicV2 } from "../backend/public-v2-review.ts";
import { processPublicV2Pending } from "../backend/public-v2-generate.ts";
import { enqueuePublicV2 } from "../backend/public-v2-work.ts";
import { createMonitorServer } from "../server.ts";
import { properName, projectPublicV2 } from "../backend/public-v2.ts";
import { loadActionInput, sourcePost, writePostActions, rowVersion } from "../backend/action-store.ts";
import type { ActionDraft, EditorialText } from "../actions.ts";
import { initializeWebhookBaselines, captureWebhookEvent, sweepConfirmationResults } from "../backend/webhook-events.ts";
import { createSubscription, updateSubscription, listSubscriptions, rotateSubscriptionSecret,
  listWebhookDeliveries, retryWebhookDelivery, deliverWebhook, webhookSignature, webhookRetryDelays,
  sweepWebhookDeliveries, type WebhookTransport } from "../backend/webhooks.ts";
import { createSubscriptionsServer } from "../subscriptions-server.ts";
import { webhookPayloadSchema, type WebhookPlatform } from "../webhooks.ts";

const definitions = [codex, claude, grok];
const sourceAt = "2026-10-01T12:00:00Z";
const eventId = "shared-event";
const scope = { type: "all_users" as const, productCodes: [], planCodes: [], quotaWindowCodes: [], note: null };

beforeEach(async () => {
  installModules([]);
  await sql`DELETE FROM monitor_webhook_deliveries`;
  await sql`DELETE FROM monitor_webhook_notifications`;
  await sql`DELETE FROM monitor_webhook_subscriptions`;
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state WHERE key LIKE 'webhook:%' OR key LIKE 'public_v2:%'`;
  await sql`DELETE FROM audit_log`;
});

after(async () => { installModules([]); await stopBoss(); await closeDb(); });

async function addPost(definition = codex, id = "source-post", at = sourceAt, db: Db = sql) {
  await db`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,summary,processing_status) VALUES
    (${definition.monitorId},${id},${definition.authors[0]!.handle},${at},${`https://x.com/${definition.authors[0]!.handle}/status/${id}`},${db.json(properName("Synthetic source"))},NULL,'processed')`;
}
async function addEvent(definition = codex, ready = false) {
  await addPost(definition);
  await sql.begin(db => inMonitor(definition, async () => {
    const post = await sourcePost("source-post", db);
    await writePostActions(db, post!, [{ eventId, action: "confirm",
      title: ready ? properName("Synthetic reset completed") : { zh: "Synthetic reset completed" },
      summary: null, time: sourceAt }], { events: [{ id: eventId, type: "direct_reset", scope }] });
  }));
}
type ReviewPatch = { title?: EditorialText; summary?: EditorialText | null; time?: string; scope?: typeof scope | { type: "paid_users"; productCodes: string[]; planCodes: string[]; quotaWindowCodes: string[]; note: null } };
async function saveReview(definition = codex, patch: ReviewPatch = {}, db: Db = sql) {
  await db`UPDATE monitor_event_actions SET title=${db.json(properName("Synthetic reset completed"))}
    WHERE monitor_id=${definition.monitorId} AND event_id=${eventId}`;
  if ("title" in patch) await db`UPDATE monitor_event_records SET title=${db.json(patch.title!)} WHERE monitor_id=${definition.monitorId} AND id=${eventId}`;
  if ("summary" in patch) await db`UPDATE monitor_event_records SET summary=${patch.summary ? db.json(patch.summary) : null} WHERE monitor_id=${definition.monitorId} AND id=${eventId}`;
  if (patch.time) await db`UPDATE monitor_event_actions SET time=${patch.time} WHERE monitor_id=${definition.monitorId} AND event_id=${eventId}`;
  if (patch.scope) await db`UPDATE monitor_event_records SET scope=${db.json(patch.scope)} WHERE monitor_id=${definition.monitorId} AND id=${eventId}`;
}
const capture = (definition = codex) => sql.begin(db => inMonitor(definition, () => captureWebhookEvent(db, eventId)));
async function subscriber(platforms: WebhookPlatform[] = ["codex"], enabled = true) {
  return createSubscription({ name: "Synthetic subscriber", url: "https://8.8.8.8/hook?token=synthetic-query-secret",
    platforms, enabled, reason: "Synthetic test subscription" }, "test-admin", definitions);
}
async function notifications() {
  const rows = await sql`SELECT payload FROM monitor_webhook_notifications ORDER BY monitor_id,event_id,revision`;
  return rows.map(row => webhookPayloadSchema.parse(row.payload));
}

test("time checks establish history without replay and notify inference and later official proof only once", async () => {
  await addEvent(codex, true);
  const starts = Date.now(), future = new Date(starts + 60_000).toISOString();
  await sql`UPDATE monitor_event_actions SET action='announce',time=${future} WHERE monitor_id='codex' AND event_id=${eventId}`;
  await subscriber(["codex"]);
  await sweepConfirmationResults(definitions, starts);
  assert.equal((await notifications()).length, 0);
  await sweepConfirmationResults(definitions, starts + 60_001);
  let events = await notifications();
  assert.equal(events.length, 1); assert.equal(events[0]!.event!.updates[0]!.action, "confirm"); assert.deepEqual(events[0]!.event!.updates[0]!.sources, []);
  const revision = events[0]!.revision;
  await sweepConfirmationResults(definitions, starts + 120_000);
  assert.equal((await notifications()).length, 1);
  await sql.begin(db => inMonitor(codex, async () => writePostActions(db, (await sourcePost("source-post", db))!, [{ eventId, action: "confirm", time: new Date(starts).toISOString(), title: properName("Official confirmation"), summary: null }])));
  await sweepConfirmationResults(definitions, starts + 120_000);
  events = await notifications(); assert.equal(events.length, 2);
  assert.equal(events[1]!.revision, revision + 1); assert.ok(events[1]!.event!.updates.some(update => update.action === "confirm" && update.sources.length > 0));
  await sweepConfirmationResults(definitions, starts + 180_000);
  assert.equal((await notifications()).length, 2);
});

test("historical elapsed plans establish confirmation baselines without sending old notifications", async () => {
  await addEvent(codex, true);
  await sql`UPDATE monitor_event_actions SET action='announce' WHERE monitor_id='codex' AND event_id=${eventId}`;
  await subscriber(["codex"]);
  await sweepConfirmationResults(definitions);
  assert.equal((await notifications()).length, 0);
});

test("ordinary manual confirmations publish their entered title without waiting for model translation", async () => {
  await addEvent(codex, true);
  await sql`UPDATE monitor_event_actions SET action='announce',time=${new Date(Date.now() + 86_400_000).toISOString()} WHERE monitor_id='codex'`;
  await initializeWebhookBaselines(definitions); await subscriber();
  await inMonitor(codex, async () => {
    const detail = (await monitorEventDetail(eventId))!;
    const body = { version: detail.version, versions: detail.versions, reason: "Private manual evidence", actions: { create: [{ localKey: "manual", eventId, action: "confirm", time: sourceAt, title: { zh: "人工核实已生效" }, summary: { zh: "管理员已核实生效，无官方帖子" } }] } };
    const preview = (await previewMonitorEventReview(eventId, body))!;
    await submitMonitorEventReview(eventId, { ...body, previewToken: preview.previewToken }, "private-admin");
  });
  const rows = await notifications(); assert.equal(rows.length, 1);
  const confirmation = rows[0]!.event!.updates.find(update => update.action === "confirm")!;
  assert.deepEqual(confirmation.sources, []); assert.equal(confirmation.title.zh, "人工核实已生效");
  assert.equal(confirmation.summary!.zh, "管理员已核实生效，无官方帖子");
  assert.equal(JSON.stringify(rows).includes("Private manual evidence"), false);
});

async function delivery(id: string) {
  const [row] = await sql`SELECT * FROM monitor_webhook_deliveries WHERE id=${id}`;
  assert.ok(row); return row;
}
async function withdraw(withdrawn: boolean) {
  return inMonitor(codex, async () => {
    const event = (await loadActionInput()).events.find(event => event.id === eventId)!;
    return setWithdrawn(eventId, { withdrawn, version: rowVersion(event), reason: "Synthetic manual withdrawal test" }, "test-admin");
  });
}
async function mutateAction(patch: Partial<ActionDraft>) {
  await sql.begin(db => inMonitor(codex, async () => {
    const input = await loadActionInput(db), action = input.actions[0]!, post = input.posts[0]!;
    await writePostActions(db, post, [{ id: action.id, eventId, action: action.action,
      title: action.title, summary: action.summary, time: action.time, ...patch }], { replace: true, editExisting: true });
    await enqueuePublicV2(db, [eventId]);
  }));
}

test("complete seven-language actions notify immediately and isolate identical IDs across all platforms", async () => {
  await initializeWebhookBaselines(definitions);
  const subscriptions = await Promise.all(definitions.map(definition => subscriber([definition.publicV2!.platform])));
  for (const definition of definitions) {
    await addEvent(definition, true);
    await capture(definition); await capture(definition);
    const notification = (await notifications()).find(row => row.platform === definition.publicV2!.platform)!;
    assert.equal(notification.action, "created"); assert.equal(notification.revision, 1);
    const snapshot = await inMonitor(definition, async () => projectPublicV2(await loadActionInput(), definition));
    const event = snapshot.events[0]!;
    assert.deepEqual(notification.event, event);
    assert.equal(Object.keys(event.updates[0]!.title).length, 7);
    assert.deepEqual(event.updates[0]!.sources.map(source => source.postId), ["source-post"]);
  }
  assert.equal((await notifications()).length, 3);
  for (const { subscription } of subscriptions) {
    const deliveries = (await listWebhookDeliveries(subscription.id))!.deliveries;
    assert.equal(deliveries.length, 1); assert.equal(deliveries[0]!.platform, subscription.platforms[0]);
  }
});

test("standard scope labels notify without model translation and custom eligibility still waits", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent(codex, true);
  const setScope = async (type: string, note: Record<string, string>) => {
    await sql`UPDATE monitor_event_records SET scope=${sql.json({ ...scope, type, note })} WHERE monitor_id='codex' AND id=${eventId}`;
  };
  for (const [type, note] of [["selected_users", { zh: "所有用户" }], ["all_users", { zh: "仅限注册满一年的用户" }],
    ["all_users", { zh: "所有用户", en: "Paid users" }]] as const) {
    await setScope(type, note); await capture();
    assert.equal((await notifications()).length, 0);
  }
  await setScope("all_users", { zh: "所有用户" });
  await capture(); await capture();
  const rows = await notifications();
  assert.equal(rows.length, 1);
  const snapshot = await inMonitor(codex, async () => projectPublicV2(await loadActionInput(), codex));
  assert.deepEqual(rows[0]!.event, snapshot.events[0]);
  assert.equal(rows[0]!.event!.scope.note!.en, "All users");
});

test("partial action or event titles and summaries wait for translation", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent();
  await capture(); assert.equal((await notifications()).length, 0);
  await saveReview(codex, { summary: { zh: "Synthetic pending summary" } });
  await capture(); assert.equal((await notifications()).length, 0);
  await saveReview(codex, { summary: properName("Synthetic pending summary"), title: { zh: "Synthetic pending title" } });
  await capture(); assert.equal((await notifications()).length, 0);
  await saveReview(codex, { title: properName("Synthetic pending title") });
  await capture(); assert.equal((await notifications()).length, 1);
  await sql`UPDATE monitor_event_actions SET summary='{"zh":"Synthetic action summary"}'::jsonb WHERE monitor_id='codex'`;
  await capture(); assert.equal((await notifications()).length, 1);
  await sql`UPDATE monitor_event_actions SET summary=${sql.json(properName("Synthetic action summary"))} WHERE monitor_id='codex'`;
  await capture(); await capture();
  assert.deepEqual((await notifications()).map(row => row.action), ["created", "updated"]);
});

test("title, summary, action time, scope and accepted action changes each trigger one revision", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent(codex, true); await capture();
  for (const patch of [
    { title: properName("Synthetic corrected title") }, { summary: properName("Synthetic corrected explanation") },
    { time: "2026-10-01T13:00:00Z" }, { scope: { ...scope, type: "paid_users" as const } },
  ]) {
    const count = (await notifications()).length;
    await saveReview(codex, patch); await capture(); await capture();
    assert.equal((await notifications()).length, count + 1);
  }
  await mutateAction({ action: "announce" });
  assert.equal((await notifications()).at(-1)!.event!.status, "announced");
  await addPost(codex, "business-update", "2026-10-01T14:00:00Z");
  await sql.begin(db => inMonitor(codex, async () => {
    const post = await sourcePost("business-update", db);
    await writePostActions(db, post!, [{ eventId, action: "progress", title: properName("Synthetic rollout progress"), summary: properName("Synthetic progress"), time: null }]);
    await enqueuePublicV2(db, [eventId]);
  }));
  const rows = await notifications();
  assert.deepEqual(rows.map(row => row.revision), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(rows.at(-1)!.event!.status, "in_progress");
  assert.equal(rows.at(-1)!.event!.updates[0]!.action, "progress");
});

test("another post enriches one action with all sources without duplicating its update", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent(codex, true); await capture();
  await addPost(codex, "additional-source", "2026-10-01T13:00:00Z");
  await sql.begin(db => inMonitor(codex, async () => {
    const input = await loadActionInput(db), action = input.actions[0]!, post = input.posts.find(post => post.id === "additional-source")!;
    await writePostActions(db, post, [{ id: action.id, eventId, action: action.action, title: action.title, summary: action.summary, time: action.time }]);
    await enqueuePublicV2(db, [eventId]);
  }));
  const event = (await notifications()).at(-1)!.event!;
  assert.equal(event.updates.length, 1);
  assert.deepEqual(event.updates[0]!.sources.map(source => source.postId), ["source-post", "additional-source"]);
  assert.equal(event.updates[0]!.publishedAt, new Date(sourceAt).toISOString());
  assert.equal((await notifications()).length, 2);
});

test("removing the only valid initial action withdraws and restoring an initial action restores", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent(codex, true); await capture();
  await sql.begin(db => inMonitor(codex, async () => {
    const post = await sourcePost("source-post", db);
    await writePostActions(db, post!, [], { replace: true });
    await enqueuePublicV2(db, [eventId]);
  }));
  assert.equal((await notifications()).at(-1)!.event, null);
  await sql.begin(db => inMonitor(codex, async () => {
    const post = await sourcePost("source-post", db);
    await writePostActions(db, post!, [{ eventId, action: "confirm", title: properName("Synthetic restored confirmation"), summary: null, time: sourceAt }]);
    await enqueuePublicV2(db, [eventId]);
  }));
  assert.deepEqual((await notifications()).map(row => row.action), ["created", "withdrawn", "restored"]);
});

test("business changes and notification records roll back together without consuming a revision", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent();
  await assert.rejects(sql.begin(async db => {
    await saveReview(codex, {}, db);
    await inMonitor(codex, () => captureWebhookEvent(db, eventId));
    throw new Error("Synthetic rollback");
  }), /Synthetic rollback/);
  assert.equal((await notifications()).length, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_webhook_deliveries`)[0]!.n, 0);
  const input = await inMonitor(codex, () => loadActionInput());
  assert.deepEqual(input.actions[0]!.title, { zh: "Synthetic reset completed" });
  await saveReview(); await capture();
  assert.equal((await notifications())[0]!.revision, 1);
});

test("administrator editorial review publishes in its transaction and rejects stale records", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent();
  const bundle = await exportPublicV2([codex]);
  const action = bundle.monitors[0]!.reviews.find(review => review.kind === "action")!;
  action.editorial.title = properName("Synthetic accepted action title");
  await applyPublicV2(bundle, [codex], "Publish translated synthetic event", "test-reviewer");
  assert.equal((await notifications()).length, 1);
  assert.deepEqual((await notifications())[0]!.event!.title, action.editorial.title);
  const stale = await exportPublicV2([codex]);
  stale.monitors[0]!.reviews[0]!.expectedVersion = "stale-version";
  await assert.rejects(applyPublicV2(stale, [codex], "Reject stale editorial", "test-reviewer"), /changed/i);
  assert.equal((await notifications()).length, 1);
});

test("worker translates only display fields then creates a ready notification without direct capture", async () => {
  await initializeWebhookBaselines(definitions); const { subscription } = await subscriber(); await addEvent();
  let requests = 0;
  const model = await stub((_hit, request) => {
    requests++;
    const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content);
    assert.deepEqual(Object.keys(input).sort(), ["note", "summary", "title"]);
    const content = { title: input.title ? properName(Object.values(input.title)[0] as string) : null,
      summary: input.summary ? properName(Object.values(input.summary)[0] as string) : null, note: input.note ? properName(Object.values(input.note)[0] as string) : null };
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  });
  const env = { MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "synthetic-local-key", LLM_MODEL: "synthetic-webhook-v2", COLLECT_ENABLED: "true" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const oldPrivate = config.allowPrivateNetworkFetch, oldModelCalls = config.modelCallsEnabled;
  try {
    Object.assign(process.env, env); config.allowPrivateNetworkFetch = true; config.modelCallsEnabled = true;
    installModules(definitions.map(createMonitorServer));
    assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 1 });
    assert.equal(requests, 1); assert.equal((await notifications()).length, 1);
    assert.equal((await listWebhookDeliveries(subscription.id))!.deliveries.length, 1);
    assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 0 });
    assert.equal(requests, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    config.allowPrivateNetworkFetch = oldPrivate; config.modelCallsEnabled = oldModelCalls;
    installModules([]); await model.close();
  }
});

test("initial history creates a baseline without backfill and subscriptions see subsequent changes", async () => {
  await addEvent(codex, true); await initializeWebhookBaselines(definitions);
  const { subscription } = await subscriber(["codex"], false);
  await capture(); assert.equal((await notifications()).length, 0);
  await updateSubscription(subscription.id, { enabled: true, reason: "Start receiving changes" }, "test-admin", definitions);
  assert.equal((await listWebhookDeliveries(subscription.id))!.deliveries.length, 0);
  await saveReview(codex, { summary: properName("Synthetic first subscribed change") }); await capture();
  assert.equal((await notifications())[0]!.action, "updated");
});

test("historical partial translations do not backfill when first completed", async () => {
  await addEvent(); await initializeWebhookBaselines(definitions); await subscriber();
  await saveReview(); await capture(); assert.equal((await notifications()).length, 0);
  await saveReview(codex, { summary: properName("Synthetic later correction") }); await capture();
  assert.deepEqual((await notifications()).map(row => row.action), ["updated"]);
});

test("manual withdrawal and restoration keep monotonic revisions and require no receipt override", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent(codex, true); await capture();
  await withdraw(true); await capture(); assert.equal((await notifications()).at(-1)!.event, null);
  await withdraw(false); await capture();
  assert.deepEqual((await notifications()).map(row => row.action), ["created", "withdrawn", "restored"]);
  assert.deepEqual((await notifications()).map(row => row.revision), [1, 2, 3]);
});
test("subscription defaults, one-time secrets and audit redaction preserve administrator accountability", async () => {
  const saved = await createSubscription({ name: "Synthetic subscriber", url: "https://8.8.8.8/private-path?token=synthetic-query-secret",
    platforms: ["codex", "grok"], reason: "Add callback" }, "admin-a", definitions);
  assert.equal(saved.subscription.enabled, false); assert.equal(saved.subscription.enabledAt, null);
  assert.ok(saved.secret.length >= 32);
  const listed = JSON.stringify(await listSubscriptions());
  assert.equal(listed.includes(saved.secret), false);
  const rotated = await rotateSubscriptionSecret(saved.subscription.id, "Rotate test key", "admin-b");
  assert.ok(rotated); assert.notEqual(rotated.secret, saved.secret);
  const audits = await sql`SELECT actor,action,reason,before,after FROM audit_log ORDER BY id`;
  assert.deepEqual(audits.map(row => row.actor), ["admin-a", "admin-b"]);
  const text = JSON.stringify(audits);
  for (const sensitive of [saved.secret, rotated.secret, "private-path", "synthetic-query-secret"]) assert.equal(text.includes(sensitive), false);
});

test("renaming an enabled subscription preserves its activation and pending deliveries", async () => {
  await initializeWebhookBaselines(definitions); const { subscription } = await subscriber();
  await addEvent(); await saveReview(); await capture();
  const saved = await updateSubscription(subscription.id, { name: "Renamed subscriber", reason: "Change display name" }, "test-admin", definitions);
  assert.equal(saved!.enabled, true); assert.equal(saved!.enabledAt, subscription.enabledAt); assert.equal(saved!.generation, subscription.generation);
  assert.equal((await listWebhookDeliveries(subscription.id))!.deliveries[0]!.status, "pending");
});

test("delivery signs the immutable payload and forces safe transport options; disabled push performs no request", async () => {
  await initializeWebhookBaselines(definitions); const { subscription, secret } = await subscriber();
  await addEvent(); await saveReview(); await capture();
  const target = (await listWebhookDeliveries(subscription.id))!.deliveries[0]!;
  let hits = 0;
  const transport: WebhookTransport = async (url, options) => {
    hits += 1; assert.equal(url, subscription.url);
    assert.equal(options.method, "POST"); assert.equal(options.timeoutMs, 10_000);
    assert.equal(options.maxRedirects, 0); assert.equal(options.allowPrivateNetwork, false); assert.equal(options.route, "egress");
    const body = options.body as string, headers = options.headers as Record<string, string>;
    const payload = webhookPayloadSchema.parse(JSON.parse(body));
    assert.equal(headers["X-Webhook-Id"], payload.id);
    assert.equal(headers["X-Webhook-Signature"], webhookSignature(secret, headers["X-Webhook-Timestamp"]!, body));
    assert.equal(payload.id, target.notificationId);
    return { status: 204 };
  };
  await deliverWebhook(target.id, { transport, pushEnabled: () => false });
  assert.equal(hits, 0); assert.equal((await delivery(target.id)).attempts, 0);
  await Promise.all([deliverWebhook(target.id, { transport, pushEnabled: () => true }), deliverWebhook(target.id, { transport, pushEnabled: () => true })]);
  await deliverWebhook(target.id, { transport, pushEnabled: () => true });
  assert.equal(hits, 1); const sent = await delivery(target.id);
  assert.equal(sent.status, "sent"); assert.equal(sent.attempts, 1); assert.equal(sent.last_status, 204); assert.ok(sent.sent_at);
});

test("failed callbacks retry on the agreed schedule with stable bytes and stop after five attempts", async () => {
  await initializeWebhookBaselines(definitions); const { subscription, secret } = await subscriber();
  await addEvent(); await saveReview(); await capture();
  const target = (await listWebhookDeliveries(subscription.id))!.deliveries[0]!;
  const bodies: string[] = [];
  const transport: WebhookTransport = async (_url, options) => {
    bodies.push(options.body as string);
    if (bodies.length === 2) throw new Error(`Sensitive transport detail ${secret}`);
    return { status: 503 };
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sql`UPDATE monitor_webhook_deliveries SET next_attempt_at=now() WHERE id=${target.id}`;
    const before = Date.now();
    await deliverWebhook(target.id, { transport, pushEnabled: () => true });
    const row = await delivery(target.id);
    assert.equal(row.attempts, attempt);
    assert.equal(row.status, attempt === 5 ? "failed" : "pending");
    assert.equal(String(row.last_error).includes(secret), false);
    if (attempt < 5) {
      const scheduled = new Date(row.next_attempt_at).getTime();
      assert.ok(scheduled >= before + webhookRetryDelays[attempt - 1]! * 1000);
      assert.ok(scheduled <= Date.now() + webhookRetryDelays[attempt - 1]! * 1000);
      const jobs = await sql`SELECT start_after FROM pgboss.job WHERE name='reset-subscriptions.deliver'
        AND data->>'deliveryId'=${target.id} AND start_after>=${new Date(before + webhookRetryDelays[attempt - 1]! * 1000)}`;
      assert.equal(jobs.length, 1, "retry is queued for its due time even while the previous attempt job still exists");
      assert.equal(new Date(jobs[0]!.start_after).getTime(), scheduled);
    }
  }
  await deliverWebhook(target.id, { transport, pushEnabled: () => true });
  assert.equal(bodies.length, 5); assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(await retryWebhookDelivery(subscription.id, target.id, "Retry recovered endpoint", "test-admin"), { ok: true });
  await deliverWebhook(target.id, { transport: async () => ({ status: 200 }), pushEnabled: () => true });
  assert.equal((await delivery(target.id)).status, "sent"); assert.equal((await delivery(target.id)).attempts, 1);
});

test("sweeping a crashed final attempt records a failure without allowing a sixth send", async () => {
  await initializeWebhookBaselines(definitions); const { subscription } = await subscriber();
  await addEvent(); await saveReview(); await capture();
  const target = (await listWebhookDeliveries(subscription.id))!.deliveries[0]!;
  await sql`UPDATE monitor_webhook_deliveries SET status='sending',attempts=5,updated_at=now()-interval '3 minutes'
    WHERE id=${target.id}`;
  const previous = process.env.WEBHOOK_PUSH_ENABLED;
  try {
    process.env.WEBHOOK_PUSH_ENABLED = "true";
    assert.deepEqual(await sweepWebhookDeliveries(), { queued: 0 });
    assert.equal((await delivery(target.id)).status, "failed");
    assert.equal((await delivery(target.id)).attempts, 5);
    let hits = 0;
    await deliverWebhook(target.id, { pushEnabled: () => true, transport: async () => { hits += 1; return { status: 200 }; } });
    assert.equal(hits, 0);
  } finally {
    if (previous === undefined) delete process.env.WEBHOOK_PUSH_ENABLED;
    else process.env.WEBHOOK_PUSH_ENABLED = previous;
  }
});

test("changing endpoint or platform and disabling cancels queued work; old generations cannot be retried", async () => {
  await initializeWebhookBaselines(definitions); const { subscription } = await subscriber();
  await addEvent(); await saveReview(); await capture();
  const first = (await listWebhookDeliveries(subscription.id))!.deliveries[0]!;
  const changed = await updateSubscription(subscription.id, { url: "https://1.1.1.1/next", reason: "Change destination" }, "test-admin", definitions);
  assert.equal(changed!.generation, subscription.generation + 1);
  assert.equal((await delivery(first.id)).status, "cancelled");
  let hits = 0;
  await deliverWebhook(first.id, { pushEnabled: () => true, transport: async () => { hits += 1; return { status: 200 }; } });
  assert.equal(hits, 0);
  await sql`UPDATE monitor_webhook_deliveries SET status='failed' WHERE id=${first.id}`;
  await assert.rejects(retryWebhookDelivery(subscription.id, first.id, "Try old destination", "test-admin"), /仅可重发/);
  await saveReview(codex, { summary: properName("Synthetic destination update.") }); await capture();
  const next = (await listWebhookDeliveries(subscription.id))!.deliveries.find(row => row.id !== first.id)!;
  await updateSubscription(subscription.id, { platforms: ["grok"], reason: "Only Grok" }, "test-admin", definitions);
  assert.equal((await delivery(next.id)).status, "cancelled");
  await updateSubscription(subscription.id, { enabled: false, reason: "Pause" }, "test-admin", definitions);
  await saveReview(codex, { summary: properName("Synthetic change while paused.") }); await capture();
  await updateSubscription(subscription.id, { platforms: ["codex"], enabled: true, reason: "Resume" }, "test-admin", definitions);
  assert.equal((await listWebhookDeliveries(subscription.id))!.deliveries.length, 2, "resume does not backfill paused changes");
});

test("pausing cancels pending requests and key rotation cancels requests signed for the previous secret", async () => {
  await initializeWebhookBaselines(definitions); const { subscription } = await subscriber();
  await addEvent(); await saveReview(); await capture();
  const first = (await listWebhookDeliveries(subscription.id))!.deliveries[0]!;
  await updateSubscription(subscription.id, { enabled: false, reason: "Pause test endpoint" }, "test-admin", definitions);
  assert.equal((await delivery(first.id)).status, "cancelled");
  await saveReview(codex, { summary: properName("Synthetic change while disabled.") }); await capture();
  await updateSubscription(subscription.id, { enabled: true, reason: "Resume test endpoint" }, "test-admin", definitions);
  assert.equal((await listWebhookDeliveries(subscription.id))!.deliveries.length, 1);
  await saveReview(codex, { summary: properName("Synthetic change after resume.") }); await capture();
  const next = (await listWebhookDeliveries(subscription.id))!.deliveries.find(row => row.id !== first.id)!;
  await rotateSubscriptionSecret(subscription.id, "Invalidate previous key", "test-admin");
  assert.equal((await delivery(next.id)).status, "cancelled");
  let hits = 0;
  const transport: WebhookTransport = async () => { hits += 1; return { status: 200 }; };
  await deliverWebhook(first.id, { transport, pushEnabled: () => true });
  await deliverWebhook(next.id, { transport, pushEnabled: () => true });
  assert.equal(hits, 0);
});

test("subscription HTTP management is inaccessible to anonymous readers", async () => {
  installModules([createSubscriptionsServer(definitions)]);
  const oldAdmin = config.devAdmin; config.devAdmin = null;
  const app = await buildApp();
  try {
    for (const request of [
      { method: "GET" as const, url: "/api/admin/reset-subscriptions" },
      { method: "POST" as const, url: "/api/admin/reset-subscriptions", payload: { name: "Anonymous", url: "https://8.8.8.8/hook", platforms: ["codex"], reason: "Unauthorized" } },
    ]) assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal((await listSubscriptions()).subscriptions.length, 0);
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 0);
  } finally { config.devAdmin = oldAdmin; await app.close(); }
});



test("concurrent publication and pending cleanup serialize without duplicate revisions", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent(codex, true);
  await Promise.all([capture(), capture(), sql.begin(db => inMonitor(codex, () => enqueuePublicV2(db, [eventId])))]);
  assert.deepEqual((await notifications()).map(row => row.revision), [1]);
  await saveReview(codex, { summary: properName("Synthetic concurrent public correction") });
  const modelCallsEnabled = config.modelCallsEnabled;
  config.modelCallsEnabled = true;
  try {
    const [cleanup] = await Promise.all([
      inMonitor(codex, () => processPublicV2Pending()),
      sql.begin(db => inMonitor(codex, () => enqueuePublicV2(db, [eventId]))),
    ]);
    assert.deepEqual(cleanup, { enriched: 0 });
  } finally { config.modelCallsEnabled = modelCallsEnabled; }
  assert.deepEqual((await notifications()).map(row => row.revision), [1, 2]);
});

test("a new incomplete event can be withdrawn quietly and notify once after restored translation", async () => {
  await initializeWebhookBaselines(definitions); const { subscription } = await subscriber(); await addEvent();
  await withdraw(true); assert.equal((await notifications()).length, 0);
  await withdraw(false); assert.equal((await notifications()).length, 0);
  await saveReview(); await capture(); await capture();
  assert.deepEqual((await notifications()).map(row => row.action), ["created"]);
  assert.equal((await listWebhookDeliveries(subscription.id))!.deliveries.length, 1);
});

test("restoring a historical public event sends restoration without backfilling quiet withdrawal", async () => {
  await addEvent(codex, true); await initializeWebhookBaselines(definitions); await subscriber();
  await withdraw(true); assert.equal((await notifications()).length, 0);
  await withdraw(false); await capture(); await capture();
  assert.deepEqual((await notifications()).map(row => row.action), ["restored"]);
  assert.equal((await notifications())[0]!.revision, 1);
});

test("official cancellation is terminal until the invalidating amendment is corrected", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent(codex, true); await capture();
  await addPost(codex, "cancellation", "2026-10-01T14:00:00Z");
  await sql.begin(db => inMonitor(codex, async () => {
    const post = await sourcePost("cancellation", db);
    await writePostActions(db, post!, [{ eventId, action: "amend", invalidatesEvent: true, title: properName("Official cancellation"), summary: null, time: null }]);
    await enqueuePublicV2(db, [eventId]);
  }));
  assert.equal((await notifications()).at(-1)!.event!.status, "cancelled");
  assert.equal((await notifications()).at(-1)!.event!.updates[0]!.action, "amend");
  assert.equal((await notifications()).at(-1)!.event!.updates[0]!.invalidatesEvent, true);
  await addPost(codex, "restoration", "2026-10-01T15:00:00Z");
  await sql.begin(db => inMonitor(codex, async () => {
    const post = await sourcePost("restoration", db);
    await writePostActions(db, post!, [{ eventId, action: "announce", title: properName("Later announcement"), summary: null, time: null }]);
    await enqueuePublicV2(db, [eventId]);
  }));
  assert.equal((await notifications()).at(-1)!.event!.status, "cancelled");
  assert.equal((await notifications()).at(-1)!.event!.updates[0]!.action, "announce");
});
