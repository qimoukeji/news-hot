import { useSyncExternalStore } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { PlatformOverview } from "../../public-v2.ts";
import { formatBusinessTime } from "../../business-time.ts";
import { forecastTime } from "./format.ts";

function subscribeClock(update: () => void) {
  const interval = setInterval(update, 30_000);
  window.addEventListener("focus", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    clearInterval(interval);
    window.removeEventListener("focus", update);
    document.removeEventListener("visibilitychange", update);
  };
}

export function ResetForecast({ overview, initialNow }: { overview: Pick<PlatformOverview, "hasAnnouncement" | "announcedResetTime" | "predictedResetTime">; initialNow: number }) {
  const now = useSyncExternalStore(subscribeClock, () => Math.floor(Date.now() / 30_000) * 30_000, () => initialNow);
  const state = overview.hasAnnouncement ? "announced" : overview.predictedResetTime ? "estimated" : "missing";
  const label = state === "announced" ? "公开预告" : "预估时间";
  const time = state === "announced" ? overview.announcedResetTime : overview.predictedResetTime ? { kind: "instant" as const, at: overview.predictedResetTime } : null;
  const expired = state === "estimated" && overview.predictedResetTime !== null
    && Temporal.Instant.compare(overview.predictedResetTime, Temporal.Instant.fromEpochMilliseconds(now)) < 0;
  return <section aria-label={label} data-forecast-state={state} className="rounded-sheet border border-line-strong bg-surface p-5 sm:p-6">
    <h2 className="text-[12px] font-medium text-ink-3">{label}</h2>
    <p title={time ? formatBusinessTime(time) : undefined} className="num mt-4 break-keep text-balance text-[30px] font-semibold leading-tight tracking-tight text-ink sm:text-[44px]">{time ? forecastTime(time, state === "announced", now) : state === "announced" ? "时间未公布" : "暂无数据"}</p>
    {state === "announced" && time?.kind === "range" && <p className="num mt-2 break-words text-[13px] leading-relaxed text-ink-3">{formatBusinessTime(time)}</p>}
    {expired && <p role="status" className="mt-2 text-[12px] text-ink-4">已过预估时间</p>}
    <p className="mt-5 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-4">公共重置事件与历史间隔不代表你的账户恢复时间。</p>
  </section>;
}
