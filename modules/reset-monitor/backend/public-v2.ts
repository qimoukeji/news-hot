import { Temporal } from "@js-temporal/polyfill";
import { sql, type Db } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { beijingDate, addDays } from "@aihot/contracts/time";
import { monitor, monitorId } from "./context.ts";
import type { ResetMonitorBackendDefinition } from "./context.ts";
import { resetSnapshotSchema, reviewedEventSchema, type ResetSnapshot, type ResetEvent, type EventTime } from "../public-v2.ts";
import type { ResetMonitorEventKind } from "../contracts.ts";
import { resolveBonusTimes } from "./public-v2-time.ts";

type Timestamp = Date | string;
export interface PublicV2EventRow {
  id: string; type: ResetMonitorEventKind; status: "announced" | "confirmed";
  title: string; scope: string; label: string; display_label: string;
  schedule: unknown; estimate: unknown; presentation: Record<string, any> | null;
  confirmed_at: Timestamp | null; occurred_on: Timestamp | null; confirmation_basis: string | null;
  withdrawn: boolean; created_at: Timestamp; updated_at: Timestamp;
}
export interface PublicV2PostRow {
  id: string; author: string; published_at: Timestamp; text: string; url: string;
  translation: string | null; context: unknown; recognition: unknown;
}
export interface PublicV2LinkRow {
  event_id: string; post_id: string; stage: string; action: string | null; text: string; original_text: string;
}
export interface PublicV2Input { events: PublicV2EventRow[]; posts: PublicV2PostRow[]; links: PublicV2LinkRow[] }

const iso = (value: Timestamp) => new Date(value).toISOString();
const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const unknownTime = (): EventTime => ({ kind: "unknown" });
const emptyScope = (): ResetEvent["scope"] => ({ type: "unknown", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null });

/** Updated-at and editorial data are excluded so applying a review does not invalidate itself. */
export function evidenceVersion(event: PublicV2EventRow, input: PublicV2Input): string {
  const { publicV2: _review, ...presentation } = event.presentation ?? {};
  const { updated_at: _updated, ...facts } = event;
  const links = input.links.filter(link => link.event_id === event.id).sort((a, b) => a.post_id.localeCompare(b.post_id));
  const ids = new Set(links.map(link => link.post_id));
  const posts = input.posts.filter(post => ids.has(post.id)).sort(byId);
  return sha256(stableJson({ event: { ...facts, presentation }, links, posts }));
}

export async function loadPublicV2Input(db: Db, allPosts = false): Promise<PublicV2Input> {
  const events = await db<PublicV2EventRow[]>`SELECT id,type,status,title,scope,label,display_label,schedule,estimate,presentation,
    confirmed_at,occurred_on,confirmation_basis,withdrawn,created_at,updated_at
    FROM monitor_events WHERE monitor_id=${monitorId()} ORDER BY id`;
  const links = await db<PublicV2LinkRow[]>`SELECT event_id,post_id,stage,action,text,original_text
    FROM monitor_event_posts WHERE monitor_id=${monitorId()} ORDER BY event_id,post_id`;
  const posts = await db<PublicV2PostRow[]>`SELECT id,author,published_at,text,url,translation,context,recognition
    FROM monitor_posts WHERE monitor_id=${monitorId()} AND ${allPosts ? db`true` : db`id=ANY(${links.map(link => link.post_id)}::text[])`} ORDER BY id`;
  return { events, links, posts };
}

