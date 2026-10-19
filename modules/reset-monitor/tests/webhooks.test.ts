import { stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
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
import { exportPublicV2, applyPublicV2 } from "../backend/public-v2-review.ts";
import { processPublicV2Pending } from "../backend/public-v2-generate.ts";
import { enqueuePublicV2, clearPublicV2Work } from "../backend/public-v2-work.ts";
import { createMonitorServer } from "../server.ts";
import { evidenceVersion, loadPublicV2Input, properName, projectPublicV2 } from "../backend/public-v2.ts";
import { initializeWebhookBaselines, captureWebhookEvent } from "../backend/webhook-events.ts";
import { createSubscription, updateSubscription, listSubscriptions, rotateSubscriptionSecret,
  listWebhookDeliveries, retryWebhookDelivery, deliverWebhook, webhookSignature, webhookRetryDelays,
  sweepWebhookDeliveries, type WebhookTransport } from "../backend/webhooks.ts";
import { createSubscriptionsServer } from "../subscriptions-server.ts";
import type { ReviewedEvent } from "../public-v2.ts";
import { webhookPayloadSchema, type WebhookPlatform } from "../webhooks.ts";

const definitions = [codex, claude, grok];
const sourceAt = "2026-10-01T12:00:00Z";
const eventId = "shared-event";

beforeEach(async () => {
  installModules([]);
  await sql`DELETE FROM monitor_webhook_deliveries`;
  await sql`DELETE FROM monitor_webhook_notifications`;
  await sql`DELETE FROM monitor_webhook_subscriptions`;
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  await sql`DELETE FROM monitor_state WHERE key LIKE 'webhook:%'`;
  await sql`DELETE FROM audit_log`;
});
after(async () => { installModules([]); await stopBoss(); await closeDb(); });

async function addEvent(definition = codex, db: Db = sql) {
  await db`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url) VALUES
    (${definition.monitorId},'source-post',${definition.authors[0]!.handle},${sourceAt},'Synthetic: we reset usage at 12:00 UTC.',${`https://x.com/${definition.authors[0]!.handle}/status/source-post`})`;
  await db`INSERT INTO monitor_events(monitor_id,id,type,status,title,created_at,updated_at,confirmation_basis) VALUES
    (${definition.monitorId},${eventId},'direct_reset','confirmed','',${sourceAt},${sourceAt},'source_post')`;
  await db`INSERT INTO monitor_event_posts(monitor_id,event_id,post_id,stage,action,text,original_text) VALUES
    (${definition.monitorId},${eventId},'source-post','confirmed','confirm','Synthetic reset completed.','Synthetic reset completed.')`;
}

async function saveReview(definition = codex, patch: Partial<ReviewedEvent> = {}, db: Db = sql) {
  return inMonitor(definition, async () => {
    const input = await loadPublicV2Input(db), event = input.events.find(event => event.id === eventId)!;
    const review: ReviewedEvent = {
      evidenceVersion: evidenceVersion(event, input), evidence: [{ postId: "source-post", excerpt: input.posts[0]!.text }],
      publishedAt: sourceAt, status: "completed", title: properName(`Synthetic ${definition.monitorId} reset`), summary: properName("Synthetic reset completed."),
      time: sourceAt, updateSummaries: [{ postId: "source-post", summary: properName("Synthetic reset completed.") }],
      scope: { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null }, bonusCredit: null,
      ...patch,
    };
    await db`UPDATE monitor_events SET presentation=jsonb_set(coalesce(presentation,'{}'::jsonb),'{publicV2}',${db.json(review)},true)
      WHERE monitor_id=${definition.monitorId} AND id=${eventId}`;
    return review;
  });
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
async function delivery(id: string) {
  const [row] = await sql`SELECT * FROM monitor_webhook_deliveries WHERE id=${id}`;
  assert.ok(row); return row;
}
async function withdraw(withdrawn: boolean) {
  const [event] = await sql`SELECT updated_at FROM monitor_events WHERE monitor_id='codex' AND id=${eventId}`;
  return inMonitor(codex, () => setWithdrawn(eventId, { withdrawn, version: new Date(event!.updated_at).toISOString(), reason: "Synthetic manual withdrawal test" }, "test-admin"));
}

test("ready-only first notifications match public v2 and isolate identical event IDs across three platforms", async () => {
  await initializeWebhookBaselines(definitions);
  const subscriptions = await Promise.all(definitions.map(definition => subscriber([definition.publicV2!.platform])));
  for (const definition of definitions) {
    await addEvent(definition);
    await capture(definition);
    assert.equal((await notifications()).length, definitions.indexOf(definition), "unreviewed public fallback is not ready for notification");
    await saveReview(definition);
    await capture(definition);
    await capture(definition);
    const notification = (await notifications()).find(row => row.platform === definition.publicV2!.platform)!;
    assert.equal(notification.action, "created"); assert.equal(notification.revision, 1);
    const snapshot = await inMonitor(definition, async () => projectPublicV2(await loadPublicV2Input(sql), definition));
    const { bonusCredit: _bonus, ...publicEvent } = snapshot.events[0]!;
    assert.deepEqual(notification.event, publicEvent);
    assert.equal(Object.keys(notification.event!.title).length, 7);
  }
  assert.equal((await notifications()).length, 3);
  for (const { subscription } of subscriptions) {
    const deliveries = (await listWebhookDeliveries(subscription.id))!.deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.platform, subscription.platforms[0]);
  }
});

test("stale and failed enrichment waits, then changed content sends once; withdrawal and restoration keep monotonic revisions", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent();
  await saveReview(); await capture();
  await sql`UPDATE monitor_posts SET text='Synthetic: revised source statement.' WHERE monitor_id='codex'`;
  await capture();
  assert.equal((await notifications()).length, 1, "stale evidence cannot notify an unreviewed fallback");
  await saveReview(codex, { summary: properName("Synthetic corrected summary.") }); await capture(); await capture();
  await withdraw(true);
  await capture(); await capture();
  assert.equal((await notifications()).at(-1)!.event, null);
  await withdraw(false);
  await capture();
  assert.equal((await notifications()).length, 3, "restoration waits for current evidence review");
  await saveReview(); await capture();
  const rows = await notifications();
  assert.deepEqual(rows.map(row => row.action), ["created", "updated", "withdrawn", "restored"]);
  assert.deepEqual(rows.map(row => row.revision), [1, 2, 3, 4]);
  assert.equal(new Set(rows.map(row => row.id)).size, 4);
});

