import type { ReactNode } from "react";
import { Badge } from "@aihot/web/components/ui/Badge";
import type { PlatformOverview } from "../../public-v2.ts";
import type { AdminEvent, AdminTimelineAction, Scope } from "../admin-types.ts";
import { ACTION, KIND, STATUS, stamp, text } from "./format.ts";

function scopeText(scope: Scope | null, catalog?: PlatformOverview["catalog"]) {
  const note = text(scope?.note);
  if (note) return note;
  if (!scope) return "适用范围未说明";
  const names = (codes: string[], entries = catalog?.plans ?? []) => codes.map(code => text(entries.find(entry => entry.code === code)?.name) || code);
  return [
    { all_users: "所有用户", paid_users: "付费用户", selected_users: "部分用户", unknown: "所有用户" }[scope.type],
    ...names(scope.planCodes, catalog?.plans), ...names(scope.quotaWindowCodes, catalog?.quotaWindows),
  ].filter(Boolean).join(" · ");
}

type CardEvent = Pick<AdminEvent, "type" | "status" | "time" | "title" | "summary" | "scope"> & { withdrawn?: boolean };
export function EventCardFrame({ event, catalog, title, footer, children, eventId }: {
  event: CardEvent; catalog?: PlatformOverview["catalog"]; title?: ReactNode; footer?: ReactNode; children: ReactNode; eventId?: string;
}) {
  return <article className="min-w-0 rounded-card border border-line bg-surface p-4 sm:p-5" data-monitor-event={eventId} aria-label={eventId ? `事件：${text(event.title) || "标题待处理"}` : undefined}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
      <span className="text-accent">{KIND[event.type]}</span>
      <span className="text-ink-4">{scopeText(event.scope, catalog)}</span>
      <span className={event.status === "completed" ? "text-ok-ink" : "text-ink-3"}>{event.status ? STATUS[event.status] : "缺少有效初始动作"}</span>
      {event.withdrawn && <Badge tone="hot">已撤回</Badge>}
      <span className="num ml-auto text-ink-4">{stamp(event.time)}</span>
    </div>
    <h3 className="mt-2 break-words text-[17px] font-semibold leading-relaxed text-ink">{title ?? (text(event.title) || "标题待处理")}</h3>
    {event.summary && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-3">{text(event.summary)}</p>}
    {children}
    {footer && <footer className="mt-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4">{footer}</footer>}
  </article>;
}

export function EventActionRow({ action, children, actionId }: {
  action: Pick<AdminTimelineAction, "action" | "invalidatesEvent" | "time" | "publishedAt" | "title" | "summary">; children: ReactNode; actionId?: string;
}) {
  const time = action.time ?? action.publishedAt;
  return <li className="grid min-w-0 grid-cols-[7.25rem_minmax(0,1fr)] gap-3 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4" data-timeline-action={actionId}>
    <time dateTime={time} className="num text-[12px] leading-5 text-ink-4">{stamp(time)}</time>
    <div className="min-w-0 border-l-2 border-line-strong pl-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-[13px] font-medium leading-5 text-ink"><Badge className="mr-2 align-middle" tone={action.invalidatesEvent ? "hot" : action.action === "confirm" ? "ok" : "accent"}>{action.invalidatesEvent ? "修订 · 已取消" : ACTION[action.action]}</Badge><span className="align-middle">{text(action.title)}</span></h4>
          {action.summary && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-3">{text(action.summary)}</p>}
        </div>
        {children}
      </div>
    </div>
  </li>;
}