const languages = ["en", "zh", "zh-Hant", "ja", "ko", "ru", "es"] as const;
export function properName(value: string) {
  return Object.fromEntries(languages.map(language => [language, value])) as Record<typeof languages[number], string>;
}
const kindNames = {
  direct_reset: ["Quota reset", "额度重置", "額度重置", "利用枠のリセット", "사용 한도 초기화", "Сброс лимита", "Restablecimiento de cuota"],
  reset_credit: ["Reset credit", "重置卡", "重置卡", "リセットクレジット", "초기화 크레딧", "Кредит на сброс", "Crédito de restablecimiento"],
  bonus_credit: ["Bonus credit", "奖励额度", "獎勵額度", "ボーナスクレジット", "보너스 크레딧", "Бонусный кредит", "Crédito adicional"],
};
const statusNames = {
  announced: ["announced", "已预告", "已預告", "発表済み", "발표됨", "объявлено", "anunciado"],
  in_progress: ["in progress", "进行中", "進行中", "実施中", "진행 중", "в процессе", "en curso"],
  completed: ["completed", "已完成", "已完成", "完了", "완료됨", "завершено", "completado"],
  available: ["available", "可领取", "可領取", "受取可能", "수령 가능", "доступно", "disponible"],
  claim_closed: ["claim closed", "领取已截止", "領取已截止", "受取受付終了", "수령 마감", "приём заявок закрыт", "solicitud cerrada"],
  expired: ["expired", "已到期", "已到期", "期限切れ", "만료됨", "истекло", "caducado"],
  cancelled: ["cancelled", "已取消", "已取消", "中止", "취소됨", "отменено", "cancelado"],
};
export function publicV2Title(product: string, type: ResetEvent["type"], status: ResetEvent["status"]) {
  return Object.fromEntries(languages.map((language, index) => [language, `${product}: ${kindNames[type][index]} · ${statusNames[status][index]}`])) as Record<typeof languages[number], string>;
}

function confirmationPublication(row: PublicV2EventRow, input: PublicV2Input) {
  // A persisted source_post confirmation and its confirm links are the official evidence.
  // Retired accounts remain valid historical sources; unrelated later replies are not nodes.
  const ids = new Set(input.links.filter(link => link.event_id === row.id && link.action === "confirm").map(link => link.post_id));
  return input.posts.filter(post => ids.has(post.id)).sort((a, b) => Date.parse(iso(a.published_at)) - Date.parse(iso(b.published_at)) || byId(a, b))[0];
}

