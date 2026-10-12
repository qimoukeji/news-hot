import "./style.css";
import { MonitorProvider, useMonitor, type ResetMonitorWebProfile } from "./context.tsx";
import { useEffect, useState } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import type { ResetMonitorEvent, ResetMonitorSitePage, ResetMonitorVersion } from "../contracts.ts";
import { SITE } from "@aihot/site";
import type { ResetMonitorPageData } from "./loaders.server.ts";
import { pageMeta } from "@aihot/web/lib/seo";
import { PostCard } from "./components/PostCard";
import { ResetCalendar } from "./components/ResetCalendar";
import { bjDate, bjTime, bonusStatus, dayWord, durationText, eventTimePolicy, sourceName, stamp, typeName, windowText } from "./components/format";
import { BonusCreditDetails } from "./components/BonusCreditDetails";
import { quotaScopeLabel } from "../quota-scope.ts";
import { monthDay } from "@aihot/web/lib/format";
import { IconChevronDown, IconChevronRight } from "@aihot/web/components/icons";
import { useEntrance } from "@aihot/web/lib/hydration";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";

export function createPublicPage(profile: ResetMonitorWebProfile) {
  const title = profile.title ?? `${profile.product} 重置监控`;
  return {
    handle: { tab: "me", name: title } satisfies Screen,
    meta: () => pageMeta({ title, description: profile.description, path: profile.pagePath }),
    default: function ResetMonitorRoute() {
      const data = useLoaderData<ResetMonitorPageData>();
      const liveProfile = data.monitor?.authors?.length ? { ...profile, authors: data.monitor.authors } : profile;
      return <MonitorProvider profile={liveProfile}><ResetMonitorPage /></MonitorProvider>;
    },
  };
}

const POLL_MS = 60_000;

/**
 * Low-frequency version check while the page is in the foreground. A new version (events, statuses,
 * the outage and its recovery) or a new day reloads the page data; a newer check alone only moves the
 * "最近检查" time, without reading everything again.
 */
