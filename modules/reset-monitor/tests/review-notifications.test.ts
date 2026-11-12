import { gate } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { beijingDate } from "@aihot/contracts/time";
import { closeDb, sql, type Db } from "@aihot/backend/db";
import { JobRunError, recordRun } from "@aihot/backend/jobs/queue";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { markPostFailure, markPostReview, saveAcceptedPost, sourcePost, StalePostWork } from "../backend/action-store.ts";
import { updateMonitorPost } from "../backend/admin.ts";
import { monitorPostDetail, previewMonitorReview, submitMonitorReview } from "../backend/manual-review.ts";
import { properName } from "../backend/public-v2.ts";
import { captureReviewNotification, reconcileReviewNotificationSettings, reviewNotificationIssues, sendReviewNotifications } from "../backend/review-notifications.ts";
import { serverChan, type ReviewMessage, type ServerChanIssue, type ServerChanResult } from "../backend/serverchan.ts";

const definitions = [codex, claude, grok];
const settingsKey = "reset.review-notifications";
const prefix = "review-notification:episode:";
const postPrefix = (id: string) => `${prefix}${encodeURIComponent(id)}:`;
const publishedAt = "2026-10-20T08:00:00.000Z";
const privateText = "Private original text: never include this in a notification";
type Notification = { episode: string; postId: string; status: string; enteredAt: string; epoch: string; attemptedAt?: string; error?: ServerChanIssue };
type Hook = "review" | "failure" | "accepted";
let now: number;
let messages: ReviewMessage[];