test("title, summary, time, scope, status and accepted business updates each trigger a public revision", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent(); await saveReview(); await capture();
  let patch: Partial<ReviewedEvent> = {};
  for (const change of [
    { title: properName("Synthetic corrected title") }, { summary: properName("Synthetic corrected explanation.") },
    { time: "2026-10-01T13:00:00Z" },
    { scope: { type: "paid_users" as const, productCodes: [], planCodes: [], quotaWindowCodes: [], note: null } },
  ]) {
    const count = (await notifications()).length;
    patch = { ...patch, ...change }; await saveReview(codex, patch); await capture(); await capture();
    assert.equal((await notifications()).length, count + 1);
    assert.equal((await notifications()).at(-1)!.action, "updated");
  }
  await sql`UPDATE monitor_events SET status='announced',confirmation_basis=NULL WHERE monitor_id='codex' AND id=${eventId}`;
  patch.status = "announced"; await saveReview(codex, patch); await capture();
  assert.equal((await notifications()).at(-1)!.event!.status, "announced");
  await sql`INSERT INTO monitor_posts(monitor_id,id,author,published_at,text,url) VALUES
    ('codex','business-update',${codex.authors[0]!.handle},'2026-10-01T14:00:00Z','Synthetic: reset rollout is in progress.','https://x.com/test/status/business-update')`;
  await sql`INSERT INTO monitor_event_posts(monitor_id,event_id,post_id,stage,action,text,original_text) VALUES
    ('codex',${eventId},'business-update','announced','progress','Synthetic progress.','Synthetic progress.')`;
  patch.evidence = [{ postId: "source-post", excerpt: "Synthetic: we reset usage at 12:00 UTC." },
    { postId: "business-update", excerpt: "Synthetic: reset rollout is in progress." }];
  patch.updateSummaries = [{ postId: "source-post", summary: properName("Synthetic reset completed.") },
    { postId: "business-update", summary: properName("Synthetic progress.") }];
  await saveReview(codex, patch); await capture(); await capture();
  const rows = await notifications();
  assert.deepEqual(rows.map(row => row.revision), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(rows.at(-1)!.event!.updates[0]!.id, "business-update");
  assert.equal(rows.at(-1)!.event!.updates[0]!.summary!.zh, "Synthetic progress.");
});