function useVersionPolling(version: string, today: string, onChecked: (checkedAt: string | null) => void) {
  const { siteApiPath } = useMonitor();
  const revalidator = useRevalidator();
  useEffect(() => {
    let stopped = false;
    let request: AbortController | null = null;
    const tick = async () => {
      if (document.visibilityState !== "visible" || request) return;
      request = new AbortController();
      try {
        const res = await fetch(`${siteApiPath}/version`, { cache: "no-store", signal: request.signal });
        if (!res.ok) return;
        const v = (await res.json()) as ResetMonitorVersion;
        if (stopped) return;
        if (v.version !== version || v.today !== today) revalidator.revalidate();
        else onChecked(v.checkedAt);
      } catch {
        // offline: try again next tick
      } finally {
        request = null;
      }
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      request?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [version, today, revalidator, siteApiPath]);
}

function scopeText(e: ResetMonitorEvent) {
  const who = e.presentation?.audienceZh ?? e.presentation?.scopeLabel ?? "原帖未说明适用范围";
  return [who, e.presentation?.productsZh, quotaScopeLabel(e.presentation?.quotaScope)].filter(Boolean).join(" · ");
}

/** The current announcement and its source evidence. */
function Hero({ d, now }: { d: ResetMonitorSitePage; now: number }) {
  const profile = useMonitor();
  const { product } = profile;
  const e = d.current;
  const entrance = useEntrance();
  const shell = "cr-wash grid items-center gap-5 rounded-sheet border border-line-strong p-4 sm:p-6 lg:grid-cols-2 lg:gap-8 lg:p-8";
  if (!e) {
    const last = d.lastLanded;
    const lastDate = last?.occurredOn ? `${monthDay(last.occurredOn)}到账`
      : last?.confirmedAt ? `${monthDay(bjDate(last.confirmedAt))}确认` : "到账日期未确定";
    return (
      <section className={shell} style={{ "--tone": last ? "var(--ok-ink)" : "var(--ink-4)" } as React.CSSProperties}>
        <div className="min-w-0">
          <p className={`inline-flex items-center gap-2 text-[13px] font-medium ${last ? "text-ok-ink" : "text-ink-4"}`}>
            <span className="cr-dot" aria-hidden="true" />
            记录中没有等待生效的重置
          </p>
          <h2 className="mt-3 text-[20px] font-[650] leading-[1.25] text-ink sm:text-[24px]">
            {last?.status === "confirmed"
              ? `上一次${last.type === "reset_credit" ? "重置卡发放" : "额度重置"}：${lastDate}`
              : last?.title ?? "暂无重置记录"}
          </h2>
          <p className="mt-2 text-[13px] leading-[1.75] text-ink-4">
            {last?.confirmedAt && !last.occurredOn && "确认帖日期不代表精确到账时间。"}
            {last?.confirmationBasis === "receipt_review"
              ? "已通过账户核验。尚未收录官方对本轮的完成确认，实际到账时间以账户显示为准。"
              : "不预测尚未宣布的下一次重置。官方一旦宣布，这里会显示原帖与时间依据。"}
          </p>
          {d.outage && (
            <p className="mt-4 border-t border-line pt-4 text-[13px] leading-[1.75] text-ink-3">
              线索：{dayWord(bjDate(d.outage.publishedAt!), d.today)} {bjTime(d.outage.publishedAt!)} {sourceName(d.outage.author, profile)} 确认 {product} 故障
              {d.outage.recoveredAt ? `，${bjTime(d.outage.recoveredAt)} 恢复` : ""}。故障不等于重置。
            </p>
          )}
        </div>
        {last?.posts[0] && (
          <div className="min-w-0">
            <PostCard
              avatar={d.authorAvatar}
              stage={`${last.posts[0].stage}原帖`}
              post={{ id: last.posts[0].id, author: last.posts[0].author, authorAvatar: last.posts[0].authorAvatar, publishedAt: last.posts[0].publishedAt, translation: last.posts[0].fullText ?? last.posts[0].text, original: last.posts[0].fullOriginalText ?? last.posts[0].originalText, context: last.posts[0].context, url: last.posts[0].url }}
            />
          </div>
        )}
      </section>
    );
  }
  const timePolicy = eventTimePolicy(e, profile);
  const authorName = sourceName(e.posts[0]?.author, profile);
  const timeLabel = timePolicy === "predicted" ? "预计" : "原帖时间";
  const status = e.presentation?.status ?? "announced";
  const window = timePolicy === "explicit" ? e.schedule : e.estimate ?? e.schedule;
  const estimateReason = timePolicy === "predicted" ? e.estimate?.reason : null;
  const through = window?.through ? Date.parse(window.through) : null;
  const from = window?.from ? Date.parse(window.from) : null;
  const credit = e.type === "reset_credit";
  const headline = status === "in_progress" ? (credit ? "重置卡正在发放" : "额度重置正在进行") : credit ? "等待重置卡到账" : "等待额度重置生效";
  let timing: string | null = null;
  if (status === "expired_unconfirmed" && through) timing = `已比${timeLabel}晚 ${durationText(now - through)}，仍在等待确认`;
  else if (status === "announced" && from && now < from) timing = `距${timeLabel}还有 ${durationText(from - now)}`;
  else if (status === "announced" && through && now < through) timing = `正处在${timeLabel}段内`;
  else if (status === "in_progress" && e.presentation?.reportedAt) timing = `${authorName} ${stamp(e.presentation.reportedAt)} 表示正在进行`;
  const outage = d.outage && d.outage.resetEventId === e.id ? d.outage : null;
  const post = e.posts[0];
  return (
    <section
      className={`${shell} ${entrance ? "animate-fade-up" : ""}`}
      style={{ "--tone": status === "expired_unconfirmed" ? "var(--hot)" : "var(--amber-ink)" } as React.CSSProperties}
    >
      <div className="min-w-0">
        <p className={`inline-flex items-center gap-2 text-[13px] font-medium ${status === "expired_unconfirmed" ? "text-hot" : "text-amber-ink"}`}>
          <span className="cr-dot cr-dot-live" aria-hidden="true" />
          {typeName(e.type, product)} · {authorName} 已宣布
        </p>
        <h2 className="mt-3 text-[20px] font-[650] leading-[1.25] text-ink sm:text-[24px]">{headline}</h2>
        {window?.from && (
          <p className="num mt-4 text-[24px] font-[650] leading-[1.3] tracking-[-0.01em] text-amber-ink lg:text-[clamp(24px,2.6vw,32px)]">
            {timeLabel} {windowText(window.from, window.through, d.today).replace("–", " – ")}
          </p>
        )}
        {!window?.from && <p className="mt-4 text-[15px] text-ink-3">时间未说明</p>}
        {(timing || estimateReason) && (
          <p className="mt-2 text-[13px] leading-[1.75] text-ink-4">
            {timing}
            {timing && estimateReason ? " · " : ""}
            {estimateReason}
          </p>
        )}
        <ul className="mt-4 grid gap-2 border-t border-line pt-4 text-[13px] leading-[1.75] text-ink-3">
          <li>适用范围：{scopeText(e)}</li>
          {outage?.publishedAt && (
            <li>
              起因：{dayWord(bjDate(outage.publishedAt), d.today)} {bjTime(outage.publishedAt)} {sourceName(outage.author, profile)} 确认 {product} 故障{outage.recoveredAt ? `，${bjTime(outage.recoveredAt)} 恢复` : ""}
            </li>
          )}
        </ul>
        <p className="mt-4 text-[13px] leading-[1.75] text-ink-3">
          {credit ? `重置卡到账后由你自己决定何时使用。卡片余额以 ${product} 内显示为准。` : (timePolicy === "predicted" ? `剩余额度可以放心用，生效后会恢复满额。以你 ${product} 里显示的用量为准。` : `适用套餐和额度周期以原帖说明为准，实际额度以 ${product} 内显示为准。`)}
        </p>
      </div>
      {post && (
        <div className="min-w-0">
          <PostCard
            avatar={d.authorAvatar}
            stage={`${post.stage}原帖`}
            post={{ id: post.id, author: post.author, authorAvatar: post.authorAvatar, publishedAt: post.publishedAt, translation: post.fullText ?? post.text, original: post.fullOriginalText ?? post.originalText, context: post.context, url: post.url }}
          />
        </div>
      )}
    </section>
  );
}

/** The rhythm over the last 90 days: resets, credits, the median gap, the last reset. */
function Stats({ stats }: { stats: ResetMonitorSitePage["stats"] }) {
  const bonuses = useMonitor().eventKinds.includes("bonus_credit");
  const items = [
    { label: "近 90 天额度重置", value: `${stats.resets90} 次` },
    { label: "近 90 天发重置卡", value: `${stats.credits90} 次` },
    ...(bonuses ? [{ label: "近 90 天奖励活动", value: `${stats.bonuses90} 次` }] : []),
    { label: "重置间隔中位数", value: stats.medianIntervalDays === null ? "—" : `${stats.medianIntervalDays} 天` },
    { label: "上次额度重置", value: stats.lastResetDate ? monthDay(stats.lastResetDate) : "—" },
  ];
  return (
    <dl className={`mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line ${bonuses ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
      {items.map((i) => (
        <div key={i.label} className="bg-surface px-4 py-3">
          <dt className="text-[12px] text-ink-4">{i.label}</dt>
          <dd className="num mt-1 text-[18px] font-semibold text-ink">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const MONITOR_WORDS = { healthy: "监控正常", delayed: "检查有延迟", attention: "监控需要处理", unknown: "监控状态未知" } as const;
const MONITOR_DOT = { healthy: "bg-ok-ink", delayed: "bg-amber-ink", attention: "bg-amber-ink", unknown: "bg-ink-4" } as const;

function ActiveBonuses({ events, avatar }: { events: ResetMonitorEvent[]; avatar: string | null }) {
  if (!events.length) return null;
  return <section className="mt-6" aria-labelledby="bonus-title">
    <h2 id="bonus-title" className="text-[18px] font-semibold text-ink">奖励额度活动</h2>
    <div className="mt-3 grid gap-4">{events.map(e => <article key={e.id} className="rounded-card border border-line bg-surface p-4">
      <p className="text-[12px] font-medium text-ok-ink">{bonusStatus(e.presentation?.status)}</p>
      <h3 className="mt-1 text-[15px] font-semibold text-ink">{e.displayLabel || "奖励额度"}</h3>
      <p className="mt-1 text-[12.5px] text-ink-3">适用范围：{e.presentation?.audienceZh ?? e.presentation?.scopeLabel ?? "原帖未说明"}{e.presentation?.productsZh ? ` · ${e.presentation.productsZh}` : ""}</p>
      {e.schedule?.from && <p className="mt-2 text-[12.5px] text-ink-3">活动开放时间：北京时间 {stamp(e.schedule.from)}</p>}
      <BonusCreditDetails value={e.presentation?.bonusCredit} />
      {e.posts[0] && <div className="mt-3"><PostCard compact avatar={avatar} stage={e.posts[0].stage} post={{ id: e.posts[0].id, author: e.posts[0].author, authorAvatar: e.posts[0].authorAvatar, publishedAt: e.posts[0].publishedAt, translation: e.posts[0].fullText ?? e.posts[0].text, original: e.posts[0].fullOriginalText ?? e.posts[0].originalText, context: e.posts[0].context, url: e.posts[0].url }} /></div>}
    </article>)}</div>
  </section>;
}

function ResetMonitorPage() {
  const profile = useMonitor();
  const { product, organization, timingHelp: TimingHelp } = profile;
  const title = profile.title ?? `${product} 重置监控`;
  const bonuses = profile.eventKinds.includes("bonus_credit");
  const d = useLoaderData<ResetMonitorPageData>();
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  useEffect(() => setCheckedAt(null), [d.version, d.monitor?.lastVerifiedAt]);
  useVersionPolling(d.version, d.today, setCheckedAt);
  const m = d.monitor ? { ...d.monitor, lastVerifiedAt: checkedAt ?? d.monitor.lastVerifiedAt } : null;
  return (
    <div className="pb-8">
      <PhoneBar back={{ to: "/more", label: "我的" }} title={title} />
      <header className="flex flex-col gap-1 pb-4 pt-3 lg:flex-row lg:items-end lg:justify-between lg:pt-1">
        <div>
          <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">{title}</h1>
          <p className="mt-1.5 text-[13px] text-ink-3">{bonuses ? `${product} 额度重置、重置卡与奖励额度：适用条件、时间和官方原话` : `${product} 额度重置与重置卡发放：什么时候生效、给谁、官方原话`}</p>
          <p className="mt-1 text-[12px] text-ink-4">监控账号：{profile.authors.map(author => `${author.name}（@${author.handle}）`).join("、")}</p>
        </div>
        <p className="text-[12px] text-ink-4">全部为北京时间 · UTC+8</p>
      </header>

      <LiveMonitor d={d} />

      {TimingHelp && <details className="disclosure group mt-8 border-t border-line">
        <summary className="flex items-center justify-between gap-3 py-[18px] text-[13px] text-ink-3 transition-colors hover:text-ink">
          <span className="inline-flex items-center gap-1.5">
            <IconChevronRight size={13} className="text-ink-4 transition-transform duration-200 group-open:rotate-90" />
            时间与确认依据
          </span>
          <span className="text-[12px] text-ink-4">来源与规则</span>
        </summary>
        <div className="grid grid-cols-1 gap-x-8 gap-y-[18px] pb-6 pt-1.5 text-[12px] leading-[1.9] text-ink-4 md:grid-cols-2">
          <TimingHelp data={d} />
        </div>
      </details>}

      <footer className="flex flex-col gap-2 border-t border-line py-4 text-[12px] text-ink-4 sm:flex-row sm:items-start sm:justify-between">
        {m ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
              <span className={`size-1.5 rounded-full ${MONITOR_DOT[m.status]}`} />
              {MONITOR_WORDS[m.status]} · 最近检查 <span className="num">{stamp(m.lastVerifiedAt)}</span>
              <IconChevronDown size={13} className="text-ink-4 transition-transform group-open:rotate-180" />
            </summary>
            <dl className="num mt-2 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 pl-4 text-[12px] text-ink-4">
              <dt>最近尝试</dt><dd>{stamp(m.lastAttemptAt)}</dd>
              <dt>最近采集</dt><dd>{stamp(m.lastCollectedAt)}</dd>
              <dt>最近完整核验</dt><dd>{stamp(m.lastVerifiedAt)}</dd>
              {m.pendingCount > 0 && <><dt>待处理帖子</dt><dd>{m.pendingCount}</dd></>}
              {m.authors?.map(author => <div key={author.handle} className="col-span-2">
                @{author.handle}：{author.collectedSince ? `${author.collectedSince.slice(0, 10)} ${bjTime(author.collectedSince)} 起采集，不包含此前历史` : "历史采集起点未记录"}
              </div>)}
              {m.scopeEffectiveAt && <div className="col-span-2">采集范围自 {m.scopeEffectiveAt.slice(0, 10)} {bjTime(m.scopeEffectiveAt)} 生效，不自动补采此前历史</div>}
            </dl>
          </details>
        ) : (
          <span>尚未完成首次核验</span>
        )}
        <span>{SITE.name} 整理 · 非 {organization} 官方页面</span>
      </footer>
    </div>
  );
}

/** Only the changing status/calendar need the foreground clock; archive statistics stay still. */
function LiveMonitor({ d }: { d: ResetMonitorSitePage & { serverNow: number } }) {
  const [now, setNow] = useState(d.serverNow);
  useEffect(() => {
    const update = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    update();
    const t = setInterval(update, 30_000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", update);
    };
  }, [d.version]);
  return <>
    <Hero d={d} now={now} />
    <ActiveBonuses events={d.activeBonuses ?? []} avatar={d.authorAvatar} />
    <Stats stats={d.stats} />
    <ResetCalendar key={d.selectedDate} selectedDate={d.selectedDate} version={d.version} marks={d.calendar} events={d.events} today={d.today} historyFrom={d.historyFrom} now={now} avatar={d.authorAvatar} />
  </>;
}