/** Only explicit linked business statements can close a bonus; wall-clock time cannot. */
function bonusStatusStatement(text: string): ResetEvent["status"] | null {
  for (const sentence of text.match(/[^.!?\n;]+[.!?\n;]?/g) ?? []) {
    // A linked explanation can discuss a user's credit without closing the campaign.
    if (/\?|\b(?:if|unless|when|once|whenever|whether|assuming|suppose|would|could|might|will|tomorrow|not|never|your|my|their|his|her|individual)\b|\bmay\s+(?:be|have|expire|close|reopen)\b|n['’]t\b/i.test(sentence)) continue;
    const statement = sentence.trim();
    if (!/^(?:(?:the|this|our|that|one[ -]time)\s+)*(?:(?:bonus|promotional|cloud(?: session)?|promotion|credit|claim(?:ing)?|redemption)\b)|^we\s+(?:have\s+)?(?:closed|ended|reopened)\b/i.test(statement)) continue;
    if (/\b(?:bonus|promotional|cloud(?: session)?|promotion)\s+(?:credit\s+)?(?:has |have |is |now |already )*expired\b|\b(?:credit|bonus)\s+(?:has|have)\s+expired\b/i.test(statement)) return "expired";
    if (/\b(?:claim(?:ing)?|redemption)\s+(?:period\s+|window\s+)?(?:is |has |now |already )*(?:closed|ended)\b|^we\s+(?:have\s+)?(?:closed|ended)\s+(?:the\s+)?(?:claim(?:ing)?|redemption)\s+(?:period|window)\b/i.test(statement)) return "claim_closed";
    if (/\b(?:claim(?:ing)?|redemption)\s+(?:period\s+|window\s+)?(?:has |is )?reopened\b|\bbonus credit\b.{0,40}\b(?:is now|now) available\b|^we\s+(?:have\s+)?reopened\s+(?:the\s+)?(?:claim(?:ing)?|redemption)\s+(?:period|window)\b/i.test(statement)) return "available";
  }
  return null;
}

export function publicV2Status(row: PublicV2EventRow, input: PublicV2Input): ResetEvent["status"] {
  const confirmed = row.status === "confirmed" && row.confirmation_basis === "source_post";
  if (row.type !== "bonus_credit") return confirmed ? "completed" : row.presentation?.inProgress ? "in_progress" : "announced";
  if (!confirmed) return "announced";
  const ids = new Set(input.links.filter(link => link.event_id === row.id && ["confirm", "amend"].includes(link.action ?? "")).map(link => link.post_id));
  const posts = input.posts.filter(post => ids.has(post.id)).sort((a, b) => Date.parse(iso(b.published_at)) - Date.parse(iso(a.published_at)) || byId(a, b));
  for (const post of posts) {
    const status = bonusStatusStatement(post.text);
    if (status) return status;
  }
  return "available";
}

export function timeBoundary(time: EventTime): string | null {
  if (time.kind === "unknown") return null;
  if (time.kind === "date") return Temporal.PlainDate.from(time.date).toZonedDateTime(time.timeZone).toInstant().toString();
  return time.kind === "range" ? time.from : time.at;
}
function exactTime(event: ResetEvent): number | null {
  return event.time.kind === "instant" ? Date.parse(event.time.at) : null;
}
function eventDate(event: ResetEvent): string | null {
  if (event.time.kind === "date") return event.time.date;
  const at = timeBoundary(event.time);
  return at ? beijingDate(Date.parse(at)) : null;
}
function medianInterval(events: ResetEvent[]) {
  const times = events.map(exactTime).filter((time): time is number => time !== null).sort((a, b) => a - b);
  const intervals = times.slice(1).map((time, index) => (time - times[index]!) / 86_400_000).filter(value => value > 0).sort((a, b) => a - b);
  if (!intervals.length) return null;
  const middle = Math.floor(intervals.length / 2);
  return { value: intervals.length % 2 ? intervals[middle]! : (intervals[middle - 1]! + intervals[middle]!) / 2, unit: "day" as const, sampleCount: intervals.length };
}

/** Pure projection: no write, model, collection, clock-derived event state or v1 presentation. */
export function projectPublicV2(input: PublicV2Input, definition: ResetMonitorBackendDefinition, now = Date.now()): ResetSnapshot {
  const config = definition.publicV2;
  if (!config) throw new Error("Public v2 configuration is missing");
  const sourceMap = new Map<string, ResetSnapshot["sources"][number]>();
  for (const author of definition.authors) sourceMap.set(`x-account:${author.handle.toLowerCase()}`, {
    id: `x-account:${author.handle.toLowerCase()}`, type: "official_social", name: properName(author.name), url: `https://x.com/${author.handle}`,
  });
  const posts = new Map(input.posts.map(post => [post.id, post]));
  const events = input.events.filter(event => !event.withdrawn).map(row => {
    const links = input.links.filter(link => link.event_id === row.id).sort((a, b) => {
      const rank = (link: PublicV2LinkRow) => link.action === "announce" ? 0 : 1;
      return rank(a) - rank(b) || Date.parse(iso(posts.get(a.post_id)!.published_at)) - Date.parse(iso(posts.get(b.post_id)!.published_at)) || a.post_id.localeCompare(b.post_id);
    });
    const sourceIds = links.map(link => {
      const post = posts.get(link.post_id);
      if (!post) throw new Error("Public event references a missing post");
      const id = `x-post:${post.id}`;
      sourceMap.set(id, { id, type: "official_social", name: properName(`@${post.author} · ${iso(post.published_at).slice(0, 10)}`), url: post.url });
      return id;
    });
    const stored = row.presentation?.publicV2 === undefined ? null : reviewedEventSchema.parse(row.presentation.publicV2);
    const reviewed = stored?.evidenceVersion === evidenceVersion(row, input) ? stored : null;
    const confirmed = row.status === "confirmed" && row.confirmation_basis === "source_post";
    const status = reviewed?.status ?? publicV2Status(row, input);
    // occurred_on is an operator/source-recorded occurrence date, never a confirmation instant.
    let time: EventTime = reviewed?.time ?? (row.occurred_on && row.type !== "bonus_credit" ? { kind: "date", date: iso(row.occurred_on).slice(0, 10), timeZone: "Asia/Shanghai" } : unknownTime());
    if (time.kind === "unknown" && confirmed && ["completed", "available", "claim_closed", "expired"].includes(status)) {
      const confirmation = confirmationPublication(row, input);
      if (confirmation) {
        time = { kind: "instant", at: iso(confirmation.published_at) };
      }
    }
    return {
      id: row.id, type: row.type, status, publishedAt: stored?.publishedAt ?? iso(row.created_at),
      title: reviewed?.title ?? publicV2Title(definition.product, row.type, status), summary: reviewed?.summary ?? null, details: reviewed?.details ?? null,
      time, announcement: reviewed?.announcement ?? null, sourceIds, scope: reviewed?.scope ?? emptyScope(), bonusCredit: resolveBonusTimes(row, input, reviewed?.bonusCredit ?? null).bonusCredit,
    } satisfies ResetEvent;
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || byId(a, b));
  const completed = events.filter(event => event.type === "direct_reset" && event.status === "completed").sort((a, b) => {
    const order = (event: ResetEvent) => Date.parse(timeBoundary(event.time) ?? event.publishedAt);
    return order(b) - order(a) || byId(a, b);
  });
  const latest = completed[0];
  const anchor = latest ? exactTime(latest) : null;
  const forecastSamples = anchor === null ? [] : completed.filter(event => {
    const at = exactTime(event); return at !== null && at >= anchor - 90 * 86_400_000 && at <= anchor;
  });
  const forecastInterval = forecastSamples.length >= 3 ? medianInterval(forecastSamples) : null;
  const forecastAt = anchor !== null && forecastInterval ? new Date(anchor + forecastInterval.value * 86_400_000).toISOString() : null;
  const today = beijingDate(now), since = addDays(today, -29);
  const count = (type: ResetEvent["type"]) => {
    const eligible = events.filter(event => event.type === type && (type === "bonus_credit" ? ["available", "claim_closed", "expired"].includes(event.status) : event.status === "completed"));
    const start = Date.parse(`${since}T00:00:00+08:00`);
    // A confirmation is only an upper bound on occurrence, never its displayed time.
    // Recent undated completions prevent a fabricated zero or an understated count.
    if (eligible.some(event => {
      if (eventDate(event) !== null) return false;
      const row = input.events.find(row => row.id === event.id)!;
      return !row.confirmed_at || Date.parse(iso(row.confirmed_at)) >= start;
    })) return null;
    return eligible.filter(event => { const date = eventDate(event); return date !== null && date >= since && date <= today; }).length;
  };
  const marks: ResetSnapshot["calendar"]["marks"] = [];
  for (const event of events) {
    if (event.time.kind !== "unknown") marks.push({ id: `event:${event.id}`, eventId: event.id, kind: "event", time: event.time });
    for (const [key, kind] of [["claimDeadline", "claim_deadline"], ["expiresAt", "expiry"]] as const) {
      const time = event.bonusCredit?.[key];
      if (time && time.kind !== "unknown") marks.push({ id: `${kind}:${event.id}`, eventId: event.id, kind, time });
    }
  }
  const calendarDays = marks.flatMap(mark => {
    if (mark.time.kind === "date") return [mark.time.date];
    const boundary = timeBoundary(mark.time)!;
    const day = new Date(boundary).toISOString().slice(0, 10);
    return [addDays(day, -1), addDays(day, 1)];
  }).sort();
  const historyDays = events.map(eventDate).filter((date): date is string => date !== null).sort();
  const typical = medianInterval(completed.filter(event => {
    const at = exactTime(event); return at !== null && at >= now - 90 * 86_400_000 && at <= now;
  }));
  return resetSnapshotSchema.parse({
    schemaVersion: 2, platform: config.platform, generatedAt: new Date(now).toISOString(),
    sources: [...sourceMap.values()], catalog: config.catalog, events,
    overview: { latestDirectResetEventId: events.find(event => event.type === "direct_reset")?.id ?? null,
      latestCompletedResetEventId: latest?.id ?? null, statisticalForecast: forecastAt ? { time: { kind: "instant", at: forecastAt }, expiresAt: forecastAt } : null },
    statistics: { typicalInterval: typical, resetsLast30Days: count("direct_reset"), cardsLast30Days: count("reset_credit"), bonusesLast30Days: count("bonus_credit") },
    history: { range: historyDays.length ? { from: historyDays[0]!, through: historyDays.at(-1)! } : null, total: events.length, eventIds: events.map(event => event.id) },
    calendar: { range: calendarDays.length ? { from: calendarDays[0]!, through: calendarDays.at(-1)! } : null, marks },
  });
}

export async function publicV2Snapshot(now = Date.now()) {
  return sql.begin("isolation level repeatable read read only", async db => projectPublicV2(await loadPublicV2Input(db), monitor(), now));
}
