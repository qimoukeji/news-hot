import { MonitorProvider, useMonitor, type ResetMonitorWebProfile } from "./context.tsx";
import { useEffect, useState } from "react";
import { Form, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { type AdminPost, type AdminEventDetail, type ReviewEvent } from "./admin-types.ts";
import { SITE } from "@aihot/site";
import type { ResetMonitorAdminData } from "./loaders.server.ts";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { AdminPage, Badge, Button, ButtonLink, Card, Empty, Input, ReasonDialog, Select } from "@aihot/web/features/admin/ui";
import "./admin-buttons.css";
import { Field } from "./admin-field.tsx";
import { MonitorPagination } from "./admin-pagination.tsx";
import { PROCESSING_STATUS, stamp, text } from "./components/format.ts";
import { EventOrderDialog } from "./event-order.tsx";
import { EventTimeline } from "./admin-timeline.tsx";
import { PillTabs } from "@aihot/web/components/ui/Tabs";
import { EventEditorDialog } from "./event-editor.tsx";
import { PostEditorDialog } from "./post-editor.tsx";
import { PostAssociationDialog } from "./post-association.tsx";
import { beijingDate } from "@aihot/contracts/time";

export function createAdminPage(profile: ResetMonitorWebProfile) {
  return {
    meta: () => [{ title: `${profile.title ?? `${profile.product} 重置`} · ${SITE.name} 后台` }],
    default: function ResetMonitorAdminRoute(props: { loaderData: ResetMonitorAdminData }) {
      return <MonitorProvider profile={profile}><div className="monitor-admin"><MonitorAdmin {...props} /></div></MonitorProvider>;
    },
  };
}
export function createEventPage(profile: ResetMonitorWebProfile) {
  return {
    meta: () => [{ title: `事件详情 · ${profile.product} · ${SITE.name} 后台` }],
    default: function MonitorEventRoute({ loaderData }: { loaderData: AdminEventDetail }) {
      return <MonitorProvider profile={profile}><div className="monitor-admin"><EventDetail detail={loaderData} /></div></MonitorProvider>;
    },
  };
}

function EventControls({ event }: { event: ReviewEvent }) {
  const { adminApiPath } = useMonitor();
  const { run, pending } = useAdminAction();
  const [dialog, setDialog] = useState<"edit" | "withdraw" | null>(null);
  const base = `${adminApiPath}/events/${encodeURIComponent(event.id)}`;
  return <>
    <Button size="sm" onClick={() => setDialog("edit")}>编辑</Button>
    <Button size="sm" tone={event.withdrawn ? "primary" : "danger"} disabled={!event.withdrawn && !event.status} onClick={() => setDialog("withdraw")}>{event.withdrawn ? "恢复公开" : "撤回"}</Button>
    {dialog === "edit" && <EventEditorDialog event={event} onClose={() => setDialog(null)} />}
    <ReasonDialog open={dialog === "withdraw"} title={event.withdrawn ? "恢复事件" : "撤回事件"} description="此操作只改变公开可见性。恢复时会重新检查事件的有效动作。" confirmLabel={event.withdrawn ? "恢复公开" : "撤回"} danger={!event.withdrawn} busy={pending === "withdraw"} onClose={() => setDialog(null)} onSubmit={async reason => await run("POST", `${base}/withdrawn`, { version: event.version, reason, withdrawn: !event.withdrawn }, { label: "withdraw", success: event.withdrawn ? "已恢复公开" : "已撤回" }) !== null} />
  </>;
}
function EventDetail({ detail }: { detail: AdminEventDetail }) {
  const { adminPath } = useMonitor();
  const revalidator = useRevalidator();
  const event = detail.event!;
  const [ordering, setOrdering] = useState(false);
  return <AdminPage title={text(event.title) || "事件详情"} subtitle="按动作顺序核对事实与来源，状态和事件时间自动推导。" actions={<ButtonLink tone="ghost" to={adminPath}>返回事件列表</ButtonLink>}>
    <EventTimeline event={event} controls={<><EventControls key={event.version} event={event} /><Button size="sm" disabled={detail.actions.length < 2} onClick={() => setOrdering(true)}>调整动作顺序</Button></>} />
    {ordering && <EventOrderDialog eventId={event.id} onClose={() => setOrdering(false)} onDone={() => { setOrdering(false); void revalidator.revalidate(); }} />}
  </AdminPage>;
}
function PostRow({ post }: { post: AdminPost }) {
  const [editing, setEditing] = useState(false);
  const [associating, setAssociating] = useState(false);
  const revalidator = useRevalidator();
  return <><article className="relative min-w-0 rounded-card border border-line bg-surface p-4 sm:p-5" data-monitor-post={post.id} aria-label={"帖子：" + (text(post.title) || "标题待处理")}>
    <h4>{text(post.title) || "标题待处理"}</h4>
    <div className="absolute right-4 top-4 flex items-center gap-2 sm:right-5 sm:top-5"><Button size="sm" tone="primary" onClick={() => setAssociating(true)}>{post.events?.length ? "管理关联" : "关联事件"}</Button><Button size="sm" onClick={() => setEditing(true)}>编辑</Button></div>
    {post.summary && <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-3">{text(post.summary)}</p>}
    <div className="mt-2 flex items-center justify-between gap-3 text-[12px]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-ink-4"><span>@{post.author}</span><time className="num" dateTime={post.publishedAt}>{stamp(post.publishedAt)}</time><span className="inline-flex items-center gap-2"><Badge tone={post.processingStatus === "failed" ? "bad" : post.processingStatus === "needs_attention" ? "warn" : "muted"}>{PROCESSING_STATUS[post.processingStatus]}</Badge><Badge tone={post.events?.length ? "ok" : "muted"}>{post.events?.length ? "已关联" : "无关联"}</Badge></span>{post.filteredOut && <Badge tone="muted">被过滤</Badge>}{post.replyTo && <Badge>回复</Badge>}<span>{post.events?.length ? "已关联 " + post.events.length + " 个事件" : "未关联事件"}</span><span>{post.actionCount ?? 0} 个动作</span></div>
      <a className="shrink-0 text-accent hover:underline" href={post.url} target="_blank" rel="noreferrer">原帖 ↗</a>
    </div>
    {post.reviewReason && <p role="status" className="mt-3 break-words rounded-control bg-bg-sunk px-3 py-2 text-[12px] leading-relaxed text-amber-ink">处理说明：{post.reviewReason}</p>}
  </article>{editing && <PostEditorDialog postId={post.id} onClose={() => setEditing(false)} onDone={() => { setEditing(false); void revalidator.revalidate(); }} />}{associating && <PostAssociationDialog postId={post.id} linked={!!post.events?.length} onClose={() => setAssociating(false)} onDone={() => { setAssociating(false); void revalidator.revalidate(); }} />}</>;
}
function ListFilters({ posts }: { posts: boolean }) {
  const [params] = useSearchParams();
  const { adminPath } = useMonitor();
  const [ready, setReady] = useState(false);
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  useEffect(() => { setReady(true); }, []);
  return <Form method="get" action={adminPath} aria-busy={!ready} className={`mb-5 grid min-w-0 items-end gap-2 rounded-panel bg-surface p-4 ring-1 ring-line sm:gap-3 ${posts ? "grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,8rem)_minmax(0,8rem)_auto]" : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,15rem)_minmax(0,15rem)_auto]"}`} key={params.toString()}>
    <fieldset disabled={!ready} className="contents">
    <input type="hidden" name="kind" value={posts ? "posts" : "events"} />
    <Field label="开始日期"><Input type="date" name="from" value={from} onChange={e => setFrom(e.target.value)} max={to || undefined} /></Field>
    <Field label="结束日期"><Input type="date" name="to" value={to} onChange={e => setTo(e.target.value)} min={from || undefined} /></Field>
    {posts && <Field label="关联状态"><Select name="association" defaultValue={params.get("association") ?? "all"}><option value="all">全部</option><option value="linked">已关联</option><option value="unlinked">无关联</option></Select></Field>}
    {posts && <Field label="采集记录"><Select name="collectionFilter" defaultValue={params.get("collectionFilter") ?? "normal"}><option value="normal">正常记录</option><option value="filtered">被过滤</option><option value="all">全部记录</option></Select></Field>}
    <div className="flex items-center gap-2 whitespace-nowrap sm:gap-3"><Button type="submit">查询</Button><ButtonLink tone="ghost" to={posts ? `${adminPath}?kind=posts` : adminPath}>重置</ButtonLink></div>
    </fieldset>
  </Form>;
}
function MonitorAdmin({ loaderData }: { loaderData: ResetMonitorAdminData }) {
  const { product, adminPath, title } = useMonitor();
  const navigate = useNavigate();
  const [creating, setCreating] = useState<"event" | "post" | null>(null);
  const [params] = useSearchParams();
  const posts = params.get("kind") === "posts";
  const tabLink = (kind: string) => {
    const query = new URLSearchParams();
    for (const name of ["from", "to"]) if (params.get(name)) query.set(name, params.get(name)!);
    query.set("kind", kind);
    return `${adminPath}?${query}`;
  };
  return <AdminPage title={title ?? product + " 重置"} subtitle="分别查看事件及其动作来源，或核对采集的帖子。">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><PillTabs className="min-w-0" label="监控列表" layoutId="monitor-admin-lists" active={posts ? "posts" : "events"} items={[{ key: "events", label: "事件列表", to: tabLink("events") }, { key: "posts", label: "帖子列表", to: tabLink("posts") }]} /><Button tone="primary" className="shrink-0" onClick={() => setCreating(posts ? "post" : "event")}>{posts ? "创建帖子" : "创建事件"}</Button></div>
    <ListFilters key={params.toString()} posts={posts} />
    <div className="space-y-5" aria-label={posts ? "帖子列表" : "事件列表"}>{loaderData.rows.length ? loaderData.rows.map(row => row.kind === "event"
      ? <EventTimeline key={"event:" + row.event.id} event={row.event} controls={<EventControls key={row.event.version} event={row.event} />} />
      : <PostRow key={"post:" + row.post.id} post={row.post} />)
      : <Card><Empty>没有符合条件的{posts ? "帖子" : "事件"}，请调整筛选。</Empty></Card>}</div>
    <MonitorPagination {...loaderData} />
    {creating === "event" && <EventEditorDialog onClose={() => setCreating(null)} onCreated={() => { setCreating(null); void navigate(`${adminPath}?kind=events`); }} />}
    {creating === "post" && <PostEditorDialog onClose={() => setCreating(null)} onDone={post => { setCreating(null); const query = new URLSearchParams({ kind: "posts" }); if (post?.publishedAt) { const day = beijingDate(post.publishedAt); query.set("from", day); query.set("to", day); } void navigate(`${adminPath}?${query}`); }} />}
  </AdminPage>;
}
