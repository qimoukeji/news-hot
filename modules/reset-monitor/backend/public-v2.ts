import { Temporal } from "@js-temporal/polyfill";
import { sql } from "@aihot/backend/db";
import { beijingDate, addDays } from "@aihot/contracts/time";
import { monitor, type ResetMonitorBackendDefinition } from "./context.ts";
import {
  resetSnapshotSchema,
  rawResetSnapshotSchema,
  rawEventUpdateSchema,
  businessTimeBoundary,
  compareBusinessTime,
  eventOrderTime,
  type ResetSnapshot,
  type ResetEvent,
  type PublicTime,
} from "../public-v2.ts";
import {
  reduceEvent,
  translated,
  type ActionInput,
  type EventRow,
  type ActionRow,
  type SourcePostRow,
  type EditorialScope,
} from "../actions.ts";
import { loadActionInput } from "./action-store.ts";
import { completeStandardScopeLabel, publicScopeLabel, scopeReadyForPublication } from "./scope-labels.ts";
import { editorialReady } from "./event-editorial.ts";
import { accountStatusSummary, quotaStatusTitle, cleanEventText } from "../public-text.ts";
export type PublicV2Input = ActionInput;
export type PublicV2EventRow = EventRow;
export type PublicV2PostRow = SourcePostRow;
export const loadPublicV2Input = loadActionInput;
const byId = <T extends { id: string }>(a: T, b: T) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export function publicV2Scope(
  scope?: EditorialScope | null,
): ResetEvent["scope"] {
  const { type, note } = scope ?? { type: "unknown", note: null };
  if (type === "selected_users" && !translated(note)) throw new Error("Selected users require translated eligibility");
  return { type, note: publicScopeLabel(type, completeStandardScopeLabel(note)) };
}
const languages = ["en", "zh", "zh-Hant", "ja", "ko", "ru", "es"] as const;
const unlinkedSummary = {
  en: "Confirmation recorded without an associated post.", zh: "已记录确认，尚无关联帖子。", "zh-Hant": "已記錄確認，尚無關聯帖子。",
  ja: "関連投稿のない確認記録です。", ko: "연결된 게시물 없이 기록된 확인입니다.",
  ru: "Подтверждение записано без связанной публикации.", es: "Confirmación registrada sin una publicación vinculada.",
};
export function properName(value: string) {
  return Object.fromEntries(
    languages.map((language) => [language, value]),
  ) as Record<(typeof languages)[number], string>;
}
const kindNames = {
  direct_reset: [
    "Quota reset",
    "额度重置",
    "額度重置",
    "利用枠のリセット",
    "사용 한도 초기화",
    "Сброс лимита",
    "Restablecimiento de cuota",
  ],
  reset_credit: [
    "Reset credit",
    "重置卡",
    "重置卡",
    "リセットクレジット",
    "초기화 크레딧",
    "Кредит на сброс",
    "Crédito de restablecimiento",
  ],
  bonus_credit: [
    "Bonus credit",
    "奖励额度",
    "獎勵額度",
    "ボーナスクレジット",
    "보너스 크레딧",
    "Бонусный кредит",
    "Crédito adicional",
  ],
};
const statusNames = {
  announced: [
    "announced",
    "已预告",
    "已預告",
    "発表済み",
    "발표됨",
    "объявлено",
    "anunciado",
  ],
  in_progress: [
    "in progress",
    "进行中",
    "進行中",
    "実施中",
    "진행 중",
    "в процессе",
    "en curso",
  ],
  completed: [
    "completed",
    "已完成",
    "已完成",
    "完了",
    "완료됨",
    "завершено",
    "completado",
  ],
  cancelled: [
    "cancelled",
    "已取消",
    "已取消",
    "中止",
    "취소됨",
    "отменено",
    "cancelado",
  ],
};
export function publicV2Title(
  product: string,
  type: ResetEvent["type"],
  status: ResetEvent["status"],
) {
  return Object.fromEntries(
    languages.map((language, index) => [
      language,
      `${product}: ${kindNames[type][index]} · ${statusNames[status][index]}`,
    ]),
  ) as Record<(typeof languages)[number], string>;
}
export function publicV2EventTitle(product: string, row: Pick<EventRow, "type" | "title">, latest: ActionRow | undefined, status: ResetEvent["status"]) {
  return translated(row.title) ? row.title
    : row.title === null && latest && translated(latest.title) ? latest.title
      : publicV2Title(product, row.type, status);
}
export function publicV2ActionTitle(
  product: string,
  type: ResetEvent["type"],
  action: ResetEvent["updates"][number]["action"],
) {
  const names = {
    announce: [
      "Announcement",
      "预告",
      "預告",
      "予告",
      "예고",
      "Анонс",
      "Anuncio",
    ],
    confirm: [
      "Confirmation",
      "确认",
      "確認",
      "確認",
      "확인",
      "Подтверждение",
      "Confirmación",
    ],
    progress: [
      "Progress",
      "进展",
      "進展",
      "進捗",
      "진행 상황",
      "Ход выполнения",
      "Avance",
    ],
    amend: [
      "Amendment",
      "修订",
      "修訂",
      "修正",
      "수정",
      "Изменение",
      "Modificación",
    ],
  };
  return Object.fromEntries(
    languages.map((language, index) => [
      language,
      `${product}: ${kindNames[type][index]} · ${names[action][index]}`,
    ]),
  ) as ResetEvent["title"];
}

