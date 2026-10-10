import { MonitorProvider, useMonitor, type ResetMonitorWebProfile } from "./context.tsx";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AdminMonitorEvent, AdminMonitorPost } from "../contracts.ts";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { SITE } from "@aihot/site";
import type { ResetMonitorAdminData } from "./loaders.server.ts";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { bj } from "@aihot/web/features/admin/format";
import { AdminPage, Badge, Button, Card, Empty, FilterChips, Input, Json, ReasonDialog, Select } from "@aihot/web/features/admin/ui";
import { Field } from "./admin-field.tsx";
import { BonusCreditFields, emptyBonus } from "./bonus-fields.tsx";
import { BonusCreditDetails } from "./components/BonusCreditDetails";
import { bonusStatus } from "./components/format";
import { quotaScopeLabel } from "../quota-scope.ts";

import { MonitorPagination } from "./admin-pagination.tsx";

export function createAdminPage(profile: ResetMonitorWebProfile) {
  return {
    meta: () => [{ title: `${profile.title ?? `${profile.product} 重置`} · ${SITE.name} 后台` }],
    default: function ResetMonitorAdminRoute(props: { loaderData: ResetMonitorAdminData }) {
      return <MonitorProvider profile={profile}><MonitorAdmin {...props} /></MonitorProvider>;
    },
  };
}

const toLocal = (iso: string | null | undefined) => (iso ? `${beijingDate(iso)}T${beijingTime(iso)}` : "");
const fromLocal = (v: string) => (v ? `${v}:00+08:00` : null);
const KIND: Record<string, string> = { direct_reset: "额度重置", reset_credit: "重置卡", bonus_credit: "奖励额度" };

