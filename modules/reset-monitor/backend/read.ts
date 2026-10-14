import { monitor as currentMonitor, monitorId, authorHandles, authorNameFor, purpose as requestPurpose, auditAction, auditSubject } from "./context.ts";
// The public snapshot and monitor page read the
// same events. Announcement, in-progress, confirmation and "should have landed" stay distinct;
// passing an announced time never turns into a confirmation.
import { addDays, beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { watermarksKey, scanMinutes } from "../config.ts";
import type { ResetMonitorBonusCredit, ResetMonitorEventKind, ResetMonitorPresentationStatus, ResetMonitorCalendarMark, ResetMonitorMonitor, ResetMonitorPageData, ResetMonitorSnapshot, ResetMonitorVersion } from "../contracts.ts";
import { sql, type Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { proxiedImage } from "@aihot/backend/media/imgproxy";
import { siteUrl } from "@aihot/backend/publication/links";
import { collectionCoverageKey, CollectionCoverage } from "./collection-coverage.ts";

export const monitorPageUrl = () => siteUrl(currentMonitor().pagePath);
/** After the estimated window passes: "expired_unconfirmed" first, then "likely_completed". */
export const LIKELY_COMPLETED_AFTER_MS = 6 * 3600_000;
/** An acknowledged outage stays visible as a hint for this long. */
export const OUTAGE_VISIBLE_MS = 18 * 3600_000;

const OFFSET_MS = 8 * 3600_000;

/** "2026-09-26T08:07:13.000+08:00" */
export function bjIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return null;
  return `${new Date(t + OFFSET_MS).toISOString().slice(0, 23)}+08:00`;
}

interface EventRow {
  id: string;
  type: ResetMonitorEventKind;
  status: "announced" | "confirmed";
  title: string;
  scope: string;
  label: string;
  display_label: string;
  schedule: { precision: string; from: string; through: string; label: string } | null;
  estimate: { from: string; through: string; basis: string; label: string; reason: string } | null;
  presentation: { scopeKnown: boolean; scopeLabel: string | null; kindExplicit: boolean; timeInferred: boolean; timePolicy?: "explicit" | "predicted"; audienceZh: string | null; productsZh: string | null; quotaScope?: string | null; reportedAt: string | null; inProgress?: boolean; bonusCredit?: ResetMonitorBonusCredit | null } | null;
  confirmed_at: Date | null;
  occurred_on: Date | null;
  confirmation_basis: "source_post" | "receipt_review" | null;
  created_at: Date;
  updated_at: Date;
}

interface PostRow {
  id: string;
  author: string;
  avatar: string | null;
  published_at: Date;
  text: string;
  translation: string | null;
  url: string;
  context: Array<{ id: string; author: string; relation: "reply" | "quote"; text: string | null; originalText: string; url: string }>;
  activity: { kind: "event_update" | "related"; action: string | null; statusChanged: boolean; eventIds: string[] } | null;
  outage: { kind: string; recoveredAt: string | null; resetEventId: string | null } | null;
}

interface LinkRow {
  event_id: string;
  post_id: string;
  stage: string;
  action: string | null;
  text: string;
  original_text: string;
}

export type PresentationStatus = ResetMonitorPresentationStatus;

/**
 * The window decides first: an announcement whose estimated window has passed reads as late, then as
 * likely landed, even if the monitored author once said it was under way; "in progress" only holds while the window is
 * still open.
 */
export function presentationStatus(e: Pick<EventRow, "status" | "estimate" | "schedule" | "presentation"> & { type?: ResetMonitorEventKind; confirmation_basis?: EventRow["confirmation_basis"] }, now: number): PresentationStatus {
  if (e.type === "bonus_credit") {
    const bonus = e.presentation?.bonusCredit;
    if (bonus?.expiresAt?.at && now >= Date.parse(bonus.expiresAt.at)) return "expired";
    if (bonus?.claimDeadline?.at && now >= Date.parse(bonus.claimDeadline.at)) return "claim_closed";
    return e.status === "confirmed" && e.confirmation_basis === "source_post" ? "available" : e.presentation?.inProgress ? "in_progress" : "announced";
  }
  if (e.status === "confirmed") return "confirmed";
  const window = e.estimate ?? e.schedule;
  const through = window ? Date.parse(window.through) : null;
  if (through !== null && now >= through) return (e.presentation?.timePolicy ?? currentMonitor().timePolicy) === "explicit" || now < through + LIKELY_COMPLETED_AFTER_MS ? "expired_unconfirmed" : "likely_completed";
  return e.presentation?.inProgress ? "in_progress" : "announced";
}

/**
 * Titles follow the event's state, so an announcement that should have landed says so, and a reset
 * confirmed only by an account check does not read as the monitored author's own confirmation.
 */
export function eventTitle(type: EventRow["type"], status: EventRow["status"], shown: PresentationStatus, kindExplicit: boolean, basis: EventRow["confirmation_basis"] = null, author?: string): string {
  const name = author ? authorNameFor(author) : "官方";
  if (type === "bonus_credit") return shown === "expired" ? "奖励额度已到期" : shown === "claim_closed" ? "奖励额度领取已截止" : status === "confirmed" ? basis === "source_post" ? "奖励额度活动可领取" : "奖励活动确认依据待核实" : `${name} 预告奖励额度活动`;
  const credit = type === "reset_credit";
  if (status === "confirmed") {
    if (!basis) return credit ? "重置卡确认依据待核实" : "额度重置确认依据待核实";
    if (credit) return "重置卡已发放";
    if (basis === "receipt_review") return "额度重置已核实到账";
    return kindExplicit ? `${currentMonitor().product} 额度重置已完成` : `${name} 确认重置`;
  }
  if (shown === "likely_completed") return credit ? "重置卡应已发放" : "额度应已重置";
  if (shown === "in_progress") return credit ? "重置卡正在发放" : "额度重置进行中";
  return credit ? `${name} 预告将发放重置卡` : `${name} 预告将重置额度`;
}

/**
 * A post whose claims wait for a person: the recognizer was unsure, or a claim is not quoted in the post
 * (applyRecognition holds those back). It waits until a complete manual decision is submitted; until
 * then the verification watermark stays put, the page shows the monitor needs attention, and the admin
 * is reminded.
 */
export function awaitingReviewCondition() {
  return sql`((recognition->>'needsReview')::boolean IS TRUE AND recognition->'manualReview'->>'completed' IS DISTINCT FROM 'true')`;
}

async function loadHealth(db: Db = sql) {
  const state = new Map((await db<{ key: string; value: any }[]>`
    SELECT key, value FROM (SELECT * FROM monitor_state WHERE monitor_id = ${monitorId()}) AS monitor_state WHERE key IN (${watermarksKey()}, 'publication_revision', ${collectionCoverageKey()})`).map((r) => [r.key === watermarksKey() ? "watermarks" : r.key, r.value]));
  const [counts] = await db<{ pending: number; review: number; first_post: Date | null }[]>`
    SELECT count(*) FILTER (WHERE processed_at IS NULL AND lower(author)=ANY(${authorHandles()}::text[])) AS pending, count(*) FILTER (WHERE ${awaitingReviewCondition()}) AS review, min(published_at) AS first_post
    FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts`;
  state.set("history", { from: counts?.first_post?.toISOString() ?? null });
  return { state, counts: counts ?? { pending: 0, review: 0 } };
}

async function loadAll(now: number, from?: number) {
  // Events, links and posts must describe one committed state, including during admin corrections.
  return sql.begin("isolation level repeatable read read only", async (db) => {
    const allEvents = await db<EventRow[]>`
      SELECT id, type, status, title, scope, label, display_label, schedule, estimate, presentation, confirmed_at, occurred_on, confirmation_basis, created_at, updated_at
      FROM (SELECT * FROM monitor_events WHERE monitor_id = ${monitorId()}) AS monitor_events WHERE NOT withdrawn ORDER BY updated_at DESC, id ASC`;
    const events = from === undefined ? allEvents : allEvents.filter((e) => e.updated_at.getTime() >= from
      || (e.presentation && ["announced", "in_progress", "expired_unconfirmed", "available"].includes(presentationStatus(e, now))));
    const links = await db<LinkRow[]>`SELECT event_id, post_id, stage, action, text, original_text FROM (SELECT * FROM monitor_event_posts WHERE monitor_id = ${monitorId()}) AS monitor_event_posts
      WHERE event_id = ANY(${events.map((e) => e.id)}::text[])`;
    const posts = await db<PostRow[]>`
      SELECT id, author, raw->'tweet'->'user'->>'profile_image_url_https' AS avatar, published_at, text, translation, url, context, activity, outage FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts
      WHERE (activity IS NOT NULL AND ${from === undefined ? db`true` : db`published_at >= ${new Date(from)}`})
        OR (outage IS NOT NULL AND ${from === undefined ? db`true` : db`published_at >= ${new Date(now - OUTAGE_VISIBLE_MS)}`})
        OR id = ANY(${links.map((l) => l.post_id)}::text[])`;
    return { events, links, posts: new Map(posts.map((p) => [p.id, p])), ...await loadHealth(db) };
  });
}

function legacyPresentation(value: EventRow["presentation"]) {
  const stored = value as (EventRow["presentation"] & { publicV2?: { legacyPresentationWasNull?: boolean } });
  return stored?.publicV2?.legacyPresentationWasNull && Object.keys(stored).every(key => key === "publicV2") ? null : stored;
}

function eventJson(e: EventRow, links: LinkRow[], posts: Map<string, PostRow>, now: number) {
  const status = presentationStatus(e, now);
  const p = legacyPresentation(e.presentation);
  const presentation = p
    ? {
        ...(p.reportedAt ? { reportedAt: bjIso(p.reportedAt) } : {}),
        status,
        scopeKnown: p.scopeKnown,
        scopeLabel: p.scopeLabel,
        kindExplicit: p.kindExplicit,
        timeInferred: p.timeInferred,
        ...(p.timePolicy ? { timePolicy: p.timePolicy } : {}),
        audienceZh: p.audienceZh,
        productsZh: p.productsZh,
        ...(p.quotaScope !== undefined ? { quotaScope: p.quotaScope } : {}),
        ...(e.type === "bonus_credit" ? { bonusCredit: p.bonusCredit ? {
          ...p.bonusCredit,
          claimDeadline: p.bonusCredit.claimDeadline && { ...p.bonusCredit.claimDeadline, at: bjIso(p.bonusCredit.claimDeadline.at) },
          expiresAt: p.bonusCredit.expiresAt && { ...p.bonusCredit.expiresAt, at: bjIso(p.bonusCredit.expiresAt.at) },
        } : null } : {}),
      }
    : null;
  const eventPosts = links
    .map((l) => ({ l, post: posts.get(l.post_id) }))
    .filter((x): x is { l: LinkRow; post: PostRow } => !!x.post)
    .sort((a, b) => b.post.published_at.getTime() - a.post.published_at.getTime() || (a.l.post_id < b.l.post_id ? 1 : -1))
    .map(({ l, post }) => ({
      id: post.id,
      author: post.author,
      authorAvatar: post.avatar ? proxiedImage(post.avatar, "avatar") : null,
      publishedAt: bjIso(post.published_at),
      stage: l.stage,
      text: l.text,
      originalText: l.original_text,
      fullText: post.translation,
      fullOriginalText: post.text,
      context: contextJson(post.context),
      url: post.url,
    }));
  const schedule = e.schedule && { precision: e.schedule.precision, from: bjIso(e.schedule.from), through: bjIso(e.schedule.through), label: e.schedule.label };
  const estimate = e.estimate && { from: bjIso(e.estimate.from), through: bjIso(e.estimate.through), basis: e.estimate.basis, label: e.estimate.label, reason: e.estimate.reason };
  return {
    id: e.id,
    type: e.type,
    label: e.label,
    displayLabel: e.display_label,
    presentation,
    estimate: e.type === "bonus_credit" || e.status === "confirmed" ? null : estimate,
    status: e.status,
    title: eventTitle(e.type, e.status, status, p?.kindExplicit ?? true, e.confirmation_basis, eventPosts[0]?.author),
    scope: e.scope,
    createdAt: bjIso(e.created_at),
    updatedAt: bjIso(e.updated_at),
    confirmedAt: bjIso(e.confirmed_at),
    occurredOn: e.occurred_on ? e.occurred_on.toISOString().slice(0, 10) : null,
    confirmationBasis: e.confirmation_basis,
    schedule,
    posts: eventPosts,
    url: monitorPageUrl(),
  };
}

/** Context posts in the published key order (jsonb storage does not keep it). */
function contextJson(context: PostRow["context"]) {
  return context.map((c) => ({ id: c.id, author: c.author, relation: c.relation, text: c.text, originalText: c.originalText, url: c.url }));
}


function monitorJson(state: Map<string, any>, counts: { pending: number; review: number }, now: number) {
  const w = state.get("watermarks") as { lastAttemptAt?: string; lastCollectedAt?: string; lastVerifiedAt?: string } | undefined;
  if (!w) return null;
  const verified = w.lastVerifiedAt ? Date.parse(w.lastVerifiedAt) : NaN;
  const age = now - verified;
  const coverage = state.has(collectionCoverageKey()) ? CollectionCoverage.parse(state.get(collectionCoverageKey())) : null;
  // Unresolved work outranks a fresh check: a held window or a post waiting for a person needs
  // attention, a post not yet processed means the picture is delayed.
  const status: ResetMonitorMonitor["status"] = !Number.isFinite(verified) ? "unknown"
    : Number(counts.review) > 0 || age > 3 * 3600_000 ? "attention"
      : Number(counts.pending) > 0 || age > 40 * 60_000 ? "delayed" : "healthy";
  return {
    status,
    lastAttemptAt: bjIso(w.lastAttemptAt),
    lastCollectedAt: bjIso(w.lastCollectedAt),
    lastVerifiedAt: bjIso(w.lastVerifiedAt),
    pendingCount: Number(counts.pending),
    reviewCount: Number(counts.review),
    authors: currentMonitor().authors.map(author => ({ handle: author.handle, name: author.name,
      collectedSince: bjIso(coverage?.authors.find(a => a.handle.toLowerCase() === author.handle.toLowerCase())?.collectedSince) })),
    scopeEffectiveAt: bjIso(coverage?.scopeEffectiveAt),
  };
}

/** Days of history in the polling snapshot served at GET /api/v1/monitor resets/recent. */
export const RECENT_DAYS = 7;

/**
 * The polling form of the snapshot, same shape: events updated within the last week plus every event
 * still waiting to land, and the week's source posts. The full snapshot is about 250 KB and grows every
 * month; this one carries what a poller acts on in a few KB.
 */
export async function resetsRecent(now = Date.now()): Promise<ResetMonitorSnapshot> {
  // Whole Beijing days, so the answer (and its ETag) only changes when the content does.
  const from = beijingMidnight(addDays(beijingDate(now), -RECENT_DAYS)).getTime();
  return snapshot(now, from);
}

/** The complete public snapshot served at GET /api/v1/monitor resets. */
export async function resetsSnapshot(now = Date.now()): Promise<ResetMonitorSnapshot> {
  return snapshot(now);
}

async function snapshot(now: number, from?: number): Promise<ResetMonitorSnapshot> {
  return (await snapshotWithRevision(now, from)).snapshot;
}

async function snapshotWithRevision(now: number, from?: number): Promise<{ snapshot: ResetMonitorSnapshot; revision: unknown }> {
  const { events, links, posts, state, counts } = await loadAll(now, from);
  const linksByEvent = new Map<string, LinkRow[]>();
  for (const link of links) {
    const group = linksByEvent.get(link.event_id) ?? [];
    group.push(link);
    linksByEvent.set(link.event_id, group);
  }
  const eventJsons = events.map((e) => eventJson(e, linksByEvent.get(e.id) ?? [], posts, now));
  const activeIds = new Set(events.map((e) => e.id));
  const activities = [...posts.values()]
    .filter((p) => p.activity && (from === undefined || p.published_at.getTime() >= from))
    .sort((a, b) => b.published_at.getTime() - a.published_at.getTime())
    .map((p) => {
      const currentLinks = links.filter((l) => l.post_id === p.id);
      const eventIds = [...new Set(currentLinks.map((l) => l.event_id))];
      const action = ["confirm", "announce", "amend", "withdraw", "progress"].find((a) => currentLinks.some((l) => l.action === a)) ?? null;
      return ({
      id: p.id,
      author: p.author,
      authorAvatar: p.avatar ? proxiedImage(p.avatar, "avatar") : null,
      publishedAt: bjIso(p.published_at),
      eventIds: eventIds.length ? eventIds : p.activity!.kind === "related" ? p.activity!.eventIds.filter((id) => activeIds.has(id)) : [],
      kind: eventIds.length ? "event_update" as const : "related" as const,
      text: p.translation,
      originalText: p.text,
      context: contextJson(p.context),
      statusChanged: eventIds.length > 0 && action !== null && action !== "progress",
      action: eventIds.length ? action : null,
      url: p.url,
    }); });
  const outagePost = [...posts.values()]
    .filter((p) => p.outage && now - p.published_at.getTime() <= OUTAGE_VISIBLE_MS)
    .sort((a, b) => b.published_at.getTime() - a.published_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  const outage = outagePost
    ? {
        postId: outagePost.id,
        author: outagePost.author,
        authorAvatar: outagePost.avatar ? proxiedImage(outagePost.avatar, "avatar") : null,
        publishedAt: bjIso(outagePost.published_at),
        text: outagePost.translation,
        originalText: outagePost.text,
        recoveredAt: bjIso(outagePost.outage!.recoveredAt),
        resetEventId: outagePost.outage!.resetEventId && activeIds.has(outagePost.outage!.resetEventId) ? outagePost.outage!.resetEventId : null,
        url: outagePost.url,
      }
    : null;
  const monitor = monitorJson(state, counts, now);
  return { revision: state.get("publication_revision"), snapshot: {
    schemaVersion: 1 as const,
    timezone: "Asia/Shanghai" as const,
    today: beijingDate(now),
    checkedAt: monitor?.lastVerifiedAt ?? null,
    historyFrom: state.get("history")?.from ? bjIso(new Date(Math.max(from ?? -Infinity, Date.parse(state.get("history").from)))) : null,
    count: eventJsons.length,
    events: eventJsons,
    activities,
    monitor,
    outage,
  } };
}

type CalendarMark = ResetMonitorCalendarMark;

function versionHash(events: Array<[string, string | null, PresentationStatus | undefined]>, outage: string | null, monitor: ResetMonitorMonitor | null, revision: unknown): string {
  const health = monitor && [monitor.status, monitor.pendingCount, monitor.reviewCount, monitor.authors, monitor.scopeEffectiveAt];
  return sha256(stableJson({ events, outage, health, revision: revision ?? null, scanMinutes: scanMinutes() })).slice(0, 16);
}

/** Everything the monitor page renders, derived from the same snapshot as v1. */
export async function resetPage(now = Date.now()): Promise<ResetMonitorPageData> {
  const { snapshot: snap, revision } = await snapshotWithRevision(now);
  const today = snap.today;
  const marks: CalendarMark[] = snap.events.flatMap((e): CalendarMark[] => {
    if (e.type === "bonus_credit") {
      const official = e.status === "confirmed" && e.confirmationBasis === "source_post";
      const result: CalendarMark[] = [{ date: (e.confirmedAt ?? e.createdAt)!.slice(0, 10), eventId: e.id, type: e.type, state: official ? "confirmed" : "pending", label: official ? "奖励可领取" : e.status === "confirmed" ? "奖励待核实" : "奖励预告" }];
      for (const [milestone, time, label] of [
        ["claim_deadline", e.presentation?.bonusCredit?.claimDeadline, "奖励领取截止"],
        ["expiry", e.presentation?.bonusCredit?.expiresAt, "奖励到期"],
      ] as const) if (time?.at) result.push({ date: time.at.slice(0, 10), eventId: e.id, type: e.type, state: Date.parse(time.at) <= now ? "confirmed" : "pending", label, milestone });
      return result;
    }
    const status = e.presentation?.status ?? (e.status === "confirmed" ? "confirmed" : "announced");
    const state: CalendarMark["state"] = status === "confirmed" ? "confirmed" : status === "likely_completed" ? "likely" : "pending";
    const unclear = e.presentation ? !e.presentation.kindExplicit : false;
    const label = state === "pending" ? "待生效" : e.type === "reset_credit" ? "发重置卡" : unclear ? "重置确认" : "额度重置";
    const day = e.occurredOn ?? (e.confirmedAt ? e.confirmedAt.slice(0, 10) : (e.estimate ?? e.schedule)?.from?.slice(0, 10) ?? e.createdAt!.slice(0, 10));
    return [{ date: day, eventId: e.id, type: e.type, state, label }];
  });
  const since = addDays(today, -90);
  const factualIds = new Set(snap.events.filter((e) => e.type !== "bonus_credit" && e.status === "confirmed" && e.confirmationBasis && (e.occurredOn || e.confirmedAt)).map((e) => e.id));
  const landed = marks.filter((m) => factualIds.has(m.eventId));
  const inWindow = landed.filter((m) => m.date > since && m.date <= today);
  const resetDays = [...new Set(landed.filter((m) => m.type === "direct_reset" && m.state === "confirmed" && m.date <= today).map((m) => m.date))].sort();
  // Only dated, confirmed facts enter statistics. A verified day is represented by noon.
  const landedAt = (e: (typeof snap.events)[number]) => {
    if (!factualIds.has(e.id)) return null;
    return Date.parse(e.occurredOn ? `${e.occurredOn}T12:00:00+08:00` : e.confirmedAt!);
  };
  const sinceMs = now - 90 * 86400_000;
  const rounds = snap.events.filter((e) => e.type === "direct_reset").map(landedAt).filter((t): t is number => t !== null && t <= now && t >= sinceMs).sort((a, b) => a - b);
  const intervals = rounds.slice(1).map((t, i) => (t - rounds[i]!) / 86400_000).sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const median = intervals.length ? Math.round((intervals.length % 2 ? intervals[mid]! : (intervals[mid - 1]! + intervals[mid]!) / 2) * 10) / 10 : null;
  const pending = snap.events.find((e) => e.type !== "bonus_credit" && e.presentation && ["announced", "in_progress", "expired_unconfirmed"].includes(e.presentation.status));
  // The monitored account's avatar, from its latest collected post.
  const [authorRow] = await sql<{ avatar: string | null }[]>`
    SELECT raw->'tweet'->'user'->>'profile_image_url_https' AS avatar FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts
    WHERE lower(author) = ${currentMonitor().authors[0]!.handle.toLowerCase()} AND raw->'tweet'->'user' ? 'profile_image_url_https' ORDER BY published_at DESC LIMIT 1`;
  const lastLanded = snap.events.filter((e) => landedAt(e) !== null && landedAt(e)! <= now)
    .sort((a, b) => landedAt(b)! - landedAt(a)!)[0];
  return {
    ...snap,
    scanMinutes: scanMinutes(),
    current: pending ?? null,
    lastLanded: lastLanded ?? null,
    authorAvatar: authorRow?.avatar ? proxiedImage(authorRow.avatar, "avatar") : null,
    stats: {
      resets90: inWindow.filter((m) => m.type === "direct_reset").length,
      credits90: inWindow.filter((m) => m.type === "reset_credit").length,
      bonuses90: snap.events.filter((e) => e.type === "bonus_credit" && e.status === "confirmed" && e.confirmationBasis === "source_post" && e.confirmedAt && e.confirmedAt.slice(0, 10) > since && e.confirmedAt.slice(0, 10) <= today).length,
      medianIntervalDays: median,
      lastResetDate: resetDays.at(-1) ?? null,
    },
    calendar: marks,
    confirmMinutes: snap.events
      .filter((e) => e.type === "direct_reset" && e.confirmedAt && e.confirmationBasis === "source_post")
      .map((e) => Number(e.confirmedAt!.slice(11, 13)) * 60 + Number(e.confirmedAt!.slice(14, 16))),
    version: versionHash(snap.events.map((e) => [e.id, e.updatedAt, e.presentation?.status]), snap.outage ? `${snap.outage.postId}${snap.outage.recoveredAt ? `:${new Date(snap.outage.recoveredAt).toISOString()}` : ""}` : null, snap.monitor, revision),
  };
}

/** Cheap version probe for the page's foreground polling. */
export async function resetVersion(now = Date.now()): Promise<ResetMonitorVersion> {
  // Keep clock-driven transitions in the hash, without loading posts, citations, calendars or avatars.
  type VersionEvent = Pick<EventRow, "id" | "type" | "updated_at" | "status" | "confirmation_basis" | "estimate" | "schedule" | "presentation">;
  return sql.begin("isolation level repeatable read read only", async (db) => {
  const [events, [outage], health] = await Promise.all([
    db<VersionEvent[]>`SELECT id, type, updated_at, status, confirmation_basis, estimate, schedule, presentation
      FROM (SELECT * FROM monitor_events WHERE monitor_id = ${monitorId()}) AS monitor_events WHERE NOT withdrawn ORDER BY updated_at DESC, id ASC`,
    db<{ id: string }[]>`SELECT id || coalesce(':' || (outage->>'recoveredAt'), '') AS id FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts WHERE outage IS NOT NULL AND outage <> 'null'::jsonb
      AND published_at >= ${new Date(now - OUTAGE_VISIBLE_MS)} ORDER BY published_at DESC, id COLLATE "C" ASC LIMIT 1`,
    loadHealth(db),
  ]);
  const monitor = monitorJson(health.state, health.counts, now);
  return {
    version: versionHash(events.map((e) => [e.id, bjIso(e.updated_at), legacyPresentation(e.presentation) ? presentationStatus(e, now) : undefined]), outage?.id ?? null, monitor, health.state.get("publication_revision")),
    checkedAt: monitor?.lastVerifiedAt ?? null,
    today: beijingDate(now),
  };
  });
}
