import { MonitorProvider, useMonitor, type ResetMonitorWebProfile } from "./context.tsx";
import { quotaScopeLabel } from "../quota-scope.ts";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { bj } from "@aihot/web/features/admin/format";
import { AdminPage, Badge, Button, Card, Input, Json, Select, Textarea } from "@aihot/web/features/admin/ui";
import { Field } from "./admin-field.tsx";
import { BonusCreditFields, emptyBonus } from "./bonus-fields.tsx";
import { BonusCreditDetails } from "./components/BonusCreditDetails";
import { bonusStatus } from "./components/format";
import type { AdminMonitorEvent, AdminMonitorEvents, AdminMonitorPostDetail, AdminMonitorReviewDraft, AdminMonitorReviewPreview, AdminMonitorReviewProposition } from "../contracts.ts";

export function createReviewPage(profile: ResetMonitorWebProfile) {
  return {
    default: function ResetMonitorReviewRoute(props: { loaderData: AdminMonitorPostDetail }) {
      return <MonitorProvider profile={profile}><MonitorReview {...props} /></MonitorProvider>;
    },
  };
}

const KIND = { direct_reset: "额度重置", reset_credit: "重置卡", bonus_credit: "奖励额度" };
const ACTION = { announce: "预告", progress: "进展", confirm: "官方确认完成", amend: "补充或更正", withdraw: "撤回" };
const DECISION = { unrelated: "无关", related: "相关但无事件动作", events: "包含事件动作" };
const local = (value: string) => value ? `${beijingDate(value)}T${beijingTime(value)}` : "";
const iso = (value: string) => value ? `${value}:00+08:00` : "";

function EventChoice({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) {
  const { adminApiPath } = useMonitor();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminMonitorEvents | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${adminApiPath}/events/options?q=${encodeURIComponent(query)}&page=${page}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`事件查询失败（${response.status}）`);
        setResult(await response.json());
        setError("");
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "事件查询失败"); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, page, adminApiPath]);
  return <div className="space-y-2">
    <Field label="关联目标" hint="搜索全部有效事件，不限于列表当前页。">
      <Input placeholder="输入事件 ID、范围或时间" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
    </Field>
    <Select aria-label="关联目标事件" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">建立新事件</option>
      {value && !result?.events.some((e) => e.id === value) && <option value={value}>{value}（当前关联）</option>}
      {result?.events.map((e) => <option key={e.id} value={e.id}>{KIND[e.type]} · {e.type === "bonus_credit" ? bonusStatus(e.presentation?.status ?? (e.status === "confirmed" ? "available" : "announced")) : e.status === "confirmed" ? "已确认" : "已宣布"} · {e.schedule?.label ?? bj(e.created_at)} · {e.presentation?.audienceZh ?? e.scope} · {e.id}</option>)}
    </Select>
    {error && <p role="alert" className="text-[13px] text-hot">{error}</p>}
    {result && <div className="flex items-center gap-3 text-[12px] text-ink-3">
      <span>共 {result.total} 个事件 · 第 {result.totalPages ? result.page : 0} / {result.totalPages} 页</span>
      {result.page > 1 && <Button size="sm" onClick={() => setPage(result.page - 1)}>上一页</Button>}
      {result.page < result.totalPages && <Button size="sm" onClick={() => setPage(result.page + 1)}>下一页</Button>}
    </div>}
  </div>;
}

function emptyProposition(text: string, kind: AdminMonitorReviewProposition["kind"]): AdminMonitorReviewProposition {
  return { kind, kindExplicit: true, action: "announce", count: 1, excerpt: text, excerptZh: "", targetEventId: null,
    scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null }, schedule: null, occurredOn: null };
}