function EventCard({ e }: { e: AdminMonitorEvent }) {
  const { adminApiPath, adminPath, authorName, eventKinds } = useMonitor();
  const { run, pending } = useAdminAction();
  const [dialog, setDialog] = useState<null | "edit" | "review" | "withdraw">(null);
  const [form, setForm] = useState(() => formOf(e));
  const [reviewDay, setReviewDay] = useState("");
  const version = new Date(e.updated_at).toISOString();
  const base = `${adminApiPath}/events/${encodeURIComponent(e.id)}`;
  const p = e.presentation ?? {};
  return (
    <article className={`rounded-panel bg-surface p-4 ring-1 ${e.withdrawn ? "opacity-60 ring-line" : e.status === "confirmed" ? "ring-line" : "ring-accent/30"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={e.type === "reset_credit" ? "info" : "accent"}>{KIND[e.type]}</Badge>
            <Badge tone={e.status === "confirmed" ? "ok" : "warn"}>{e.type === "bonus_credit" ? bonusStatus(p.status ?? (e.status === "confirmed" ? "available" : p.inProgress ? "in_progress" : "announced")) : e.status === "confirmed" ? "已确认" : p.inProgress ? "下发中" : "已宣布"}</Badge>
            {e.confirmation_basis === "receipt_review" && <Badge tone="info" title="根据账户回执核对确认">回执核对</Badge>}
            {e.withdrawn && <Badge tone="bad">已撤回</Badge>}
            {!p.kindExplicit && <Badge>形式未明确</Badge>}
          </div>
          <div className="mt-2 text-[15px] font-semibold text-ink">{e.schedule?.label ?? (e.estimate ? `${SITE.name} 估计 ${e.estimate.label}` : "没有给出时间")}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-3">
            {p.audienceZh ?? e.scope ?? "适用对象未说明"}
            {p.productsZh ? ` · ${p.productsZh}` : ""}
            {p.quotaScope ? ` · ${quotaScopeLabel(p.quotaScope)}` : ""}
            {e.confirmed_at ? ` · 确认于 ${bj(e.confirmed_at, true)}` : e.occurred_on ? ` · 发生于 ${e.occurred_on}` : ""}
          </div>
          <div className="mt-1 font-mono text-[11.5px] text-ink-4">{e.id} · 更新 {bj(e.updated_at, true)}</div>
          {e.type === "bonus_credit" && <BonusCreditDetails value={p.bonusCredit} />}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => { setForm(formOf(e)); setDialog("edit"); }}>编辑</Button>
          {e.type !== "bonus_credit" && e.canReceiptReview && <Button size="sm" onClick={() => setDialog("review")}>回执核对确认</Button>}
          <Button size="sm" tone="ghost" onClick={() => setDialog("withdraw")}>{e.withdrawn ? "恢复" : "撤回"}</Button>
        </div>
      </div>
      <ol className="mt-3 space-y-2 border-t border-line pt-3">
        {e.posts.map((post) => (
          <li key={post.postId} className="grid gap-1 text-[13px] sm:grid-cols-[92px_1fr_auto]">
            <div className="flex items-center gap-1.5 sm:block">
              <Badge tone={post.action === "confirm" ? "ok" : "muted"}>{post.stage}</Badge>
              <div className="num text-[11.5px] text-ink-4 sm:mt-1">{bj(post.publishedAt)}</div>
            </div>
            <div className="min-w-0">
              <div className="text-ink">{post.text}</div>
              <a className="text-[12px] text-ink-4 hover:text-accent" href={post.url} target="_blank" rel="noreferrer">{post.originalText}</a>
            </div>
            <Link className="text-accent" to={`${adminPath}/posts/${encodeURIComponent(post.postId)}/review`}>复核与调整关联</Link>
          </li>
        ))}
      </ol>

      <ReasonDialog
        open={dialog === "edit"}
        title="编辑事件"
        description="时间按北京时间填写；改动立即反映在公开页、v1 接口和版本探针上。"
        confirmLabel="保存"
        busy={pending === "edit"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          const initial = formOf(e);
          const patch: Record<string, unknown> = {};
          if (form.type !== initial.type) patch.type = form.type;
          for (const field of ["audienceZh", "productsZh", "scopeLabel"] as const) {
            if (form[field] !== initial[field]) patch[field] = form[field] || null;
          }
          if (["precision", "from", "through"].some((k) => form[k as keyof typeof form] !== initial[k as keyof typeof initial])) {
            patch.schedule = form.precision ? { precision: form.precision, from: fromLocal(form.from), through: fromLocal(form.through || form.from) } : null;
          }
          if (form.type === "bonus_credit" && (form.type !== initial.type || JSON.stringify(form.bonusCredit) !== JSON.stringify(initial.bonusCredit))) patch.bonusCredit = form.bonusCredit;
          return (await run("PATCH", base, { patch, reason, version }, { label: "edit", success: "事件已更新" })) !== null;
        }}
      >
        <div className="grid max-h-[60vh] gap-3 overflow-y-auto px-0.5 sm:grid-cols-2">
          <Field label="类型">
            <Select value={form.type} onChange={(ev) => setForm({ ...form, type: ev.target.value as AdminMonitorEvent["type"], precision: "", from: "", through: "" })}>
              {eventKinds.map(kind => <option key={kind} value={kind}>{KIND[kind]}</option>)}
            </Select>
          </Field>
          <Field label={form.type === "bonus_credit" ? "活动开放时间精度" : "时间精度"}>
            <Select value={form.precision} onChange={(ev) => setForm({ ...form, precision: ev.target.value })}>
              <option value="">没有时间</option>
              <option value="exact">单个钟点</option>
              <option value="window">时间段</option>
              {form.type !== "bonus_credit" && <><option value="deadline">截止时间（…前）</option><option value="approximate">大约</option></>}
              <option value="date">整天</option>
            </Select>
          </Field>
          {form.precision && (
            <>
              <Field label="从"><Input type="datetime-local" value={form.from} onChange={(ev) => setForm({ ...form, from: ev.target.value })} /></Field>
              {(form.precision === "window" || form.precision === "date") && <Field label="到"><Input type="datetime-local" value={form.through} onChange={(ev) => setForm({ ...form, through: ev.target.value })} /></Field>}
            </>
          )}
          <Field label="适用对象（中文）"><Input value={form.audienceZh} onChange={(ev) => setForm({ ...form, audienceZh: ev.target.value })} /></Field>
          <Field label="产品"><Input value={form.productsZh} onChange={(ev) => setForm({ ...form, productsZh: ev.target.value })} /></Field>
          <Field label="范围标签（原文）"><Input value={form.scopeLabel} onChange={(ev) => setForm({ ...form, scopeLabel: ev.target.value })} /></Field>
          {form.type === "bonus_credit" && <BonusCreditFields value={form.bonusCredit} onChange={(bonusCredit) => setForm({ ...form, bonusCredit })} />}
        </div>
      </ReasonDialog>
      <ReasonDialog
        open={dialog === "review"}
        title="根据回执核对确认"
        description={`${authorName} 没有发“已完成”，但账户里已经看到重置或重置卡（读者截图或自有账号）。知道哪天生效就填北京时间日期，不确定就清空；不发通知。${authorName} 之后补发确认帖时，来源会自动改为官方确认，这条核对记录保留。`}
        confirmLabel="确认"
        busy={pending === "review"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/receipt-review`, { occurredOn: reviewDay || null, reason, version }, { label: "review", success: "已确认" })) !== null}
      >
        <Field label="生效日（北京时间，不确定就清空）"><Input type="date" value={reviewDay} onChange={(ev) => setReviewDay(ev.target.value)} /></Field>
      </ReasonDialog>
      <ReasonDialog
        open={dialog === "withdraw"}
        title={e.withdrawn ? "恢复事件" : "撤回事件"}
        description={e.withdrawn ? "恢复后重新出现在重置页和接口里。" : "撤回后不再出现在重置页和接口里（识别错误、重复事件）。"}
        danger={!e.withdrawn}
        confirmLabel={e.withdrawn ? "恢复" : "撤回"}
        busy={pending === "withdraw"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/withdrawn`, { withdrawn: !e.withdrawn, reason, version }, { label: "withdraw", success: e.withdrawn ? "已恢复" : "已撤回" })) !== null}
      />
    </article>
  );
}

function formOf(e: AdminMonitorEvent) {
  const p = e.presentation ?? {};
  return {
    type: e.type,
    status: e.status,
    precision: e.schedule?.precision ?? "",
    from: toLocal(e.schedule?.from),
    through: toLocal(e.schedule?.through),
    confirmedAt: toLocal(e.confirmed_at),
    audienceZh: String(p.audienceZh ?? ""),
    productsZh: String(p.productsZh ?? ""),
    scopeLabel: String(p.scopeLabel ?? ""),
    bonusCredit: p.bonusCredit ?? emptyBonus(),
  };
}

function PostRow({ post }: { post: AdminMonitorPost }) {
  const { adminPath } = useMonitor();
  const props = post.propositions ?? [];
  return (
    <article className="rounded-panel bg-surface p-4 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
        <a href={post.url} target="_blank" rel="noreferrer" className="num hover:text-accent">{bj(post.published_at, true)}</a>
        {post.skipped ? <Badge>已跳过</Badge> : post.relevant ? <Badge tone="accent">相关</Badge> : post.processed_at ? <Badge>无关</Badge> : <Badge tone="warn">待识别</Badge>}
        {post.needs_review && !post.manual_review && <Badge tone="bad">需要复核</Badge>}
        {post.manual_review && <Badge tone="ok" title={post.manual_review.reason}>人工复核完成</Badge>}
        {post.collection_failure && <Badge tone="bad" title={post.collection_failure.error}>{post.collection_failure.phase === "context" ? "上下文采集失败" : "识别失败"}</Badge>}
        {post.links.map((l) => <Badge key={l.eventId} tone="info" title={l.eventId}>{l.stage}</Badge>)}
        <span className="ml-auto flex gap-1.5">
          <Link className="text-accent" to={`${adminPath}/posts/${encodeURIComponent(post.id)}/review`}>人工复核</Link>
        </span>
      </div>
      {post.source_issue && <p role="status" className="mt-2 text-[13px] text-amber">资料不完整：{post.source_issue}</p>}
      {post.held && post.held.length > 0 && (
        <div className="mt-2 rounded-control bg-bg-sunk px-3 py-2 text-[12.5px] text-ink-3">
          <div className="font-medium text-ink-2">需要人工处理的事件动作</div>
          {post.held.map((h, i) => <div key={i}>{h.action} · “{h.excerpt}” · {h.reason ?? "需核对原帖依据"}</div>)}
        </div>
      )}
      <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{post.translation ?? post.text}</p>
      {post.translation && <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-ink-4">{post.text}</p>}
      {props.length > 0 && (
        <div className="mt-2 space-y-1">
          {props.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <Badge tone={p.real ? "ok" : "muted"}>{p.real ? "真实" : "非承诺"}</Badge>
              <Badge>{KIND[p.kind] ?? p.kind} · {p.action}</Badge>
              {p.relatesTo && <span className="font-mono text-ink-4">→ {p.relatesTo}</span>}
              <span className="text-ink-3">{p.excerptZh ?? p.excerpt}</span>
            </div>
          ))}
          <Json value={props} label="识别结果" />
        </div>
      )}
    </article>
  );
}

function MonitorAdmin({ loaderData }: { loaderData: ResetMonitorAdminData }) {
  const { product, pagePath, title } = useMonitor();
  const [sp] = useSearchParams();
  const tab = loaderData.tab;
  return (
    <AdminPage
      title={title ?? `${product} 重置`}
      subtitle="查看原帖依据、人工修正判断与事件关联，预览影响后提交。"
      actions={<a className="text-[13px] text-accent" href={pagePath} target="_blank" rel="noreferrer">打开公开页</a>}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1.5">
          <Link to="?tab=events" className={`rounded-full px-3.5 py-1.5 text-[13px] ${tab === "events" ? "bg-ink text-bg" : "bg-surface text-ink-2 ring-1 ring-line"}`}>事件</Link>
          <Link to="?tab=posts" className={`rounded-full px-3.5 py-1.5 text-[13px] ${tab === "posts" ? "bg-ink text-bg" : "bg-surface text-ink-2 ring-1 ring-line"}`}>帖子与识别</Link>
        </div>
        {tab === "events" ? (
          <div className="flex flex-wrap items-center gap-3">
            <FilterChips param="filter" options={[{ value: "", label: "全部" }, { value: "receipt_review", label: "需回执核对" }]} />
            {sp.get("filter") !== "receipt_review" && <Link to={sp.get("withdrawn") ? "?tab=events" : "?tab=events&withdrawn=1"} className="text-[12.5px] text-ink-3 hover:text-ink">{sp.get("withdrawn") ? "隐藏已撤回" : "包括已撤回"}</Link>}
          </div>
        ) : (
          <FilterChips param="filter" options={[{ value: "relevant", label: "相关" }, { value: "unrelated", label: "无关" }, { value: "review", label: "需复核" }, { value: "pending", label: "待识别" }, { value: "all", label: "全部" }]} />
        )}
      </div>
      {loaderData.events && (
        <>
          <div className="space-y-3">{loaderData.events.events.length ? loaderData.events.events.map((e) => <EventCard key={`${e.id}-${e.updated_at}`} e={e} />) : <Card><Empty>没有事件</Empty></Card>}</div>
          <MonitorPagination {...loaderData.events} />
        </>
      )}
      {loaderData.posts && (
        <>
          <div className="space-y-3">{loaderData.posts.rows.length ? loaderData.posts.rows.map((p) => <PostRow key={p.id} post={p} />) : <Card><Empty>没有符合条件的帖子</Empty></Card>}</div>
          <MonitorPagination {...loaderData.posts} />
        </>
      )}
    </AdminPage>
  );
}