beforeEach(async () => {
  mock.restoreAll();
  process.env.SERVERCHAN_ENABLED = "false";
  delete process.env.SERVERCHAN_SENDKEY;
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM settings WHERE key=${settingsKey}`;
  await sql`DELETE FROM audit_log`;
  now = Date.now();
  messages = [];
  mock.method(serverChan, "enabled", () => true);
  mock.method(serverChan, "send", async (message: ReviewMessage): Promise<ServerChanResult> => {
    messages.push(message);
    return { status: "sent" };
  });
});
afterEach(() => {
  mock.restoreAll();
  assert.equal(process.env.SERVERCHAN_ENABLED, "false");
  delete process.env.SERVERCHAN_SENDKEY;
});
after(closeDb);

async function seed(id: string, definition = codex) {
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,text,processing_status)
    VALUES(${definition.monitorId},${id},${definition.authors[0]!.handle},${publishedAt},${`https://example.test/${definition.monitorId}/${id}`},
      ${sql.json(properName(`Title ${id}`))},${privateText},'pending')`;
  return inMonitor(definition, async () => (await sourcePost(id))!);
}
async function notification(id: string, definition = codex, db: Db = sql) {
  const [row] = await db<{ value: Notification }[]>`SELECT value FROM monitor_state WHERE monitor_id=${definition.monitorId} AND starts_with(key,${postPrefix(id)})
    ORDER BY value->>'enteredAt' DESC,key DESC LIMIT 1`;
  return row?.value;
}
async function notifications() {
  return sql<{ monitor_id: string; key: string; value: Notification }[]>`SELECT monitor_id,key,value FROM monitor_state WHERE starts_with(key,${prefix}) ORDER BY monitor_id,key`;
}
async function budget() {
  const [row] = await sql<{ value: { day: string; attempts: number; enabledAt: string | null; epoch: string | null } }[]>`SELECT value FROM settings WHERE key=${settingsKey}`;
  return row?.value;
}
async function initialize() {
  // Eligibility uses the database's actual transition time, so initialize against the real clock.
  assert.deepEqual(await reconcileReviewNotificationSettings(), { enabled: true, cancelled: 0 });
  assert.ok((await budget())!.enabledAt);
}
async function enteredAt(id: string, at = now, definition = codex) {
  const { episode } = (await notification(id, definition))!;
  await sql`UPDATE monitor_state SET value=jsonb_set(value,'{enteredAt}',${sql.json(new Date(at).toISOString())})
    WHERE monitor_id=${definition.monitorId} AND key=${postPrefix(id) + episode}`;
}
async function transition(hook: Hook, id: string, version: string, db?: Db) {
  if (hook === "review") return markPostReview(id, "需要人工核对", version, undefined, db);
  if (hook === "failure") return markPostFailure(id, version, undefined, db);
  return saveAcceptedPost(id, {
    title: properName("Quota restored"), summary: properName("Official quota update"), receiptId: null,
    actions: [{ eventId: `event-${id}`, action: "confirm", title: properName("Confirmed"), summary: null, time: { kind: "instant" as const, at: "2026-10-01T12:00:00.000Z" } }],
    events: [{ id: `event-${id}`, type: "direct_reset" }], expectedVersion: version, reviewReason: "已保存有效动作，范围仍需核对",
  }, db);
}
async function enter(id: string, definition = codex, hook: Hook = "review", at = now) {
  const post = await seed(id, definition);
  await inMonitor(definition, () => transition(hook, id, post.version));
  const captured = await notification(id, definition);
  assert.equal(captured?.status, "pending");
  await enteredAt(id, at, definition);
  return captured!;
}
const sweep = (at = now) => sendReviewNotifications(definitions, () => at);
async function waitForDispatchCommit(id: string) {
  await sql.begin(async db => {
    await db`SET LOCAL lock_timeout='5s'`;
    await db`SELECT 1 FROM monitor_source_posts WHERE monitor_id='codex' AND id=${id} FOR UPDATE`;
  });
}
async function prepareCompletion(id: string) {
  const detail = (await monitorPostDetail(id))!;
  const command = { version: detail.version, versions: detail.versions, reason: "Administrator completed the review", completeProcessing: true };
  const preview = (await previewMonitorReview(id, command))!;
  return () => submitMonitorReview(id, { ...command, previewToken: preview.previewToken }, "test-reviewer");
}
function pauseBeforeTransaction(number: number) {
  const waiting = gate(), resume = gate();
  const begin = sql.begin.bind(sql);
  let transactions = 0;
  const intercept = mock.method(sql, "begin", async (run: (db: Db) => Promise<unknown>) => {
    if (++transactions === number) {
      waiting.open();
      await resume.promise;
    }
    return begin(run);
  });
  return { waiting: waiting.promise, resume: () => { intercept.mock.restore(); resume.open(); } };
}

test("first enable ignores old abnormal posts, including transitions made while the valve was disabled", async () => {
  const oldReview = await seed("old-review"), oldFailure = await seed("old-failure", claude);
  await inMonitor(codex, () => markPostReview(oldReview.id, "Old review", oldReview.version));
  mock.method(serverChan, "enabled", () => false);
  await inMonitor(claude, () => markPostFailure(oldFailure.id, oldFailure.version));
  assert.equal((await notifications()).length, 0);
  mock.method(serverChan, "enabled", () => true);
  await initialize();
  assert.equal((await sweep()).sent, 0);
  await enter("new", grok);
  assert.equal((await sweep()).sent, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0].title, /Grok/);
  assert.equal(await notification("old-review"), undefined);
  assert.equal(await notification("old-failure", claude), undefined);
});

test("capturing an old abnormal row after initialization cannot manufacture new eligibility", async () => inMonitor(codex, async () => {
  await seed("historical");
  await sql`UPDATE monitor_source_posts SET processing_status='needs_attention',review_reason='Old anomaly',updated_at=${publishedAt}
    WHERE monitor_id='codex' AND id='historical'`;
  await initialize();
  await sql.begin(db => captureReviewNotification(db, "historical"));
  assert.equal(await notification("historical"), undefined);
  await sweep(); assert.equal(messages.length, 0);
}));

test("startup gives settings without an epoch a new boundary while preserving today's spent attempts", async () => {
  await sql`INSERT INTO settings(key,value,updated_by) VALUES(${settingsKey},${sql.json({ enabledAt: publishedAt, day: beijingDate(now), attempts: 3 })},'test')`;
  const post = await seed("old-epoch");
  const legacyKey = `review-notification:${post.id}`;
  const legacy = { postId: post.id, status: "pending", enabledAt: publishedAt, enteredAt: new Date(now).toISOString() };
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex',${legacyKey},${sql.json(legacy)})`;
  await inMonitor(codex, () => markPostReview(post.id, "Old anomaly", post.version));
  await initialize();
  assert.ok((await budget())!.epoch);
  assert.equal((await budget())!.attempts, 3);
  assert.equal(await notification(post.id), undefined);
  await enter("new-epoch");
  assert.equal((await sweep()).sent, 1);
  assert.equal((await budget())!.attempts, 4);
  const [old] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key=${legacyKey}`;
  assert.deepEqual(old!.value, legacy);
});

for (const hook of ["review", "failure", "accepted"] as const) test(`${hook}: historical recognition writes the post but never registers a notification`, async () => inMonitor(codex, async () => {
  await initialize();
  const post = await seed(`historical-${hook}`);
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex',${`recognition:historical:${post.id}`},'{"suppressNotifications":true}'::jsonb)`;
  await transition(hook, post.id, post.version);
  assert.equal((await sourcePost(post.id))!.processing_status, hook === "failure" ? "failed" : "needs_attention");
  assert.equal(await notification(post.id), undefined);
  assert.equal((await sweep()).sent, 0);
}));

test("three platforms share five attempts; the sixth episode is permanently skipped and never caught up tomorrow", async () => {
  await initialize();
  const posts = Array.from({ length: 6 }, (_, index) => ({ id: `quota-${index}`, definition: definitions[index % 3] }));
  for (const [index, post] of posts.entries()) await enter(post.id, post.definition, "review", now + index);
  const result = await sweep();
  assert.equal(result.sent, 5); assert.equal(result.skippedQuota, 1);
  assert.equal(messages.length, 5); assert.equal((await budget())!.attempts, 5);
  assert.deepEqual(new Set(messages.map(message => message.title.match(/\[([^\]]+)\]/)![1])), new Set(definitions.map(definition => definition.product)));
  assert.equal((await notification(posts[5].id, posts[5].definition))!.status, "skipped_quota");
  assert.equal(messages.some(message => message.description.includes("quota-5")), false);
  assert.equal((await sweep(now + 86_400_000)).sent, 0);
  assert.equal(messages.length, 5);
  await enter("tomorrow", codex, "review", now + 86_400_000);
  assert.equal((await sweep(now + 86_400_000)).sent, 1);
  assert.equal((await budget())!.attempts, 1);
  assert.equal((await notification("quota-5", grok))!.status, "skipped_quota");
});

