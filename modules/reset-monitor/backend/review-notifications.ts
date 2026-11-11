import { randomUUID } from "node:crypto";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { config } from "@aihot/backend/config";
import { sql, type Db } from "@aihot/backend/db";
import { JobRunError } from "@aihot/backend/jobs/queue";
import { monitorId, type ResetMonitorBackendDefinition } from "./context.ts";
import { serverChan, type ReviewMessage, type ServerChanIssue, type ServerChanResult } from "./serverchan.ts";

const settingsKey = "reset.review-notifications";
const episodePrefix = "review-notification:episode:";
const dailyLimit = 5;
// A reservation or unfinalized intent spans only short database transactions.
const leaseMs = 30_000;
type NotificationSettings = { enabledAt: string | null; epoch: string | null; day: string; attempts: number };
type NotificationStatus = "pending" | "reserved" | "intent" | "cancelled" | "skipped_quota" | "skipped_expired" | "sent" | "failed" | "unknown";
type Reservation = { token: string; day: string; until: string };
type Notification = {
  episode: string; postId: string; enteredAt: string; epoch: string; status: NotificationStatus;
  reservation?: Reservation; attemptedAt?: string; error?: ServerChanIssue; cancelRequested?: true;
};
interface Candidate { monitor_id: string; key: string; value: Notification }
interface ReviewPost {
  id: string; author: string; published_at: Date; url: string; title: Record<string, string> | null;
  processing_status: string; context_only: boolean;
}
type ReviewNotificationError = { monitorId: string } & ServerChanIssue;
type Progress = "cancelled" | "skippedQuota" | "skippedExpired";
type PreDispatch = { progress: Progress } | { disabled: true; cancelled: number };
const abnormal = (status: string) => status === "needs_attention" || status === "failed";
const postPrefix = (postId: string) => `${episodePrefix}${encodeURIComponent(postId)}:`;

async function saveSettings(db: Db, value: NotificationSettings) {
  await db`UPDATE settings SET value=${db.json(value)},updated_at=now() WHERE key=${settingsKey}`;
}
async function lockedSettings(db: Db) {
  const [row] = await db<{ value: NotificationSettings }[]>`SELECT value FROM settings WHERE key=${settingsKey} FOR UPDATE`;
  return row?.value;
}
async function ensureSettings(db: Db, day: string) {
  const initial: NotificationSettings = { enabledAt: null, epoch: null, day, attempts: 0 };
  await db`INSERT INTO settings(key,value,updated_by) VALUES(${settingsKey},${db.json(initial)},'reset-review') ON CONFLICT(key) DO NOTHING`;
  return (await lockedSettings(db))!;
}
async function databaseTime(db: Db) {
  const [row] = await db<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  return row!.at;
}
async function disable(db: Db, settings: NotificationSettings) {
  if (!settings.epoch) {
    if (settings.enabledAt) await saveSettings(db, { ...settings, enabledAt: null, epoch: null });
    return 0;
  }
  await saveSettings(db, { ...settings, enabledAt: null, epoch: null });
  // All pre-dispatch rows are invalidated in the same transaction as the epoch. Committed attempts stay terminal.
  const rows = await db`UPDATE monitor_state SET value=(value-'reservation') || '{"status":"cancelled"}'::jsonb,updated_at=now()
    WHERE starts_with(key,${episodePrefix}) AND value->>'status' IN ('pending','reserved')`;
  return rows.count;
}
async function settleExpiredIntents(db: Db, at: Date) {
  // An intent was charged when committed. After a crash it is impossible to tell whether fetch ran.
  await db`UPDATE monitor_state SET value=(value-'reservation'-'cancelRequested') || '{"status":"unknown"}'::jsonb,updated_at=now()
    WHERE starts_with(key,${episodePrefix}) AND value->>'status'='intent' AND value->'reservation'->>'until'<=${at.toISOString()}`;
}