test("business changes and notification records roll back together, without consuming a revision", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent();
  await assert.rejects(sql.begin(async db => {
    await saveReview(codex, {}, db);
    await inMonitor(codex, () => captureWebhookEvent(db, eventId));
    throw new Error("Synthetic rollback");
  }), /Synthetic rollback/);
  assert.equal((await notifications()).length, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM monitor_webhook_deliveries`)[0]!.n, 0);
  assert.equal((await sql`SELECT presentation FROM monitor_events WHERE monitor_id='codex'`)[0]!.presentation, null);
  await saveReview(); await capture();
  assert.equal((await notifications())[0]!.revision, 1);
});

test("concurrent pending cleanup and enqueue both commit and preserve the newly requested work", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent(); await saveReview();
  await inMonitor(codex, () => sql.begin(db => enqueuePublicV2(db, [eventId])));
  await saveReview(codex, { summary: properName("Synthetic change during pending cleanup.") });
  const acquired = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const cleaningStarted = Promise.withResolvers<number>();
  const holding = sql.begin(async db => {
    await db`SELECT 1 FROM monitor_state WHERE monitor_id='codex' AND key=${`webhook:event:${eventId}`} FOR UPDATE`;
    acquired.resolve((await db<{pid:number}[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    await release.promise;
  });
  async function blockedBy(pid: number, operation: Promise<unknown>) {
    const deadline = performance.now() + 5_000;
    while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`).length) {
      assert.ok(performance.now() < deadline, "operation reaches the held database lock");
      await Promise.race([operation.then(() => assert.fail("operation finished before its blocker committed")), delay(10)]);
    }
  }
  let cleaning: Promise<unknown> | undefined, enqueuing: Promise<unknown> | undefined;
  try {
    const holder = await acquired.promise;
    cleaning = sql.begin(async db => {
      await db`SET LOCAL lock_timeout='5s'`;
      cleaningStarted.resolve((await db<{pid:number}[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
      await inMonitor(codex, () => clearPublicV2Work(db, eventId));
    });
    const cleaner = await cleaningStarted.promise;
    await blockedBy(holder, cleaning);
    enqueuing = sql.begin(async db => {
      await db`SET LOCAL lock_timeout='5s'`;
      await inMonitor(codex, () => enqueuePublicV2(db, [eventId]));
    });
    await blockedBy(cleaner, enqueuing);
    release.resolve();
    await holding;
    await Promise.all([cleaning, enqueuing]);
    const pending = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${`public_v2:pending:${eventId}`}`;
    assert.equal(pending[0]?.value.status, "pending", "enqueue after cleanup keeps the new work");
    assert.deepEqual((await notifications()).map(row => row.action), ["created", "updated"]);
  } finally {
    release.resolve();
    await Promise.allSettled([holding, cleaning, enqueuing]);
  }
});

test("applying an administrator v2 review publishes its notification through the real review transaction", async () => {
  await initializeWebhookBaselines(definitions); await subscriber(); await addEvent();
  const review = await saveReview();
  await sql`UPDATE monitor_events SET presentation=NULL WHERE monitor_id='codex' AND id=${eventId}`;
  const bundle = await exportPublicV2([codex]);
  bundle.monitors[0]!.reviews[0]!.publicV2 = review;
  await applyPublicV2(bundle, [codex], "Publish reviewed synthetic event", "test-reviewer");
  const rows = await notifications();
  assert.equal(rows.length, 1); assert.equal(rows[0]!.action, "created");
  assert.deepEqual(rows[0]!.event!.title, review.title);
  const [stored] = await sql`SELECT presentation->'publicV2' AS review FROM monitor_events WHERE monitor_id='codex' AND id=${eventId}`;
  assert.deepEqual(stored!.review.title, rows[0]!.event!.title);
  const stale = await exportPublicV2([codex]);
  stale.monitors[0]!.reviews[0]!.expectedVersion = "stale-review-version";
  stale.monitors[0]!.reviews[0]!.publicV2!.title = properName("Must not publish a stale review");
  await assert.rejects(applyPublicV2(stale, [codex], "Reject stale review", "test-reviewer"), /Event changed/);
  assert.equal((await notifications()).length, 1);
});

test("automatic pending v2 enrichment saves a complete review and creates its notification without direct capture", async () => {
  await initializeWebhookBaselines(definitions); const { subscription } = await subscriber(); await addEvent();
  await inMonitor(codex, () => sql.begin(db => enqueuePublicV2(db, [eventId])));
  assert.equal((await notifications()).length, 0);
  let requests = 0;
  const model = await stub((_hit, request) => {
    requests += 1;
    const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content);
    assert.equal(input.event.id, eventId);
    const content = { title: properName("Synthetic automatically reviewed reset"), summary: properName("Usage has been restored."),
      scope: { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null }, bonusCredit: null,
      evidence: input.posts.map((post: {id:string;text:string}) => ({ postId: post.id, excerpt: post.text })),
      updateSummaries: input.links.map((link: {post_id:string}) => ({ postId: link.post_id, summary: properName("Usage restored.") })), timeEvidence: null };
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  });
  const env = { MONITOR_MODEL: "default", LLM_BASE_URL: `${model.url}/v1`, LLM_API_KEY: "synthetic-local-key",
    LLM_MODEL: "synthetic-webhook-v2", COLLECT_ENABLED: "true" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const oldPrivate = config.allowPrivateNetworkFetch, oldModelCalls = config.modelCallsEnabled;
  try {
    Object.assign(process.env, env); config.allowPrivateNetworkFetch = true; config.modelCallsEnabled = true;
    installModules(definitions.map(createMonitorServer));
    assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 1 });
    assert.equal(requests, 1);
    const rows = await notifications();
    assert.equal(rows.length, 1); assert.equal(rows[0]!.action, "created");
    assert.equal(rows[0]!.event!.title.zh, "Synthetic automatically reviewed reset");
    assert.equal((await listWebhookDeliveries(subscription.id))!.deliveries.length, 1);
    assert.equal((await sql`SELECT 1 FROM monitor_state WHERE monitor_id='codex' AND key=${`public_v2:pending:${eventId}`}`).length, 0);
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE purpose='monitor.public_v2' AND status='completed'`)[0]!.n, 1);
    assert.deepEqual(await inMonitor(codex, () => processPublicV2Pending()), { enriched: 0 });
    assert.equal(requests, 1); assert.equal((await notifications()).length, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    config.allowPrivateNetworkFetch = oldPrivate; config.modelCallsEnabled = oldModelCalls;
    installModules([]); await model.close();
  }
});