for (const hook of ["review", "failure", "accepted"] as const) {
  test(`${hook}: abnormal status and notification are visible in one transaction and commit together`, async () => inMonitor(codex, async () => {
    await initialize();
    const post = await seed(`atomic-${hook}`);
    await sql.begin(async db => {
      await transition(hook, post.id, post.version, db);
      assert.equal((await sourcePost(post.id, db))!.processing_status, hook === "failure" ? "failed" : "needs_attention");
      assert.equal((await notification(post.id, codex, db))!.status, "pending");
      // A separate connection must not see either uncommitted change.
      assert.equal((await sourcePost(post.id))!.processing_status, "pending");
      assert.equal(await notification(post.id), undefined);
    });
    await enteredAt(post.id);
    assert.equal((await sweep()).sent, 1);
    assert.equal((await notification(post.id))!.status, "sent");
    if (hook === "accepted") {
      const actions = await sql<{ sources: { postId: string }[] }[]>`SELECT sources FROM monitor_event_actions WHERE monitor_id='codex' AND event_id=${`event-${post.id}`}`;
      assert.deepEqual(actions[0].sources, [{ postId: post.id }]);
    }
  }));

  test(`${hook}: rolling back also removes notification eligibility and accepted actions`, async () => inMonitor(codex, async () => {
    await initialize();
    const post = await seed(`rollback-${hook}`);
    await assert.rejects(sql.begin(async db => {
      await transition(hook, post.id, post.version, db);
      assert.equal((await notification(post.id, codex, db))!.status, "pending");
      throw new Error("rollback-notification-fixture");
    }), /rollback-notification-fixture/);
    assert.equal((await sourcePost(post.id))!.processing_status, "pending");
    assert.equal(await notification(post.id), undefined);
    assert.equal((await sql`SELECT id FROM monitor_event_actions`).length, 0);
    assert.equal((await sql`SELECT id FROM monitor_event_records`).length, 0);
    assert.equal((await sweep()).sent, 0); assert.equal(messages.length, 0);
  }));

  test(`${hook}: an obsolete version cannot overwrite editorial changes or create a notification`, async () => inMonitor(codex, async () => {
    await initialize();
    const post = await seed(`stale-${hook}`);
    await sql`UPDATE monitor_source_posts SET title='{"zh":"管理员的新标题"}'::jsonb,updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${post.id}`;
    const before = await sourcePost(post.id);
    if (hook === "accepted") await assert.rejects(transition(hook, post.id, post.version), StalePostWork);
    else assert.equal(await transition(hook, post.id, post.version), false);
    assert.deepEqual(await sourcePost(post.id), before);
    assert.equal(await notification(post.id), undefined);
    assert.equal((await sql`SELECT id FROM monitor_event_actions`).length, 0);
    assert.equal((await sweep()).sent, 0);
  }));
}

for (const status of ["failed", "unknown"] as const) test(`${status} deliveries consume the shared quota and are terminal on repeated scans`, async () => {
  await initialize();
  mock.method(serverChan, "send", async (message: ReviewMessage): Promise<ServerChanResult> => {
    messages.push(message); return { status, error: status === "failed" ? { code: "http", status: 503 } : { code: "transport" } };
  });
  for (let index = 0; index < 6; index++) await enter(`failure-${index}`, definitions[index % 3], "failure", now + index);
  const result = await sweep();
  assert.equal(result[status], 5); assert.equal(result.skippedQuota, 1);
  assert.equal((await budget())!.attempts, 5);
  for (let index = 0; index < 5; index++) {
    const value = (await notification(`failure-${index}`, definitions[index % 3]))!;
    assert.equal(value.status, status); assert.ok(value.attemptedAt); assert.equal(value.error?.code, status === "failed" ? "http" : "transport");
  }
  assert.equal(result.errors.length, 5);
  assert.equal((await reviewNotificationIssues()).length, 5);
  await sweep(); await sweep(now + 86_400_000);
  assert.equal(messages.length, 5);
});

test("a claimed but unfinished send remains terminal when another worker scans after restart", async () => {
  await initialize(); await enter("interrupted");
  await sql`UPDATE monitor_state SET value=value || '{"status":"unknown","attemptedAt":"2026-10-20T08:00:00Z"}'::jsonb
    WHERE monitor_id='codex' AND starts_with(key,${postPrefix("interrupted")})`;
  await sql`UPDATE settings SET value=jsonb_set(value,'{attempts}','1'::jsonb) WHERE key=${settingsKey}`;
  await sweep(); await sweep();
  assert.equal(messages.length, 0); assert.equal((await budget())!.attempts, 1);
  assert.equal((await notification("interrupted"))!.status, "unknown");
});