/** Worker startup reads the real valve. Operators can persist an explicit stop while the worker is down. */
export async function reconcileReviewNotificationSettings(enabled?: boolean) {
  return sql.begin(async db => {
    const settings = await ensureSettings(db, beijingDate(await databaseTime(db)));
    const at = await databaseTime(db);
    await settleExpiredIntents(db, at);
    if (enabled === false || !serverChan.enabled()) return { enabled: false, cancelled: await disable(db, settings) };
    if (!settings.epoch) {
      await saveSettings(db, { ...settings, enabledAt: at.toISOString(), epoch: randomUUID() });
    }
    return { enabled: true, cancelled: 0 };
  });
}

async function cancelPost(db: Db, postId: string) {
  // Only the owner of a live intent can still prove that it has not reached the transport.
  await db`UPDATE monitor_state SET value=CASE WHEN value->>'status'='intent' THEN value || '{"cancelRequested":true}'::jsonb
    ELSE (value-'reservation') || '{"status":"cancelled"}'::jsonb END,updated_at=now()
    WHERE monitor_id=${monitorId()} AND starts_with(key,${postPrefix(postId)}) AND value->>'status' IN ('pending','reserved','intent')`;
}

/** Called after a version-checked transition in the post's transaction. Senders never wait for that post lock. */
export async function captureReviewNotification(db: Db, postId: string) {
  const [post] = await db<{ processing_status: string; entered_at: Date; context_only: boolean }[]>`SELECT processing_status,updated_at AS entered_at,context_only
    FROM monitor_source_posts WHERE monitor_id=${monitorId()} AND id=${postId} FOR UPDATE`;
  if (!post || !abnormal(post.processing_status)) return;
  const settings = await ensureSettings(db, beijingDate(post.entered_at));
  if (!serverChan.enabled()) { await disable(db, settings); return; }
  if (!settings.epoch || !settings.enabledAt || post.context_only || post.entered_at.getTime() < Date.parse(settings.enabledAt)) return;
  const [historical] = await db`SELECT 1 FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${`recognition:historical:${postId}`}`;
  if (historical) return;
  await cancelPost(db, postId);
  const value: Notification = { episode: randomUUID(), postId, enteredAt: post.entered_at.toISOString(), epoch: settings.epoch, status: "pending" };
  await db`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${postPrefix(postId) + value.episode},${db.json(value)})`;
}

/** The caller holds the post lock. Once an attempt is committed, cancellation cannot overwrite it. */
export async function cancelReviewNotification(db: Db, postId: string) {
  if (await lockedSettings(db)) await cancelPost(db, postId);
}

