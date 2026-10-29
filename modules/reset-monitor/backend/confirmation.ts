import { Temporal } from "@js-temporal/polyfill";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { reduceEvent, type ActionInput, type ActionRow, type EventRow } from "../actions.ts";
import { normalizePublicTime } from "../public-v2.ts";

export const inferredConfirmationTitle = {
  en: "The announced time has arrived", zh: "已到预告时间", "zh-Hant": "已到預告時間",
  ja: "予告時刻になりました", ko: "예고된 시간이 되었습니다",
  ru: "Объявленное время наступило", es: "Ha llegado la hora anunciada",
};
export const inferredConfirmationSummary = {
  en: "The announced time has arrived. Check your account for the actual reset status.",
  zh: "预告时间已到，实际重置状态以账户显示为准",
  "zh-Hant": "預告時間已到，實際重置狀態以帳戶顯示為準",
  ja: "予告時刻になりました。実際のリセット状況はアカウントの表示をご確認ください。",
  ko: "예고된 시간이 되었습니다. 실제 초기화 상태는 계정에 표시된 내용을 확인하세요.",
  ru: "Объявленное время наступило. Фактический статус сброса проверяйте в своём аккаунте.",
  es: "Ha llegado la hora anunciada. Consulta tu cuenta para comprobar el estado real del restablecimiento.",
};

/** The current plan comes only from official actions with explicit business time. */
export function announcementBasis(event: EventRow, input: ActionInput) {
  const official = reduceEvent(event, { ...input, actions: input.actions.filter(action => action.sources.length) });
  if (!official) return null;
  let plan: string | null = null;
  const revisions: Array<{ id: string; action: string; time: string | null }> = [];
  for (const { action } of official.actions) {
    if (action.action === "announce" || action.invalidates_event || action.action === "amend" && action.time !== null) {
      revisions.push({ id: action.id, action: action.invalidates_event ? "cancel" : action.action, time: action.time });
      if (action.invalidates_event) plan = null;
      else if (action.action === "announce") plan = action.time;
      else if (["announced", "in_progress"].includes(official.status)) plan = action.time;
    }
  }
  return { official, plan: plan ? normalizePublicTime(plan) : null, version: sha256(stableJson(revisions)) };
}

export function inferenceBoundary(time: string): number {
  if (time.length === 10) return Temporal.PlainDate.from(time).add({ days: 1 }).toZonedDateTime("Asia/Shanghai").epochMilliseconds;
  return Date.parse(time.split("/").at(-1)!);
}

/** A minute task persists this action; reading a page never manufactures timeline nodes. */
export function inferredConfirmation(event: EventRow, input: ActionInput, now = Date.now()): ActionRow | null {
  if (event.withdrawn || reduceEvent(event, input)?.status !== "announced") return null;
  const basis = announcementBasis(event, input);
  if (!basis || basis.official.status !== "announced" || !basis.plan || inferenceBoundary(basis.plan) > now
    || basis.official.actions.some(update => update.posts.some(post => post.processing_status === "needs_attention"))) return null;
  const id = `inferred-${sha256(stableJson({ event: event.id, plan: basis.version }))}`;
  if (input.actions.some(action => action.id === id)) return null;
  return { id, event_id: event.id, action: "confirm", invalidates_event: false,
    title: { ...inferredConfirmationTitle },
    summary: { ...inferredConfirmationSummary }, time: basis.plan, sources: [],
    sequence: Math.max(0, ...input.actions.filter(action => action.event_id === event.id).map(action => action.sequence)) + 1,
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() };
}