test("concurrent sweeps claim each episode once and never exceed five sends across all platforms", async () => {
  await initialize();
  for (let index = 0; index < 12; index++) await enter(`concurrent-${index}`, definitions[index % 3], "review", now + index);
  const results = await Promise.all(Array.from({ length: 4 }, () => sweep()));
  assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 5);
  assert.equal(messages.length, 5);
  assert.equal(new Set(messages.map(message => message.description)).size, 5);
  assert.equal((await budget())!.attempts, 5);
  const last = await sweep();
  assert.equal(results.reduce((sum, result) => sum + result.skippedQuota, last.skippedQuota), 7);
  const rows = await notifications();
  assert.equal(rows.filter(row => row.value.status === "sent").length, 5);
  assert.equal(rows.filter(row => row.value.status === "skipped_quota").length, 7);
  await sweep(); assert.equal(messages.length, 5);
});

test("repeated processing and changed reasons do not repeat a send; leaving abnormal status permits a new episode", async () => inMonitor(codex, async () => {
  await initialize();
  const first = await enter("episodes");
  assert.equal((await sweep()).sent, 1);
  const abnormal = (await sourcePost("episodes"))!;
  assert.equal(await markPostReview("episodes", "Different reason", abnormal.version), false);
  assert.equal(await markPostFailure("episodes", abnormal.version), false);
  await sql`UPDATE monitor_source_posts SET review_reason='Edited reason',updated_at=clock_timestamp() WHERE monitor_id='codex' AND id='episodes'`;
  await sweep(); assert.equal(messages.length, 1);
  assert.equal((await notification("episodes"))!.episode, first.episode);
  await sql`UPDATE monitor_source_posts SET processing_status='processed',review_reason=NULL,updated_at=clock_timestamp() WHERE monitor_id='codex' AND id='episodes'`;
  await sweep();
  await sql`UPDATE monitor_source_posts SET processing_status='pending',updated_at=clock_timestamp() WHERE monitor_id='codex' AND id='episodes'`;
  await markPostFailure("episodes", (await sourcePost("episodes"))!.version);
  const second = (await notification("episodes"))!;
  assert.notEqual(second.episode, first.episode); assert.equal(second.status, "pending");
  await enteredAt("episodes", now + 1);
  assert.equal((await sweep()).sent, 1); assert.equal(messages.length, 2);
  assert.match(messages[1].title, /帖子识别失败/);
}));

test("editorial edits and saved translations preserve the existing episode before and after delivery", async () => inMonitor(codex, async () => {
  await initialize(); const captured = await enter("editorial");
  const post = (await sourcePost("editorial"))!;
  await updateMonitorPost(post.id, { version: post.version, patch: { title: { zh: "人工修改标题" }, summary: { zh: "人工修改摘要" } } }, "test-reviewer");
  assert.equal((await notification(post.id))!.episode, captured.episode);
  assert.equal((await sweep()).sent, 1); assert.match(messages[0].description, /人工修改标题/);
  const delivered = await notification(post.id);
  // Simulate persisted translation output only; no model call is needed to test notification isolation.
  await sql`UPDATE monitor_source_posts SET title=title || '{"en":"Translated title","ja":"翻訳済み"}'::jsonb,
    summary=summary || '{"en":"Translated summary"}'::jsonb,updated_at=clock_timestamp() WHERE monitor_id='codex' AND id=${post.id}`;
  assert.deepEqual(await notification(post.id), delivered);
  await sweep(); await sweep(); assert.equal(messages.length, 1);
}));

test("a recovered post cancels pending delivery without spending quota", async () => {
  await initialize(); await enter("recovered");
  await sql`UPDATE monitor_source_posts SET processing_status='processed',review_reason=NULL,updated_at=clock_timestamp() WHERE monitor_id='codex' AND id='recovered'`;
  const result = await sweep();
  assert.equal(result.cancelled, 1); assert.equal(result.sent, 0);
  assert.equal((await notification("recovered"))!.status, "cancelled");
  assert.equal((await budget())!.attempts, 0); assert.equal(messages.length, 0);
});

test("previous Beijing-day pending episodes expire at midnight without catch-up or quota usage", async () => {
  await initialize();
  const midnight = Date.parse(`${beijingDate(now)}T23:59:59+08:00`) + 1_000;
  await enter("yesterday", codex, "review", midnight - 1);
  await enter("today", claude, "failure", midnight);
  const result = await sweep(midnight);
  assert.equal(result.skippedExpired, 1); assert.equal(result.sent, 1);
  assert.equal((await notification("yesterday"))!.status, "skipped_expired");
  assert.equal((await notification("today", claude))!.status, "sent");
  assert.equal((await budget())!.day, beijingDate(midnight)); assert.equal((await budget())!.attempts, 1);
  await sweep(midnight + 86_400_000); assert.equal(messages.length, 1);
});