export function timeBoundary(time: PublicTime): string {
  return businessTimeBoundary(time);
}
function exactTime(event: { time: PublicTime }): number | null {
  return event.time?.kind === "instant" ? Date.parse(event.time.at) : null;
}
function eventDate(event: { time: PublicTime }): string {
  return beijingDate(businessTimeBoundary(event.time));
}
function medianInterval(events: Array<{ time: PublicTime }>) {
  const times = events
    .map(exactTime)
    .filter((time): time is number => time !== null)
    .sort((a, b) => a - b);
  const intervals = times
    .slice(1)
    .map((time, index) => (time - times[index]!) / 86_400_000)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  if (!intervals.length) return null;
  const middle = Math.floor(intervals.length / 2);
  return {
    value:
      intervals.length % 2
        ? intervals[middle]!
        : (intervals[middle - 1]! + intervals[middle]!) / 2,
    unit: "day" as const,
    sampleCount: intervals.length,
  };
}

function predictedTime(time: string | null, interval: number | null): string | null {
  if (time === null || interval === null) return null;
  const milliseconds = Math.round(interval * 86_400_000);
  return Temporal.Instant.from(time).add({ milliseconds }).toString();
}

export function publicV2Sources(
  definition: ResetMonitorBackendDefinition,
): ResetSnapshot["sources"] {
  return definition.authors.map((author) => ({
    id: `x-account:${author.handle.toLowerCase()}`,
    type: "official_social",
    name: properName(author.name),
    url: `https://x.com/${author.handle}`,
  }));
}

