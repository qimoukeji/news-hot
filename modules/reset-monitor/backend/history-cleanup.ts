import { createHash } from "node:crypto";
import { sql, type Db } from "@aihot/backend/db";
import { stableJson } from "@aihot/backend/lib/ids";
import { audit } from "@aihot/backend/audit";

type Row = Record<string, unknown> & { monitor_id: string; id: string };
type State = { monitor_id: string; key: string; value: Record<string, unknown> };
export interface MonitorHistorySnapshot { events: Row[]; links: Array<{ monitor_id: string; event_id: string; post_id: string }>; posts: Row[]; states: State[] }
const identity = (row: { monitor_id: string; id: string }) => `${row.monitor_id}:${row.id}`;
const digest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const retiredPostFields = ["processingMode", "processingCompletion", "contextPending", "collectionFilter"];

/** Reachability starts at every event, including withdrawn events, and follows saved evidence only. */
export function monitorHistoryPlan(snapshot: MonitorHistorySnapshot) {
  const posts = new Map(snapshot.posts.map(row => [identity(row), row]));
  const eventIds = new Set(snapshot.events.map(identity));
  const kept = new Set(snapshot.links.map(row => `${row.monitor_id}:${row.post_id}`));
  const visit = (monitor: string, value: unknown) => {
    if (typeof value === "string") {
      for (const id of [value, /\/status\/(\d+)/.exec(value)?.[1]].filter((id): id is string => !!id)) {
        if (posts.has(`${monitor}:${id}`)) kept.add(`${monitor}:${id}`);
      }
    } else if (Array.isArray(value)) value.forEach(item => visit(monitor, item));
    else if (value && typeof value === "object") Object.values(value).forEach(item => visit(monitor, item));
  };
  for (const event of snapshot.events) visit(event.monitor_id, event);
  for (const post of snapshot.posts) {
    const activity = post.activity as { eventIds?: string[] } | null;
    const outage = post.outage as { resetEventId?: string } | null;
    if (activity?.eventIds?.some(id => eventIds.has(`${post.monitor_id}:${id}`))
      || outage?.resetEventId && eventIds.has(`${post.monitor_id}:${outage.resetEventId}`)) kept.add(identity(post));
  }
  const visited = new Set<string>();
  for (const id of kept) {
    if (visited.has(id)) continue;
    visited.add(id);
    const post = posts.get(id);
    if (!post) throw new Error(`An event source is missing: ${id}`);
    visit(post.monitor_id, post.context);
    visit(post.monitor_id, post.raw);
    visit(post.monitor_id, post.recognition);
  }
  const deletedPosts = snapshot.posts.filter(row => !kept.has(identity(row))).map(row => ({ monitor_id: row.monitor_id, id: row.id }));
  const updatedPosts = snapshot.posts.filter(row => kept.has(identity(row))).flatMap(row => {
    const raw = row.raw as Record<string, unknown> | null;
    if (!raw || !retiredPostFields.some(key => key in raw)) return [];
    const clean = { ...raw };
    retiredPostFields.forEach(key => delete clean[key]);
    return [{ monitor_id: row.monitor_id, id: row.id, raw: clean }];
  });
  const deletedStates: Array<{ monitor_id: string; key: string }> = [];
  const updatedStates: State[] = [];
  for (const row of snapshot.states) {
    let value: Record<string, unknown> | undefined;
    if (row.key.startsWith("cursor:")) value = { checkpointVersion: 2, scannedThrough: row.value.scannedThrough };
    else if (row.key.startsWith("watermarks:")) value = Object.fromEntries(["lastAttemptAt", "lastCollectedAt", "lastVerifiedAt"].filter(key => row.value[key] !== undefined).map(key => [key, row.value[key]]));
    else if (row.key.startsWith("collection:coverage:v1:")) value = { authors: row.value.authors, scopeEffectiveAt: row.value.scopeEffectiveAt };
    else if (row.key === "publication_revision" || row.key.startsWith("public_v2:pending:") && eventIds.has(`${row.monitor_id}:${row.key.slice("public_v2:pending:".length)}`)) value = row.value;
    if (!value) deletedStates.push({ monitor_id: row.monitor_id, key: row.key });
    else if (stableJson(value) !== stableJson(row.value)) updatedStates.push({ ...row, value });
  }
  return {
    fingerprint: digest(snapshot),
    eventFingerprint: digest({ events: snapshot.events, links: snapshot.links }),
    counts: [...new Set(snapshot.events.map(row => row.monitor_id).concat(snapshot.posts.map(row => row.monitor_id)))].sort().map(monitor => ({
      monitor, events: snapshot.events.filter(row => row.monitor_id === monitor).length,
      keptPosts: snapshot.posts.filter(row => row.monitor_id === monitor && kept.has(identity(row))).length,
      deletedPosts: deletedPosts.filter(row => row.monitor_id === monitor).length,
    })),
    deletedPosts, updatedPosts, deletedStates, updatedStates,
  };
}