test("crossing Beijing midnight after a claim prevents that old-day request from being sent", async () => {
  await initialize();
  const beforeMidnight = Date.parse(`${beijingDate(now)}T23:59:59+08:00`);
  await enter("midnight-claim", codex, "review", beforeMidnight);
  let calls = 0;
  const result = await sendReviewNotifications(definitions, () => ++calls <= 3 ? beforeMidnight : beforeMidnight + 1_000);
  assert.equal(result.skippedExpired, 1); assert.equal(messages.length, 0);
  assert.equal((await notification("midnight-claim"))!.status, "skipped_expired");
  assert.equal((await budget())!.attempts, 0);
  await sweep(beforeMidnight + 1_000); assert.equal(messages.length, 0);
});

test("disabling cancels old eligibility, ignores disabled-period anomalies and resumes only with fresh transitions", async () => {
  await initialize(); await enter("before-disable");
  mock.method(serverChan, "enabled", () => false);
  const disabled = await sweep();
  assert.equal(disabled.disabled, true); assert.equal(disabled.cancelled, 1);
  assert.equal((await budget())!.enabledAt, null);
  const during = await seed("during-disable", claude);
  await inMonitor(claude, () => markPostReview(during.id, "Disabled-period review", during.version));
  assert.equal(await notification(during.id, claude), undefined);
  mock.method(serverChan, "enabled", () => true);
  await sweep(); assert.equal(messages.length, 0);
  await enter("after-enable", grok);
  assert.equal((await sweep()).sent, 1); assert.equal(messages.length, 1);
});

for (const hook of ["review", "failure"] as const) test(`${hook}: a disabled-period transition invalidates old eligibility even without a disabled sweep`, async () => inMonitor(codex, async () => {
  await initialize();
  const old = await enter(`disabled-transition-${hook}`);
  mock.method(serverChan, "enabled", () => false);
  await sql`UPDATE monitor_source_posts SET processing_status='processed',review_reason=NULL,updated_at=clock_timestamp()
    WHERE monitor_id='codex' AND id=${old.postId}`;
  await sql`UPDATE monitor_source_posts SET processing_status='pending',updated_at=clock_timestamp()
    WHERE monitor_id='codex' AND id=${old.postId}`;
  assert.equal(await transition(hook, old.postId, (await sourcePost(old.postId))!.version), true);
  const cancelled = (await notification(old.postId))!;
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.episode, old.episode);
  assert.equal((await budget())!.enabledAt, null, "the post transition persists disablement without a sweep");
  mock.method(serverChan, "enabled", () => true);
  const result = await sweep();
  assert.equal(result.sent, 0); assert.equal(messages.length, 0); assert.equal((await budget())!.attempts, 0);
  assert.deepEqual(await notification(old.postId), cancelled);
}));

for (const oldStatus of ["sent", "failed", "unknown"] as const) test(`a late ${oldStatus} delivery cannot overwrite a newly captured episode`, async () => inMonitor(codex, async () => {
  await initialize(); const first = await enter(`late-${oldStatus}`);
  const started = gate(), release = gate();
  mock.method(serverChan, "send", async (message: ReviewMessage): Promise<ServerChanResult> => {
    messages.push(message);
    if (messages.length === 1) {
      started.open(); await release.promise;
      return oldStatus === "sent" ? { status: "sent" } : { status: oldStatus, error: { code: "transport" } };
    }
    return { status: "sent" };
  });
  const sending = sweep();
  let next!: Notification;
  try {
    await Promise.race([started.promise, sending.then(() => { throw new Error("sweep finished before reaching the provider"); })]);
    await waitForDispatchCommit(first.postId);
    const claimed = (await notification(first.postId))!;
    assert.equal(claimed.episode, first.episode); assert.equal(claimed.status, "unknown");
    assert.equal((await budget())!.attempts, 1);
    await sql.begin(async db => {
      // Waiting for the supplier must not retain the post lock or block this new round.
      await db`SET LOCAL lock_timeout='5s'`;
      await db`UPDATE monitor_source_posts SET processing_status='processed',review_reason=NULL,updated_at=clock_timestamp()
        WHERE monitor_id='codex' AND id=${first.postId}`;
      await db`UPDATE monitor_source_posts SET processing_status='pending',updated_at=clock_timestamp()
        WHERE monitor_id='codex' AND id=${first.postId}`;
      assert.equal(await markPostFailure(first.postId, (await sourcePost(first.postId, db))!.version, undefined, db), true);
    });
    await enteredAt(first.postId, now + 1);
    next = (await notification(first.postId))!;
    assert.notEqual(next.episode, first.episode); assert.equal(next.status, "pending");
    assert.equal(next.error, undefined); assert.equal(next.attemptedAt, undefined);
  } finally {
    release.open(); await sending;
  }
  assert.deepEqual(await notification(first.postId), next, "the old request must not replace the new pending episode or its fields");
  assert.equal((await notifications()).find(row => row.value.episode === first.episode)?.value.status, oldStatus);
  assert.equal((await sweep()).sent, 1);
  const delivered = (await notification(first.postId))!;
  assert.equal(delivered.episode, next.episode); assert.equal(delivered.status, "sent");
  assert.equal(messages.length, 2); assert.match(messages[1].title, /帖子识别失败/);
  assert.equal((await budget())!.attempts, 2);
}));