/** Every public outlet uses the same action reducer. Reads never invoke a model. */
export function projectRawV2(
  input: ActionInput,
  definition: ResetMonitorBackendDefinition,
  now = Date.now(),
): ResetSnapshot {
  if (!definition.publicV2)
    throw new Error("Public v2 configuration is missing");
  const config = definition.publicV2;
  const sourceMap = new Map(
    publicV2Sources(definition).map((source) => [source.id, source]),
  );
  const facts = new Map<string, NonNullable<ReturnType<typeof reduceEvent>>>();
  const events: ResetEvent[] = input.events
    .filter((event) => !event.withdrawn)
    .flatMap((row) => {
      const reduced = reduceEvent(row, input);
      if (!reduced) return [];
      const { status, time, publishedAt, actions } = reduced;
      if (!scopeReadyForPublication(reduced.scope)) return [];
      const scope = publicV2Scope(reduced.scope);
      facts.set(row.id, reduced);
      const updates = actions
        .map(({ action, posts, publishedAt }) => rawEventUpdateSchema.parse({
          id: action.id,
          action: action.action,
          invalidatesEvent: action.invalidates_event,
          publishedAt,
          time: action.time,
          title: action.sources.length === 0 ? { ...publicV2ActionTitle(definition.product, row.type, action.action), ...action.title } : translated(action.title)
            ? action.title
            : publicV2ActionTitle(definition.product, row.type, action.action),
          summary: action.sources.length === 0 && action.summary ? { ...unlinkedSummary, ...action.summary } : translated(action.summary) ? action.summary : null,
          sources: posts.map((post) => {
            const sourceId = `x-account:${post.author.toLowerCase()}`;
            if (!sourceMap.has(sourceId))
              sourceMap.set(sourceId, {
                id: sourceId,
                type: "official_social",
                name: properName(`@${post.author}`),
                url: `https://x.com/${post.author}`,
              });
            return { postId: post.id, sourceId, url: post.url };
          }),
        }))
        .sort(
          (a, b) =>
            Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || byId(a, b),
        );
      const latest = actions.at(-1)?.action;
      return [
        {
          id: row.id,
          type: row.type,
          status,
          publishedAt,
          title: publicV2EventTitle(definition.product, row, latest, status),
          summary: translated(row.summary) ? row.summary : null,
          time,
          updates,
          scope,
        },
      ];
    })
    .sort(
      (a, b) =>
        compareBusinessTime(eventOrderTime(b), eventOrderTime(a)) ||
        byId(a, b),
    );
  const completed = events.flatMap(event => {
    const time = facts.get(event.id)!.confirmedTime;
    return event.status === "completed" && time !== null ? [{ id: event.id, type: event.type, time }] : [];
  }).sort((a, b) => compareBusinessTime(b.time, a.time) || byId(a, b));
  const latestConfirmation = completed[0]?.time;
  const resetTime = latestConfirmation?.kind === "instant" ? latestConfirmation.at : null;
  const latest = events.filter(event => event.status !== "cancelled")
    .sort((a, b) => {
      const latestSource = (event: ResetEvent) => facts.get(event.id)!.actions.at(-1)?.publishedAt ?? event.publishedAt;
      return Date.parse(latestSource(b)) - Date.parse(latestSource(a))
        || Number(b.status === "announced") - Number(a.status === "announced")
        || Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || byId(a, b);
    })[0];
  const today = beijingDate(now),
    since = addDays(today, -29);
  const count = (type: ResetEvent["type"]) => {
    const eligible = completed.filter(event => event.type === type);
    return eligible.filter((event) => {
      const date = eventDate(event);
      return date >= since && date <= today;
    }).length;
  };
  const typical = medianInterval(
    completed.filter((event) => {
      const at = exactTime(event);
      return at !== null && at >= now - 90 * 86_400_000 && at <= now;
    }),
  );
  return rawResetSnapshotSchema.parse({
    schemaVersion: 2,
    platform: config.platform,
    generatedAt: new Date(now).toISOString(),
    sources: [...sourceMap.values()],
    events,
    predictedResetTime: predictedTime(resetTime, typical?.value ?? null),
    hasAnnouncement: latest?.status === "announced",
    announcedResetTime: latest?.status === "announced" ? facts.get(latest.id)!.announcedTime : null,
    resetTime,
    statistics: {
      typicalInterval: typical,
      resetsLast30Days: count("direct_reset"),
      cardsLast30Days: count("reset_credit"),
      bonusesLast30Days: count("bonus_credit"),
    },
  });
}

/** Clean public editorial text without changing business-time precision. */
function publishEvent(event: ResetEvent, product: string): ResetEvent {
  const cleaned = cleanEventText(event, publicV2Title(product, event.type, event.status), update => publicV2ActionTitle(product, event.type, update.action));
  const unsourced = event.status === "completed" && event.updates.some(update => update.action === "confirm")
    && !event.updates.some(update => update.action === "confirm" && update.sources.length > 0);
  const title = !unsourced ? cleaned.title
    : Object.fromEntries(languages.map(language => [language, `${product}: ${quotaStatusTitle[language]}`])) as ResetEvent["title"];
  return { ...cleaned, title, summary: unsourced ? accountStatusSummary : cleaned.summary,
    updates: cleaned.updates };
}

export function projectPublicV2(input: ActionInput, definition: ResetMonitorBackendDefinition, now = Date.now()): ResetSnapshot {
  const snapshot = projectRawV2(input, definition, now);
  return resetSnapshotSchema.parse({ ...snapshot,
    announcedResetTime: snapshot.announcedResetTime,
    events: snapshot.events.map(event => {
      const row = input.events.find(row => row.id === event.id)!;
      const ready = editorialReady(row, input);
      return publishEvent({ ...event,
        title: ready && translated(row.title) ? row.title : publicV2Title(definition.product, row.type, event.status),
        summary: ready && translated(row.summary) ? row.summary : null,
      }, definition.product);
    }),
  });
}

export async function publicV2Snapshot(now = Date.now()) {
  return sql.begin("isolation level repeatable read read only", async (db) =>
    projectPublicV2(await loadActionInput(db), monitor(), now),
  );
}
