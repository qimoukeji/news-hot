import { MonitorProvider, useMonitor, type ResetMonitorWebProfile } from "./context.tsx";
import { useLoaderData } from "react-router";
import { useState } from "react";
import type { EventList, PlatformOverview } from "../public-v2.ts";
import { SITE } from "@aihot/site";
import type { ResetMonitorPageData } from "./loaders.server.ts";
import { pageMeta } from "@aihot/web/lib/seo";
import { ResetCalendar } from "./components/ResetCalendar.tsx";
import { eventDate, stamp, text } from "./components/format.ts";
import { EventActionRow, EventCardFrame } from "./components/EventCard.tsx";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { IconArrowUpRight, IconCalendar, IconChart, IconLink } from "@aihot/web/components/icons";

export function createPublicPage(profile: ResetMonitorWebProfile) {
  const title = `${profile.product} 今天会重置吗？`;
  return {
    handle: { tab: "me", name: title } satisfies Screen,
    meta: () => pageMeta({ title, description: profile.description, path: profile.pagePath }),
    default: function ResetMonitorRoute() {
      return <MonitorProvider profile={profile}><ResetMonitorPage /></MonitorProvider>;
    },
  };
}

function EventCard({ event, overview }: { event: EventList["list"][number]; overview: PlatformOverview }) {
  const sources = new Map(overview.sources.map(source => [source.id, source]));
  return <EventCardFrame event={event} catalog={overview.catalog}>
    <ol className="mt-4 space-y-4 border-t border-line pt-4" aria-label="事件动作">
      {event.updates.map(update => <EventActionRow key={update.id} action={update}>
            <ul className="max-w-[40%] shrink-0 space-y-1 text-right text-[12px] leading-5">
              {!update.sources.length && <li className="text-ink-4">无关联帖子</li>}
              {update.sources.map(source => {
                const name = text(sources.get(source.sourceId)?.name) || source.sourceId;
                return <li key={source.postId}><a className="break-words text-accent hover:underline" href={source.url} target="_blank" rel="noreferrer" aria-label={`${name} · 原帖 ↗`} title={`${name} · 原帖`}><span className="hidden sm:inline">{name} · </span>原帖 ↗</a></li>;
              })}
            </ul>
      </EventActionRow>)}
    </ol>
  </EventCardFrame>;
}

function MonthEvents({ overview, events, selectedDate: initialDate, month, today }: ResetMonitorPageData) {
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [visibleCount, setVisibleCount] = useState(3);
  const selected = selectedDate ? events.filter(event => eventDate(event.time) === selectedDate) : events;
  const visible = selected.slice(0, visibleCount);
  const dateLabel = `${Number(month.slice(5, 7))} 月${selectedDate ? ` ${Number(selectedDate.slice(8, 10))} 日` : ""}`;
  const selectDate = (date: string | null) => {
    setSelectedDate(date === selectedDate ? null : date);
    setVisibleCount(3);
  };
  return <section className="mt-6" aria-label="重置日历">
    <h2 className="mb-4 text-[18px] font-semibold text-ink">重置日历</h2>
    <div className="grid items-start gap-5 lg:grid-cols-[280px_1fr]">
    <ResetCalendar events={events} month={month} selectedDate={selectedDate} today={today} onSelectDate={selectDate} />
    <section className="min-w-0" aria-label="事件列表">
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-line pb-4">
        <h3 className="text-[16px] font-semibold text-ink">{dateLabel}</h3>
        <div className="flex items-center gap-4">
          {selectedDate && <button type="button" className="text-[12px] text-accent" onClick={() => selectDate(null)}>查看整月</button>}
          <span className="num text-[12px] text-ink-4">{month.slice(0, 4)}</span>
        </div>
      </div>
      <div className="space-y-4">{visible.length ? visible.map(event => <EventCard key={event.id} event={event} overview={overview} />) : <p className="rounded-card border border-line p-5 text-[13px] text-ink-4">这段时间没有已收录的事件。</p>}</div>
      {visible.length < selected.length && <button type="button" className="mt-4 w-full rounded-full border border-line px-4 py-2 text-[13px] text-accent hover:bg-bg-sunk" onClick={() => setVisibleCount(count => count + 10)}>显示更多</button>}
    </section>
    </div>
  </section>;
}