for (const status of ["pending", "unknown"] as const) test(`manual completion ${status === "pending" ? "cancels a pending round atomically" : "preserves an in-flight result"}`, async () => inMonitor(codex, async () => {
  await initialize(); const first = await enter(`manual-completion-${status}`);
  const started = gate(), release = gate();
  let sending: ReturnType<typeof sweep> | undefined;
  if (status === "unknown") {
    mock.method(serverChan, "send", async (message: ReviewMessage): Promise<ServerChanResult> => {
      messages.push(message); started.open(); await release.promise; return { status: "sent" };
    });
    sending = sweep();
  }
  try {
    if (sending) {
      await Promise.race([started.promise, sending.then(() => { throw new Error("sweep finished before reaching the provider"); })]);
      await waitForDispatchCommit(first.postId);
    }
    const originalPost = (await sourcePost(first.postId))!;
    const originalNotification = (await notification(first.postId))!;
    assert.equal(originalNotification.status, status);
    const detail = (await monitorPostDetail(first.postId))!;
    const command = { version: detail.version, versions: detail.versions, reason: "Administrator completed the review", completeProcessing: true };
    const preview = (await previewMonitorReview(first.postId, command))!;
    const body = { ...command, previewToken: preview.previewToken };
    // Execute the real submit callback and inspect its real transaction before commit, without replacing any queries.
    const begin = sql.begin.bind(sql), rollback = new Error("rollback-completed-review");
    let rollBack = true, transactions = 0;
    const wrapped = mock.method(sql, "begin", (run: (db: Db) => Promise<unknown>) => begin(async db => {
      await db`SET LOCAL lock_timeout='5s'`;
      const result = await run(db);
      transactions++;
      const post = (await sourcePost(first.postId, db))!, cancelled = (await notification(first.postId, codex, db))!;
      assert.equal(post.processing_status, "processed"); assert.equal(post.review_reason, null);
      assert.equal(cancelled.status, status === "pending" ? "cancelled" : "unknown"); assert.equal(cancelled.episode, originalNotification.episode);
      assert.deepEqual(await sourcePost(first.postId), originalPost);
      assert.deepEqual(await notification(first.postId), originalNotification);
      if (rollBack) throw rollback;
      return result;
    }));
    try {
      await assert.rejects(submitMonitorReview(first.postId, body, "test-reviewer"), error => error === rollback);
      assert.deepEqual(await sourcePost(first.postId), originalPost);
      assert.deepEqual(await notification(first.postId), originalNotification);
      rollBack = false;
      assert.deepEqual(await submitMonitorReview(first.postId, body, "test-reviewer"), { saved: true });
      assert.equal(transactions, 2);
    } finally {
      wrapped.mock.restore();
    }
    const cancelled = (await notification(first.postId))!;
    assert.equal(cancelled.status, status === "pending" ? "cancelled" : "unknown"); assert.equal(cancelled.episode, first.episode);
    assert.equal((await sourcePost(first.postId))!.processing_status, "processed");
    if (sending) { release.open(); await sending; }
    assert.equal((await notification(first.postId))!.status, status === "pending" ? "cancelled" : "sent");
    assert.equal((await sweep()).sent, 0);
    assert.equal(messages.length, status === "unknown" ? 1 : 0);
    assert.equal((await budget())!.attempts, status === "unknown" ? 1 : 0);
  } finally {
    release.open(); if (sending) await sending;
  }
}));

test("the real disabled valve never calls the provider with or without a configured credential", async () => {
  mock.restoreAll();
  const send = mock.method(serverChan, "send", async (): Promise<ServerChanResult> => { throw new Error("disabled provider must not be called"); });
  for (const key of [undefined, "SCTSyntheticNotificationTestKey"]) {
    if (key === undefined) delete process.env.SERVERCHAN_SENDKEY;
    else process.env.SERVERCHAN_SENDKEY = key;
    assert.equal(serverChan.enabled(), false);
    assert.equal((await sweep()).disabled, true);
  }
  assert.equal(send.mock.callCount(), 0); assert.equal((await budget())!.attempts, 0);
});

test("context-only posts cannot acquire notification eligibility", async () => inMonitor(codex, async () => {
  await initialize(); const post = await seed("context-only");
  await sql`UPDATE monitor_source_posts SET context_only=true WHERE monitor_id='codex' AND id=${post.id}`;
  await markPostReview(post.id, "Context only", (await sourcePost(post.id))!.version);
  assert.equal(await notification(post.id), undefined);
  await sweep(); assert.equal(messages.length, 0);
}));