test("initial history creates a comparison baseline without backfill; enabling subscriptions only sees subsequent changes", async () => {
  await addEvent(); await saveReview();
  await initializeWebhookBaselines(definitions);
  const { subscription } = await subscriber(["codex"], false);
  await capture(); assert.equal((await notifications()).length, 0);
  await updateSubscription(subscription.id, { enabled: true, reason: "Start receiving new changes" }, "test-admin", definitions);
  assert.equal((await listWebhookDeliveries(subscription.id))!.deliveries.length, 0);
  await saveReview(codex, { summary: properName("Synthetic first change after subscribing.") }); await capture();
  assert.equal((await notifications())[0]!.action, "updated");
  assert.equal((await listWebhookDeliveries(subscription.id))!.deliveries.length, 1);
});

test("unready historical events are not backfilled when their first review later succeeds", async () => {
  await addEvent(); await initializeWebhookBaselines(definitions); await subscriber();
  await saveReview(); await capture();
  assert.equal((await notifications()).length, 0);
  await saveReview(codex, { summary: properName("Synthetic later public correction.") }); await capture();
  assert.deepEqual((await notifications()).map(row => row.action), ["updated"]);
});

test("withdrawing a new unready event keeps its first reviewed restoration eligible for notification", async () => {
  await initializeWebhookBaselines(definitions); const { subscription } = await subscriber(); await addEvent();
  await withdraw(true);
  assert.equal((await notifications()).length, 0, "an event never notified has no withdrawal callback");
  await withdraw(false);
  assert.equal((await notifications()).length, 0, "restoration still waits for the first valid review");
  await saveReview(); await capture(); await capture();
  const rows = await notifications();
  assert.deepEqual(rows.map(row => row.action), ["created"]);
  assert.equal(rows[0]!.revision, 1);
  assert.equal((await listWebhookDeliveries(subscription.id))!.deliveries.length, 1);
});

test("restoring a previously public historical event sends a restoration without backfilling its quiet withdrawal", async () => {
  await addEvent(); await saveReview(); await initializeWebhookBaselines(definitions); await subscriber();
  await withdraw(true);
  assert.equal((await notifications()).length, 0);
  await withdraw(false); await saveReview(); await capture(); await capture();
  const rows = await notifications();
  assert.deepEqual(rows.map(row => row.action), ["restored"]);
  assert.equal(rows[0]!.revision, 1);
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