function PropositionForm({ value: p, index, onChange, onRemove }: { value: AdminMonitorReviewProposition; index: number; onChange: (p: AdminMonitorReviewProposition) => void; onRemove: () => void }) {
  const { eventKinds } = useMonitor();
  const bonus = p.kind === "bonus_credit";
  const scope = (key: keyof typeof p.scope, value: string) => onChange({ ...p, scope: { ...p.scope, [key]: value.trim() || null } });
  return <Card title={`事件动作 ${index + 1}`} right={<Button size="sm" tone="ghost" onClick={onRemove}>移除动作</Button>}>
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="类型"><Select value={p.kind} onChange={(e) => { const kind = e.target.value as typeof p.kind; onChange({ ...p, kind, count: kind === "bonus_credit" ? 1 : p.count, schedule: null, occurredOn: null, bonusCredit: kind === "bonus_credit" ? p.bonusCredit ?? emptyBonus() : null }); }}>{eventKinds.map(key => <option key={key} value={key}>{KIND[key]}</option>)}</Select></Field>
      <Field label="动作"><Select value={p.action} onChange={(e) => onChange({ ...p, action: e.target.value as typeof p.action })}>{Object.entries(bonus ? { ...ACTION, announce: "活动公告", confirm: "官方确认活动可领取" } : ACTION).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
      {!bonus && <Field label="次数" hint="已有事件每次只关联一轮；新事件可填写原帖明确说明的 1–5 次。"><Input type="number" min={1} max={5} value={p.count} onChange={(e) => onChange({ ...p, count: Number(e.target.value) })} /></Field>}
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={p.kindExplicit} onChange={(e) => onChange({ ...p, kindExplicit: e.target.checked })} />{bonus ? "原帖明确说明奖励额度" : "原帖明确说明了重置形式"}</label>
      <div className="md:col-span-2"><EventChoice value={p.targetEventId} onChange={(targetEventId) => onChange({ ...p, targetEventId, count: targetEventId ? 1 : p.count, overrideEventFields: false })} /></div>
      {p.targetEventId && <div className="md:col-span-2"><label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={p.overrideEventFields ?? false} onChange={(e) => onChange({ ...p, overrideEventFields: e.target.checked })} />用本次判断替换该事件已有人工字段</label><p className="mt-1 text-[12px] text-ink-3">替换类型、范围、产品、时间与生效日，留空字段会清空；未勾选则保留既有人工更正。变更将显示在预览中。</p></div>}
      <Field label="原帖依据" hint="必须引用这条帖子里的原话；短回复结合下方上下文判断。"><Textarea value={p.excerpt} onChange={(e) => onChange({ ...p, excerpt: e.target.value })} /></Field>
      <Field label="依据中文译文"><Textarea value={p.excerptZh} onChange={(e) => onChange({ ...p, excerptZh: e.target.value })} /></Field>
      <Field label="适用范围（原文）"><Input value={p.scope.audienceSource ?? ""} onChange={(e) => scope("audienceSource", e.target.value)} /></Field>
      <Field label="套餐" hint="多个套餐用逗号分隔，未说明留空。"><Input value={p.scope.plans?.join(", ") ?? ""} onChange={(e) => onChange({ ...p, scope: { ...p.scope, plans: e.target.value.split(/[,，、]/).map((v) => v.trim()).filter(Boolean).length ? e.target.value.split(/[,，、]/).map((v) => v.trim()).filter(Boolean) : null } })} /></Field>
      <Field label="适用对象（中文）"><Input value={p.scope.audienceZh ?? ""} onChange={(e) => scope("audienceZh", e.target.value)} /></Field>
      <Field label="产品"><Input value={p.scope.productsZh ?? ""} onChange={(e) => scope("productsZh", e.target.value)} /></Field>
      {bonus && <BonusCreditFields value={p.bonusCredit} onChange={(bonusCredit) => onChange({ ...p, bonusCredit })} />}
      <Field label={bonus ? "活动开放时间精度" : "原帖时间精度"} hint={bonus ? "仅记录明确的活动开放时间；领取截止及奖励到期请在独立字段填写。" : "以下均为北京时间；不知道就留空，不填写推测时间。"}>
        <Select value={p.schedule?.precision ?? ""} onChange={(e) => onChange({ ...p, schedule: e.target.value ? { precision: e.target.value as NonNullable<typeof p.schedule>["precision"], from: p.schedule?.from ?? "", through: p.schedule?.through ?? "" } : null })}>
          <option value="">没有明确时间</option><option value="exact">单个钟点</option><option value="date">整天</option><option value="window">时间段</option>{!bonus && <><option value="deadline">截止时间</option><option value="approximate">大约</option></>}
        </Select>
      </Field>
      {!bonus && <Field label="实际生效日" hint="明确知道发生日期才填写，允许为空。"><Input type="date" value={p.occurredOn ?? ""} onChange={(e) => onChange({ ...p, occurredOn: e.target.value || null })} /></Field>}
      {p.schedule && <>
        <Field label="从"><Input type="datetime-local" value={local(p.schedule.from)} onChange={(e) => onChange({ ...p, schedule: { ...p.schedule!, from: iso(e.target.value), through: p.schedule!.precision === "exact" ? iso(e.target.value) : p.schedule!.through } })} /></Field>
        {p.schedule.precision !== "exact" && <Field label="到"><Input type="datetime-local" value={local(p.schedule.through)} onChange={(e) => onChange({ ...p, schedule: { ...p.schedule!, through: iso(e.target.value) } })} /></Field>}
      </>}
    </div>
  </Card>;
}

function EventSummary({ event }: { event: AdminMonitorEvent | null }) {
  if (!event) return <span className="text-ink-3">不存在</span>;
  return <div className="space-y-1 text-[13px]">
    <div>{KIND[event.type]} · {event.withdrawn ? "已撤回" : event.type === "bonus_credit" ? bonusStatus(event.presentation?.status ?? (event.status === "confirmed" ? "available" : "announced")) : event.status === "confirmed" ? "已确认" : "已宣布"}</div>
    <div>{event.schedule?.label ?? "没有明确时间"} · {event.presentation?.audienceZh ?? event.scope ?? "范围未说明"}{event.presentation?.quotaScope ? ` · ${quotaScopeLabel(event.presentation.quotaScope)}` : ""}</div>
    {event.type === "bonus_credit" ? <BonusCreditDetails value={event.presentation?.bonusCredit} /> : <div>确认依据：{event.confirmation_basis === "source_post" ? "官方帖子" : event.confirmation_basis === "receipt_review" ? "账户回执核对" : "无"}</div>}
    <Json value={event} label="完整事件字段" />
  </div>;
}

function MonitorReview({ loaderData: detail }: { loaderData: AdminMonitorPostDetail }) {
  const { adminApiPath, adminPath, eventKinds } = useMonitor();
  const [draft, setDraft] = useState<AdminMonitorReviewDraft>(() => structuredClone(detail.draft));
  const [preview, setPreview] = useState<AdminMonitorReviewPreview | null>(null);
  const [reason, setReason] = useState("");
  const version = useRef(detail.version);
  const { run, busy } = useAdminAction();
  const navigate = useNavigate();
  const base = `${adminApiPath}/posts/${encodeURIComponent(detail.post.id)}/review`;
  useEffect(() => {
    if (version.current === detail.version) return;
    version.current = detail.version;
    setDraft(structuredClone(detail.draft));
    setPreview(null);
  }, [detail.version, detail.draft]);
  const edit = (next: AdminMonitorReviewDraft) => { setDraft(next); setPreview(null); };
  return <AdminPage title="人工复核" subtitle="查看原帖依据，修正判断与事件关联，预览后一次提交。" actions={<Link className="text-accent" to={`${adminPath}?tab=posts`}>返回帖子列表</Link>}>
    <ol className="mb-5 flex flex-wrap gap-3 text-[13px] text-ink-3"><li>1 查看依据</li><li>2 编辑判断</li><li>3 预览影响</li><li>4 提交</li></ol>
    <div className="space-y-4">
      <Card title="原帖与上下文" right={<a href={detail.post.url} target="_blank" rel="noreferrer" className="text-accent">打开原帖</a>}>
        <p className="text-[12px] text-ink-3">{bj(detail.post.published_at, true)} · {detail.post.id}</p>
        <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed">{detail.post.text}</p>
        {detail.post.translation && <p className="mt-2 whitespace-pre-wrap text-[13px] text-ink-3">{detail.post.translation}</p>}
        {detail.post.source_issue && <p role="status" className="mt-3 text-[13px] text-amber">资料不完整：{detail.post.source_issue}</p>}
        {detail.post.collection_failure && <p role="status" className="mt-3 text-[13px] text-amber">{detail.post.collection_failure.phase === "context" ? "上下文采集失败" : "识别失败"} · {bj(detail.post.collection_failure.at, true)}：{detail.post.collection_failure.error}</p>}
        {detail.post.held?.map((held, index) => <p className="mt-2 text-[13px] text-amber" key={index}>{held.reason ?? "需要核对依据"} · {held.excerpt}</p>)}
        {detail.context.map((context) => <div key={context.id} className="mt-4 border-t border-line pt-3">
          <a className="text-[13px] text-accent" href={context.url} target="_blank" rel="noreferrer">{context.relation === "reply" ? "回复" : "引用"} @{context.author} · {context.publishedAt ? bj(context.publishedAt, true) : "发布时间缺失"}</a>
          <p className="mt-1 whitespace-pre-wrap text-[13px]">{context.originalText}</p>
          <Field label="上下文译文"><Textarea value={draft.contextZh.find((c) => c.id === context.id)?.textZh ?? context.textZh ?? ""} onChange={(e) => edit({ ...draft, contextZh: [...draft.contextZh.filter((c) => c.id !== context.id), { id: context.id, textZh: e.target.value }] })} /></Field>
        </div>)}
        <div className="mt-3"><Json value={detail.originalRecognition} label="原模型判断" /></div>
      </Card>
      <Card title="人工判断">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="分类"><Select value={draft.decision} onChange={(e) => edit({ ...draft, decision: e.target.value as typeof draft.decision, propositions: e.target.value === "events" ? (draft.propositions.length ? draft.propositions : [emptyProposition(detail.post.text, eventKinds[0]!)]) : [], outage: e.target.value === "unrelated" ? null : draft.outage })}>{Object.entries(DECISION).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
          <Field label="故障判断"><Select value={draft.outage ?? ""} disabled={draft.decision === "unrelated"} onChange={(e) => edit({ ...draft, outage: (e.target.value || null) as typeof draft.outage })}><option value="">不涉及故障</option><option value="outage">确认故障</option><option value="recovery">确认恢复</option></Select></Field>
          <div className="md:col-span-2"><Field label="原帖中文译文"><Textarea value={draft.translationZh ?? ""} onChange={(e) => edit({ ...draft, translationZh: e.target.value || null })} /></Field></div>
        </div>
      </Card>
      {draft.decision === "events" && <>
        {draft.propositions.map((proposition, index) => <PropositionForm key={index} index={index} value={proposition} onChange={(value) => edit({ ...draft, propositions: draft.propositions.map((p, i) => i === index ? value : p) })} onRemove={() => edit({ ...draft, propositions: draft.propositions.filter((_, i) => i !== index) })} />)}
        <Button onClick={() => edit({ ...draft, propositions: [...draft.propositions, emptyProposition(detail.post.text, eventKinds[0]!)] })}>添加事件动作</Button>
      </>}
      <Card title="预览与提交">
        <Button tone="primary" busy={busy} disabled={draft.decision === "events" && !draft.propositions.length} onClick={async () => setPreview(await run<AdminMonitorReviewPreview>("POST", `${base}/preview`, { draft, version: detail.version }, { label: "preview", revalidate: false }))}>预览影响</Button>
        {preview && <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2"><Badge tone="accent">{DECISION[preview.decision]}</Badge><span className="text-[13px]">移除 {preview.removedLinks.length} 个关联，增加 {preview.addedLinks.length} 个关联，修改 {preview.changes.length} 个事件</span></div>
          <Json label="提交后的帖子判断与译文" value={draft} />
          {preview.changes.map((change) => <div key={change.eventId} className="rounded-control border border-line p-3">
            <p className="mb-2 break-all font-mono text-[12px]">{change.eventId}</p>
            <div className="grid gap-4 md:grid-cols-2"><div><p className="mb-1 text-[12px] text-ink-3">提交前</p><EventSummary event={change.before} /></div><div><p className="mb-1 text-[12px] text-ink-3">提交后</p><EventSummary event={change.after} /></div></div>
          </div>)}
          {preview.outageChanges?.map((change) => <div key={change.postId}><p className="text-[13px]">故障记录：{change.postId}</p><Json label="故障关联与恢复时间变化" value={{ before: change.before, after: change.after }} collapsed={false} /></div>)}
          <Field label="复核理由（必填，写入审计）"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Button tone="primary" busy={busy} disabled={!reason.trim()} onClick={async () => {
            const result = await run("POST", base, { draft, version: detail.version, previewToken: preview.previewToken, reason: reason.trim() }, { label: "review", revalidate: false, success: "人工复核已提交" });
            if (result) navigate(`${adminPath}?tab=posts`);
          }}>确认提交复核</Button>
        </div>}
      </Card>
      <Card title="人工操作记录">
        {detail.history.length ? detail.history.map((entry, index) => <div key={index} className="mb-3 text-[13px]"><p>{bj(entry.at, true)} · {entry.actor} · {entry.reason}</p><Json value={{ before: entry.before, after: entry.after }} label="修改内容" /></div>) : <p className="text-[13px] text-ink-3">暂无人工操作记录</p>}
      </Card>
    </div>
  </AdminPage>;
}