test("notification contains concise source metadata and the exact admin filter, without original text", async () => {
  await initialize(); await enter("message", claude, "failure");
  await sql`UPDATE monitor_source_posts SET title=NULL,review_reason=${privateText} WHERE monitor_id=${claude.monitorId} AND id='message'`;
  await sweep(); const message = messages[0];
  assert.match(message.title, /帖子识别失败/); assert.match(message.description, /帖子：无标题帖子/);
  assert.ok(message.description.includes(`作者：@${claude.authors[0].handle}`));
  assert.match(message.description, /2026-10-20 16:00/);
  assert.ok(message.description.includes("https://example.test/"));
  assert.equal(message.description.includes(privateText), false);
  assert.match(message.description, /处理原因：识别未完成，请到后台查看处理说明/);
  const admin = message.description.match(/\[到后台处理\]\(([^)]+)\)/)![1];
  const url = new URL(admin);
  assert.equal(url.pathname, claude.adminPath);
  assert.equal(url.searchParams.get("kind"), "posts"); assert.equal(url.searchParams.get("q"), "message");
  assert.equal(url.searchParams.get("filter"), "failed"); assert.equal(url.searchParams.get("collectionFilter"), "all");
});

test("notification safely preserves an author's underscore without exposing original source text", async () => {
  await initialize(); await enter("underscore-author");
  await sql`UPDATE monitor_source_posts SET author='foo_bar' WHERE monitor_id='codex' AND id='underscore-author'`;
  assert.equal((await sweep()).sent, 1);
  assert.ok(messages[0].description.includes("作者：@foo\\_bar"));
  assert.equal(messages[0].description.includes(privateText), false);
});

for (const phase of ["reserved", "intent"] as const) test(`manual completion before fetch refunds ${phase} capacity without permanently skipping the next post`, async () => inMonitor(codex, async () => {
  await initialize();
  for (let index = 0; index < 4; index++) await enter(`spent-${index}`);
  assert.equal((await sweep()).sent, 4);
  const first = await enter("will-recover");
  await enter("next-eligible", claude, "review", now + 1);
  const complete = await prepareCompletion(first.postId);
  const pause = pauseBeforeTransaction(phase === "reserved" ? 3 : 4);
  const running = sweep(now + 10);
  try {
    await Promise.race([pause.waiting, running.then(() => { throw new Error("sweep did not reach the dispatch phase"); })]);
    assert.equal((await notification(first.postId))!.status, phase);
    const concurrent = await sweep(now + 10);
    assert.equal(concurrent.skippedQuota, 0);
    assert.equal(concurrent.sent, 0);
    assert.equal((await notification("next-eligible", claude))!.status, "pending");
    assert.deepEqual(await complete(), { saved: true });
  } finally { pause.resume(); await running; }
  assert.equal((await running).cancelled, 1);
  assert.equal((await running).sent, 1);
  assert.equal((await notification(first.postId))!.status, "cancelled");
  assert.equal((await notification("next-eligible", claude))!.status, "sent");
  assert.equal((await budget())!.attempts, 5);
  assert.equal(messages.some(message => message.description.includes(first.postId)), false);
}));

test("an explicit stop after a durable intent invalidates pending and reserved rounds and prevents its owner from sending", async () => {
  await initialize();
  const started = gate(), respond = gate();
  mock.method(serverChan, "send", async (message: ReviewMessage): Promise<ServerChanResult> => {
    messages.push(message); started.open(); await respond.promise; return { status: "sent" };
  });
  await enter("already-started");
  const first = sweep();
  let running: Promise<Awaited<ReturnType<typeof sweep>>> | undefined;
  let resume: (() => void) | undefined;
  try {
    await Promise.race([started.promise, first.then(() => { throw new Error("sweep did not reach the transport"); })]);
    await waitForDispatchCommit("already-started");
    await enter("intent-before-stop");
    await enter("reserved-before-stop", claude, "review", now + 1);
    await enter("pending-before-stop", grok, "review", now + 2);
    const activeReservation = { token: "fixture", day: beijingDate(now), until: new Date(Date.now() + 120_000).toISOString() };
    await sql`UPDATE monitor_state SET value=value || ${sql.json({ status: "reserved", reservation: activeReservation })}
      WHERE monitor_id='claude' AND starts_with(key,${postPrefix("reserved-before-stop")})`;
    const pause = pauseBeforeTransaction(4); resume = pause.resume;
    running = sweep(now + 10);
    await Promise.race([pause.waiting, running.then(() => { throw new Error("sweep did not commit an intent"); })]);
    assert.equal((await notification("intent-before-stop"))!.status, "intent");
    assert.deepEqual(await reconcileReviewNotificationSettings(false), { enabled: false, cancelled: 2 });
    assert.equal((await budget())!.epoch, null);
    assert.equal((await notification("pending-before-stop", grok))!.status, "cancelled");
    assert.equal((await notification("reserved-before-stop", claude))!.status, "cancelled");
    assert.equal((await notification("already-started"))!.status, "unknown");
  } finally { resume?.(); respond.open(); await Promise.all([first, running]); }
  assert.equal((await running)!.disabled, true);
  assert.equal((await notification("intent-before-stop"))!.status, "cancelled");
  assert.equal((await notification("already-started"))!.status, "sent");
  assert.equal((await budget())!.attempts, 1);
  assert.equal((await sweep()).sent, 0);
  assert.equal(messages.length, 1);
});