function overviewTime(value: string | null, dateOnly = false): string | null {
  if (!value) return null;
  return value.split("/").map(at => {
    const day = eventDate(at);
    const date = `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
    return dateOnly || at.length === 10 ? date : `${date} ${stamp(at).slice(11)}`;
  }).join(" – ");
}

function ResetMonitorPage() {
  const profile = useMonitor();
  const data = useLoaderData<ResetMonitorPageData>();
  const { overview } = data;
  const title = `${profile.product} 今天会重置吗？`;
  const accounts = profile.authors.map(author => `@${author.handle}`).join("、");
  const interval = overview.statistics.typicalInterval;
  const timeLabel = overview.announcedResetTime ? "公开预告" : "预估时间";
  const displayTime = overview.announcedResetTime ?? overview.predictedResetTime;
  return <div className="pb-8">
    <PhoneBar back={{ to: "/more", label: "我的" }} title={title} />
    <header className="pb-5 pt-3 lg:pt-1">
      <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">{title}</h1>
      <p className="mt-2 text-[13px] text-ink-3">关注 {accounts} 发布的消息，筛选重置信号，推送提醒，省得你反复刷推</p>
      <p className="mt-1 text-[12px] text-ink-4">全部时间按北京时间显示 · UTC+8</p>
    </header>
    <section aria-label={timeLabel} className="rounded-sheet border border-line-strong bg-surface p-5 sm:p-6">
      <h2 className="text-[12px] font-medium text-ink-3">{timeLabel}</h2>
      <p className="num mt-4 text-[36px] font-semibold leading-tight tracking-tight text-ink sm:text-[44px]">{overviewTime(displayTime, true) ?? "暂无预估"}</p>
      <p className="mt-5 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-4">公共重置事件与历史间隔不代表你的账户恢复时间。</p>
    </section>
    <dl aria-label="重置概览" className="mt-4 grid divide-y divide-line overflow-hidden rounded-sheet border border-line-strong bg-surface sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <div className="flex min-w-0 items-center gap-4 px-5 py-5 sm:px-6 sm:py-6">
        <IconCalendar size={22} className="shrink-0 text-ink-2" />
        <div className="min-w-0"><dt className="text-[12px] text-ink-4">最近重置</dt><dd className="num mt-2 text-[18px] font-semibold text-ink">{overviewTime(overview.resetTime) ?? "暂无记录"}</dd></div>
      </div>
      <div className="flex min-w-0 items-center gap-4 px-5 py-5 sm:px-6 sm:py-6">
        <IconChart size={22} className="shrink-0 text-ink-2" />
        <div className="min-w-0"><dt className="text-[12px] text-ink-4">重置间隔</dt><dd className="num mt-2 text-[18px] font-semibold text-ink">{interval ? `${Number(interval.value.toFixed(2))} ${interval.unit === "day" ? "天" : "小时"}` : "暂无数据"}</dd></div>
      </div>
      <div className="flex min-w-0 items-center gap-4 px-5 py-5 sm:px-6 sm:py-6">
        <IconLink size={22} className="shrink-0 text-ink-2" />
        <div className="min-w-0"><dt className="text-[12px] text-ink-4">来源账号</dt><dd className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[18px] font-semibold text-ink">
          {overview.sources.length ? overview.sources.map(source => <a key={source.id} href={source.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 break-words hover:text-accent"><span className="min-w-0 break-words">{text(source.name)}</span><IconArrowUpRight size={14} className="shrink-0" /></a>) : "暂无来源"}
        </dd></div>
      </div>
    </dl>
    <MonthEvents key={`${profile.pagePath}:${data.month}:${data.selectedDate ?? ""}`} {...data} />
    <footer className="mt-6 border-t border-line py-4 text-[12px] text-ink-4">{SITE.name} 整理 · 非 {profile.organization} 官方页面</footer>
  </div>;
}
