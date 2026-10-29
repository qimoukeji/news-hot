import { useId, useState, type ReactNode } from "react";
import { Link, useRevalidator } from "react-router";
import { Button } from "@aihot/web/features/admin/ui";
import { Badge } from "@aihot/web/components/ui/Badge";
import { useMonitor } from "./context.tsx";
import type { AdminTimelineEvent } from "./admin-types.ts";
import { PROCESSING_STATUS, stamp, text } from "./components/format.ts";
import { EventActionRow, EventCardFrame } from "./components/EventCard.tsx";
import { ActionDialog } from "./action-dialog.tsx";

export function EventTimeline({ event, controls }: { event: AdminTimelineEvent; controls: ReactNode }) {
  const { adminPath, publicV2 } = useMonitor();
  const [expanded, setExpanded] = useState(true);
  const timelineId = useId();
  const [dialog, setDialog] = useState<{ actionId?: string } | null>(null);
  const revalidator = useRevalidator();
  return <><EventCardFrame event={event} catalog={publicV2?.catalog} eventId={event.id}
    title={<Link className="hover:text-accent" to={`${adminPath}/events/${encodeURIComponent(event.id)}`}>{text(event.title) || "标题待处理"}</Link>}
    footer={<>
      <span className="mr-auto text-[12px] text-ink-4">{event.actionCount} 个动作 · {event.sourcePostCount} 条来源帖 · <span className="num">{stamp(event.latestAt)}</span></span>
      {controls}<Button size="sm" tone="primary" disabled={event.withdrawn} onClick={() => setDialog({})}>添加动作</Button>
      <Button size="sm" tone="ghost" aria-expanded={expanded} aria-controls={timelineId} onClick={() => setExpanded(!expanded)}>{expanded ? "收起动态" : "展开动态"}</Button>
    </>}>
    <section id={timelineId} hidden={!expanded} aria-label="事件动作时间线">
      {event.timeline.length ? <ol className="mt-4 space-y-4 border-t border-line pt-4">{event.timeline.map(action => <EventActionRow key={action.id} action={action} actionId={action.id}>
        <div className="max-w-[50%] shrink-0 text-right text-[12px] leading-5">
        <div className="flex items-center justify-end gap-1">
        {[...new Set(action.sources.map(post => post.processingStatus))].map(status => <Badge key={status} tone={status === "failed" ? "hot" : status === "needs_attention" ? "amber" : status === "processed" ? "ok" : "neutral"}>{PROCESSING_STATUS[status]}</Badge>)}
        <Button size="sm" className="shrink-0" aria-label={`编辑动作：${text(action.title)}`} onClick={() => setDialog({ actionId: action.id })}>编辑</Button>
        </div>
        {action.sources.some(post => post.filteredOut || post.reviewReason) && <ul aria-label="来源帖子" className="mt-1 space-y-2">{action.sources.filter(post => post.filteredOut || post.reviewReason).map(post => <li key={post.id} className="min-w-0">
          {post.filteredOut && <span className="block text-ink-4">被过滤</span>}
          {post.reviewReason && <p className="break-words text-amber-ink">{post.reviewReason}</p>}
        </li>)}</ul>}</div>
      </EventActionRow>)}</ol> : <p className="mt-4 border-t border-line py-4 text-[13px] text-ink-4">尚无动作，请添加预告或确认动作。</p>}
    </section>
  </EventCardFrame>{dialog && <ActionDialog eventId={event.id} actionId={dialog.actionId} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void revalidator.revalidate(); }} />}</>;
}