test("a sweep does not wait on a post lock while another writer needs the shared settings", async () => inMonitor(codex, async () => {
  await initialize();
  const round = await enter("locked");
  const pending = await seed("another-post-in-batch");
  await sql.begin(async db => {
    await db`SET LOCAL lock_timeout='5s'`;
    await db`SELECT 1 FROM monitor_source_posts WHERE monitor_id='codex' AND id=${round.postId} FOR UPDATE`;
    const running = sweep();
    try {
      assert.equal((await running).sent, 0);
      assert.equal(await markPostReview(pending.id, "Needs review", pending.version, undefined, db), true);
    } finally { await running; }
  });
  assert.equal((await sweep()).sent, 2);
}));

test("a crashed pre-intent reservation can be reclaimed on the same day but never consumes later days' capacity", async () => {
  await initialize();
  await enter("abandoned-reservation");
  const begin = sql.begin.bind(sql);
  let count = 0;
  const crash = mock.method(sql, "begin", (run: (db: Db) => Promise<unknown>) => {
    if (++count === 3) throw new Error("worker stopped before intent");
    return begin(run);
  });
  await assert.rejects(sweep(), JobRunError);
  crash.mock.restore();
  assert.equal((await notification("abandoned-reservation"))!.status, "reserved");
  assert.equal((await budget())!.attempts, 0);
  assert.equal((await sweep()).sent, 0);
  await sql`UPDATE monitor_state SET value=jsonb_set(value,'{reservation,until}',${sql.json(publishedAt)})
    WHERE starts_with(key,${postPrefix("abandoned-reservation")})`;
  assert.equal((await sweep()).sent, 1);
  await enter("previous-day-reservation");
  await sql`UPDATE monitor_state SET value=value || ${sql.json({ status: "reserved", reservation: { token: "fixture", day: beijingDate(now), until: new Date(Date.now() + 120_000).toISOString() } })}
    WHERE starts_with(key,${postPrefix("previous-day-reservation")})`;
  const tomorrow = now + 86_400_000;
  for (let index = 0; index < 5; index++) await enter(`new-day-${index}`, grok, "review", tomorrow + index);
  const result = await sweep(tomorrow + 5);
  assert.equal(result.sent, 5);
  assert.equal(result.skippedExpired, 1);
  assert.equal((await budget())!.attempts, 5);
});

test("a disconnect after fetch can leave a durable intent; restart counts it and never retries it", async () => {
  await initialize();
  const first = await enter("intent-after-disconnect");
  const begin = sql.begin.bind(sql);
  let count = 0;
  const crash = mock.method(sql, "begin", (run: (db: Db) => Promise<unknown>) => {
    if (++count !== 4) return begin(run);
    return begin(async db => { await run(db); throw new Error("connection dropped before dispatch transaction committed"); });
  });
  await assert.rejects(sweep(), error => error instanceof JobRunError && (error.detail as { sent: number }).sent === 1);
  crash.mock.restore();
  assert.equal((await budget())!.attempts, 1);
  assert.equal((await notification(first.postId))!.status, "intent");
  assert.equal((await sweep()).sent, 0);
  await sql`UPDATE monitor_state SET value=jsonb_set(value,'{reservation,until}',${sql.json(publishedAt)})
    WHERE starts_with(key,${postPrefix(first.postId)})`;
  await initialize();
  assert.equal((await notification(first.postId))!.status, "unknown");
  assert.deepEqual(await reviewNotificationIssues(), [{ monitorId: "codex", postId: first.postId, status: "unknown", attemptedAt: new Date(now).toISOString(), error: { monitorId: "codex", code: "unconfirmed" } }]);
  for (let index = 0; index < 5; index++) await enter(`remaining-${index}`, claude, "review", now + index);
  const result = await sweep(now + 10);
  assert.equal(result.sent, 4);
  assert.equal(result.skippedQuota, 1);
  assert.equal(messages.filter(message => message.description.includes(first.postId)).length, 1);
});

test("failure to persist a provider result leaves safe progress in the failed job run", async () => {
  await initialize();
  const post = await enter("missing-result-row");
  const started = gate(), respond = gate();
  mock.method(serverChan, "send", async (): Promise<ServerChanResult> => {
    started.open(); await respond.promise; return { status: "failed", error: { code: "http", status: 503 } };
  });
  const running = recordRun("reset-review.notify", () => sweep());
  const expected = { sent: 0, failed: 1, unknown: 0, cancelled: 0, skippedQuota: 0, skippedExpired: 0, disabled: false, errors: [{ monitorId: "codex", code: "http", status: 503 }] };
  const failed = assert.rejects(running, error => {
    assert.ok(error instanceof JobRunError); assert.deepEqual(error.detail, expected); return true;
  });
  try {
    await Promise.race([started.promise, running.then(() => { throw new Error("sweep did not reach transport"); })]);
    await waitForDispatchCommit(post.postId);
    await sql`DELETE FROM monitor_state WHERE monitor_id='codex' AND key=${postPrefix(post.postId) + post.episode}`;
  } finally { respond.open(); await failed; }
  const [run] = await sql`SELECT status,detail,error FROM job_runs WHERE job='reset-review.notify' ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.status, "failed");
  assert.deepEqual(run!.detail, expected);
  assert.equal(run!.error, "Error: 人工核对通知任务未完成");
});