function messageFor(definition: ResetMonitorBackendDefinition, post: ReviewPost): ReviewMessage {
  const query = new URLSearchParams({ kind: "posts", q: post.id, filter: post.processing_status, collectionFilter: "all" });
  const adminUrl = `${config.siteUrl}${definition.adminPath}?${query}`;
  // Escape source text without changing author handles or allowing embedded Markdown links/images.
  const plain = (value: string) => value.replace(/\s+/g, " ").trim().replace(/[\\`*_{}\[\]()<>!#|]/g, "\\$&");
  const title = plain(post.title?.zh ?? post.title?.en ?? "") || "无标题帖子";
  const failed = post.processing_status === "failed";
  const environment = config.environmentName === "production" ? "" : `【${config.environmentName}】`;
  return {
    title: `${environment}[${definition.product}] ${failed ? "帖子识别失败" : "帖子待人工核对"}`,
    description: [`帖子：${title.slice(0, 160)}`, `作者：@${plain(post.author)}`,
      `发布时间：${beijingDate(post.published_at)} ${beijingTime(post.published_at)}（北京时间）`,
      `处理原因：${failed ? "识别未完成，请到后台查看处理说明" : "识别结果需要人工核对，请到后台查看处理说明"}`,
      `[查看原帖](${post.url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`, `[到后台处理](${adminUrl})`].join("\n\n"),
  };
}

async function lockPost(db: Db, candidate: Candidate) {
  // Recognition can update several posts in one transaction. Never wait for a post under the shared settings lock.
  const [post] = await db<ReviewPost[]>`SELECT id,author,published_at,url,title,processing_status,context_only
    FROM monitor_source_posts WHERE monitor_id=${candidate.monitor_id} AND id=${candidate.value.postId} FOR UPDATE SKIP LOCKED`;
  if (post) return post;
  const [busy] = await db`SELECT 1 FROM monitor_source_posts WHERE monitor_id=${candidate.monitor_id} AND id=${candidate.value.postId}`;
  return busy ? "busy" as const : undefined;
}
async function currentRound(db: Db, candidate: Candidate) {
  const [row] = await db<{ value: Notification }[]>`SELECT value FROM monitor_state WHERE monitor_id=${candidate.monitor_id} AND key=${candidate.key}`;
  return row?.value;
}
async function saveRound(db: Db, candidate: Candidate, value: Notification) {
  // Only the owner of a committed attempt may settle its unknown result. No other writer changes it.
  return db`UPDATE monitor_state SET value=${db.json(value)},updated_at=now()
    WHERE monitor_id=${candidate.monitor_id} AND key=${candidate.key}`;
}

function obsolete(round: Notification, settings: NotificationSettings, post: ReviewPost | undefined, day: string) {
  if (round.cancelRequested || round.epoch !== settings.epoch || !post || post.context_only || !abnormal(post.processing_status)) return "cancelled";
  if (day < settings.day || beijingDate(round.enteredAt) !== day) return "skippedExpired";
  return null;
}
const terminalStatus = { cancelled: "cancelled", skippedExpired: "skipped_expired", skippedQuota: "skipped_quota" } as const;

async function reserve(candidate: Candidate, clock: () => number): Promise<PreDispatch | { reservation: Reservation } | null> {
  return sql.begin(async db => {
    const settings = await lockedSettings(db);
    if (!settings?.epoch) return { disabled: true, cancelled: 0 };
    if (!serverChan.enabled()) return { disabled: true, cancelled: await disable(db, settings) };
    const post = await lockPost(db, candidate);
    if (post === "busy") return null;
    const round = await currentRound(db, candidate);
    if (round?.status !== "pending" && round?.status !== "reserved") return null;
    const at = await databaseTime(db), day = beijingDate(clock());
    const progress = obsolete(round, settings, post, day);
    if (progress) {
      await saveRound(db, candidate, { ...round, reservation: undefined, status: terminalStatus[progress] });
      return { progress };
    }
    if (round.reservation && round.reservation.until > at.toISOString()) return null;
    const attempts = day === settings.day ? settings.attempts : 0;
    const [active] = await db<{ reserved: number; intents: number }[]>`SELECT
      count(*) FILTER (WHERE value->>'status'='reserved')::int AS reserved,
      count(*) FILTER (WHERE value->>'status'='intent')::int AS intents FROM monitor_state
      WHERE starts_with(key,${episodePrefix}) AND value->>'status' IN ('reserved','intent')
      AND (value->>'status'='intent' OR value->>'epoch'=${settings.epoch})
      AND value->'reservation'->>'day'=${day} AND value->'reservation'->>'until'>${at.toISOString()}`;
    if (attempts - active!.intents >= dailyLimit) {
      await saveRound(db, candidate, { ...round, reservation: undefined, status: "skipped_quota" });
      return { progress: "skippedQuota" };
    }
    // Only committed attempts that can no longer be refunded make a quota skip permanent.
    if (attempts + active!.reserved >= dailyLimit) return null;
    const reservation = { token: randomUUID(), day, until: new Date(at.getTime() + leaseMs).toISOString() };
    await saveRound(db, candidate, { ...round, reservation, status: "reserved" });
    return { reservation };
  });
}

async function commitIntent(candidate: Candidate, reservation: Reservation, clock: () => number): Promise<PreDispatch | { intent: Reservation } | null> {
  return sql.begin(async db => {
    const settings = await lockedSettings(db);
    if (!settings?.epoch) return { disabled: true, cancelled: 0 };
    if (!serverChan.enabled()) return { disabled: true, cancelled: await disable(db, settings) };
    const post = await lockPost(db, candidate);
    if (post === "busy") return null;
    const round = await currentRound(db, candidate);
    if (round?.status === "cancelled") return { progress: "cancelled" };
    if (round?.status !== "reserved" || round.reservation?.token !== reservation.token) return null;
    const at = await databaseTime(db), now = clock(), day = beijingDate(now);
    const progress = obsolete(round, settings, post, day);
    if (progress) {
      await saveRound(db, candidate, { ...round, reservation: undefined, status: terminalStatus[progress] });
      return { progress };
    }
    if (reservation.day !== day || reservation.until <= at.toISOString()) return null;

    // Conversion keeps the occupied capacity unchanged. A crash after this commit is ambiguous and never retried.
    await saveSettings(db, { ...settings, day, attempts: (settings.day === day ? settings.attempts : 0) + 1 });
    const intent = { ...reservation, until: new Date(at.getTime() + leaseMs).toISOString() };
    await saveRound(db, candidate, { ...round, reservation: intent, status: "intent", attemptedAt: new Date(now).toISOString(), error: { code: "unconfirmed" } });
    return { intent };
  });
}

async function refundIntent(db: Db, candidate: Candidate, settings: NotificationSettings, round: Notification, status: "pending" | "cancelled" | "skipped_expired") {
  if (settings.day === round.reservation!.day) {
    settings = { ...settings, attempts: settings.attempts - 1 };
    await saveSettings(db, settings);
  }
  await saveRound(db, candidate, { ...round, reservation: undefined, cancelRequested: undefined, attemptedAt: undefined, error: undefined, status });
  return settings;
}

type Delivery = { round: Notification; response: Promise<ServerChanResult> };
async function dispatch(candidate: Candidate, intent: Reservation, definition: ResetMonitorBackendDefinition, clock: () => number, started: (delivery: Delivery) => void): Promise<PreDispatch | Delivery | null> {
  return sql.begin(async db => {
    const settings = (await lockedSettings(db))!;
    const post = await lockPost(db, candidate);
    const round = await currentRound(db, candidate);
    if (round?.status !== "intent" || round.reservation?.token !== intent.token) return null;
    const at = await databaseTime(db);
    if (intent.until <= at.toISOString()) return null;

    if (!serverChan.enabled() || !settings.epoch) return stop();
    if (post === "busy" && !round.cancelRequested && round.epoch === settings.epoch) {
      // This owner knows fetch has not run. Release capacity and let a later sweep check the post again.
      await refundIntent(db, candidate, settings, round, "pending");
      return null;
    }
    const progress = obsolete(round, settings, post === "busy" ? undefined : post, beijingDate(clock()));
    if (progress) return abort(progress);
    const message = messageFor(definition, post as ReviewPost);
    const attempt: Notification = { ...round, reservation: undefined, status: "unknown" };
    await saveRound(db, candidate, attempt);

    // From the final clock and valve checks through fetch initiation, there is no await. The post and
    // settings remain locked through that call, but the response is held outside the transaction.
    const now = clock();
    if (beijingDate(now) !== intent.day) return abort("skippedExpired");
    if (!serverChan.enabled()) return stop();
    let response: ReturnType<typeof serverChan.send>;
    try { response = serverChan.send(message); }
    catch { response = Promise.resolve({ status: "unknown", error: { code: "transport" } }); }
    if ("status" in response && response.status === "disabled") return stop();
    const delivery: Delivery = { round: { ...attempt, attemptedAt: new Date(now).toISOString() }, response: Promise.resolve(response).catch(() => ({ status: "unknown", error: { code: "transport" } })) };
    started(delivery);
    return delivery;

    async function abort(progress: "cancelled" | "skippedExpired"): Promise<PreDispatch> {
      await refundIntent(db, candidate, settings, round!, terminalStatus[progress]);
      return { progress };
    }
    async function stop(): Promise<PreDispatch> {
      const refunded = await refundIntent(db, candidate, settings, round!, "cancelled");
      return { disabled: true, cancelled: 1 + await disable(db, refunded) };
    }
  });
}

function issueFor(monitorId: string, error: ServerChanIssue | null): ReviewNotificationError | null {
  switch (error?.code) {
    case "invalid_key": case "unconfirmed": case "transport":
      return { monitorId, code: error.code };
    case "http":
      return Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { monitorId, code: error.code, status: error.status } : null;
    case "rejected":
      return Number.isSafeInteger(error.providerCode) ? { monitorId, code: error.code, providerCode: error.providerCode } : null;
    default:
      return null;
  }
}

/** Most recent failed or unknown attempts, with the same sanitized error as the run detail. */
export async function reviewNotificationIssues() {
  const rows = await sql<{ monitorId: string; postId: string; status: "failed" | "unknown"; attemptedAt: string; error: ServerChanIssue | null }[]>`
    SELECT monitor_id AS "monitorId",value->>'postId' AS "postId",CASE WHEN value->>'status'='intent' THEN 'unknown' ELSE value->>'status' END AS status,
      value->>'attemptedAt' AS "attemptedAt",value->'error' AS error FROM monitor_state
    WHERE starts_with(key,${episodePrefix}) AND (value->>'status' IN ('failed','unknown')
      OR (value->>'status'='intent' AND value->'reservation'->>'until'<=to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    ORDER BY value->>'attemptedAt' DESC,monitor_id,key LIMIT 40`;
  return rows.map(row => ({ ...row, error: issueFor(row.monitorId, row.error) }));
}

/** One independent minute sweep for all monitors. No retries, catch-up, digest or model calls. */
export async function sendReviewNotifications(definitions: readonly ResetMonitorBackendDefinition[], clock = Date.now) {
  const result = { sent: 0, failed: 0, unknown: 0, cancelled: 0, skippedQuota: 0, skippedExpired: 0, disabled: false, errors: [] as ReviewNotificationError[] };
  const record = (step: PreDispatch) => {
    if ("disabled" in step) { result.disabled = true; result.cancelled += step.cancelled; }
    else result[step.progress]++;
  };
  async function delivered(delivery: Delivery, candidate: Candidate) {
    const outcome = await delivery.response;
    // Real disabled results are synchronous and were refunded before leaving the dispatch transaction.
    const status = outcome.status === "disabled" ? "unknown" : outcome.status;
    const error: ServerChanIssue | undefined = "error" in outcome ? outcome.error : status === "unknown" ? { code: "unconfirmed" } : undefined;
    result[status]++;
    const issue = issueFor(candidate.monitor_id, error ?? null);
    if (issue) result.errors.push(issue);
    return { ...delivery.round, status, error };
  }
  try {
    const settings = await reconcileReviewNotificationSettings();
    result.disabled = !settings.enabled; result.cancelled = settings.cancelled;
    if (result.disabled) return result;
    const monitors = new Map(definitions.map(definition => [definition.monitorId, definition]));
    const candidates = await sql<Candidate[]>`SELECT monitor_id,key,value FROM monitor_state
      WHERE monitor_id=ANY(${[...monitors.keys()]}::text[]) AND starts_with(key,${episodePrefix}) AND value->>'status' IN ('pending','reserved')
      ORDER BY value->>'enteredAt',monitor_id,key`;
    for (const candidate of candidates) {
      const claim = await reserve(candidate, clock);
      if (!claim) continue;
      if (!("reservation" in claim)) { record(claim); if (result.disabled) break; continue; }
      const step = await commitIntent(candidate, claim.reservation, clock);
      if (!step) continue;
      if (!("intent" in step)) { record(step); if (result.disabled) break; continue; }

      let started: Delivery | undefined;
      let dispatchResult: PreDispatch | Delivery | null;
      try {
        dispatchResult = await dispatch(candidate, step.intent, monitors.get(candidate.monitor_id)!, clock, delivery => { started = delivery; });
      } catch (error) {
        if (started) await delivered(started, candidate);
        throw error;
      }
      if (!dispatchResult) continue;
      if (!("round" in dispatchResult)) { record(dispatchResult); if (result.disabled) break; continue; }
      const saved = await saveRound(sql, candidate, await delivered(dispatchResult, candidate));
      if (saved.count !== 1) throw new Error("Notification result row is missing");
    }
    return result;
  } catch {
    // SQL errors can include query data; keep only the safe counters and provider codes in job_runs.
    throw new JobRunError("人工核对通知任务未完成", result);
  }
}