export async function monitorHistorySnapshot(monitors: string[], db: Db = sql): Promise<MonitorHistorySnapshot> {
  const [events, links, posts, states] = await Promise.all([
    db<{ row: Row }[]>`SELECT to_jsonb(e) AS row FROM monitor_events e WHERE monitor_id=ANY(${monitors}::text[]) ORDER BY monitor_id,id`,
    db<MonitorHistorySnapshot["links"]>`SELECT * FROM monitor_event_posts WHERE monitor_id=ANY(${monitors}::text[]) ORDER BY monitor_id,event_id,post_id`,
    db<{ row: Row }[]>`SELECT to_jsonb(p) AS row FROM monitor_posts p WHERE monitor_id=ANY(${monitors}::text[]) ORDER BY monitor_id,id`,
    db<State[]>`SELECT monitor_id,key,value FROM monitor_state WHERE monitor_id=ANY(${monitors}::text[]) ORDER BY monitor_id,key`,
  ]);
  return { events: events.map(row => row.row), links, posts: posts.map(row => row.row), states };
}

/** Call only after a verified database backup and operator review of this exact preview. */
export async function cleanupMonitorHistory(monitors: string[], fingerprint: string) {
  return sql.begin(async tx => {
    await tx`SET LOCAL lock_timeout='5s'`;
    for (const monitor of [...monitors].sort()) {
      const name = monitor === "codex" ? "monitor.tick" : `${monitor}-reset.tick`;
      const [lock] = await tx<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${name})) AS acquired`;
      if (!lock?.acquired) throw new Error("Stop all monitor workers before history cleanup");
    }
    await tx`LOCK TABLE monitor_events,monitor_event_posts,monitor_posts,monitor_state IN SHARE ROW EXCLUSIVE MODE`;
    const plan = monitorHistoryPlan(await monitorHistorySnapshot(monitors, tx));
    if (plan.fingerprint !== fingerprint) throw new Error("History changed after preview; create a new backup and review a new plan");
    for (const monitor of monitors) {
      const ids = plan.deletedPosts.filter(row => row.monitor_id === monitor).map(row => row.id);
      if (ids.length) await tx`DELETE FROM monitor_posts WHERE monitor_id=${monitor} AND id=ANY(${ids}::text[])`;
    }
    for (const row of plan.updatedPosts) await tx`UPDATE monitor_posts SET raw=${tx.json(row.raw as never)} WHERE monitor_id=${row.monitor_id} AND id=${row.id}`;
    for (const row of plan.deletedStates) await tx`DELETE FROM monitor_state WHERE monitor_id=${row.monitor_id} AND key=${row.key}`;
    for (const row of plan.updatedStates) await tx`UPDATE monitor_state SET value=${tx.json(row.value as never)} WHERE monitor_id=${row.monitor_id} AND key=${row.key}`;
    const after = await monitorHistorySnapshot(monitors, tx);
    if (monitorHistoryPlan(after).eventFingerprint !== plan.eventFingerprint) throw new Error("History cleanup changed events or event links");
    await audit("operator", "reset_monitor.history.cleanup", monitors.join(","), "Keep events and their saved evidence; remove unrelated collection history and retired workflow state", { fingerprint: plan.fingerprint }, { counts: plan.counts, removedStateKeys: plan.deletedStates }, { db: tx });
    return plan.counts;
  });
}
