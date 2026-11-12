import { Temporal } from "@js-temporal/polyfill";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { reduceEvent, type ActionInput, type ActionRow, type EventRow } from "../actions.ts";
import type { BusinessTime } from "../public-v2.ts";

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

/** Only active announcements supply a completion boundary. */
export function announcementBasis(event: EventRow, input: ActionInput) {
  const official = reduceEvent(event, { ...input, actions: input.actions.filter(action => action.sources.length) });
  if (!official) return null;
  let plan: BusinessTime | null = null;
  const revisions: Array<{ id: string; action: string; time: BusinessTime }> = [];
  for (const { action } of official.actions) {
    if (action.action === "announce" || action.invalidates_event) {
      revisions.push({ id: action.id, action: action.invalidates_event ? "cancel" : action.action, time: action.time });
      if (action.invalidates_event) plan = null;
      else if (action.action === "announce") plan = action.time;
    }
  }
  return { official, plan, version: sha256(stableJson(revisions)) };
}

export function inferredConfirmationTime(time: BusinessTime): Extract<BusinessTime, { kind: "instant" }> {
  const at = time.kind === "range" ? time.through : time.at;
  return { kind: "instant", at: at.endsWith("Z") ? at : Temporal.Instant.from(at).toString() };
}

export function inferenceBoundary(time: BusinessTime): number {
  const nanos = Temporal.Instant.from(inferredConfirmationTime(time).at).epochNanoseconds;
  return Number(nanos / 1_000_000n + (nanos % 1_000_000n > 0n ? 1n : 0n));
}

/** A minute task persists this action; reading a page never manufactures timeline nodes. */
export function inferredConfirmation(event: EventRow, input: ActionInput, now = Date.now()): ActionRow | null {
  if (event.withdrawn || reduceEvent(event, input)?.status !== "announced") return null;
  const basis = announcementBasis(event, input);
  if (!basis || basis.official.status !== "announced" || !basis.plan || inferenceBoundary(basis.plan) > now
    || basis.official.actions.some(update => update.posts.some(post => post.processing_status === "needs_attention"))) return null;
  let id = `inferred-${sha256(stableJson({ event: event.id, plan: basis.version }))}`;
  while (input.invalidatedInferenceIds?.has(id)) id = `inferred-${sha256(id)}`;
  if (input.actions.some(action => action.id === id)) return null;
  return { id, event_id: event.id, action: "confirm", invalidates_event: false,
    title: { ...inferredConfirmationTitle },
    summary: { ...inferredConfirmationSummary }, time: inferredConfirmationTime(basis.plan), sources: [],
    sequence: Math.max(0, ...input.actions.filter(action => action.event_id === event.id).map(action => action.sequence)) + 1,
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() };
}
