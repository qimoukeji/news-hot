import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@aihot/web/features/admin/ui";
import { AdminDialog } from "./admin-dialog.tsx";
import { EventFields } from "./event-fields.tsx";
import { emptyFact, factOf, FactFields } from "./review-fields.tsx";
import { useMonitor } from "./context.tsx";
import { ACTION, KIND, STATUS, stamp, text } from "./components/format.ts";
import type { ActionFact, AdminReviewDetail, EventDraft, ReviewAction, ReviewEvent } from "./admin-types.ts";
import type { AssociationAddition } from "./association-draft.ts";

export type AssociationStep = { kind: "choose-event" } | { kind: "event" | "source" | "action"; eventId: string } | { kind: "new-event" } | { kind: "remove"; action: ReviewAction };

export function AssociationOperationDialog({ step, detail, additions, onStep, onClose, onAdd, onRemove }: {
  step: AssociationStep; detail: AdminReviewDetail; additions: AssociationAddition[]; onStep: (step: AssociationStep) => void; onClose: () => void; onAdd: (addition: AssociationAddition) => string | undefined; onRemove: (actionId: string) => void;
}) {
  const event = "eventId" in step ? detail.options.events.find(event => event.id === step.eventId) : undefined;
  const titles = { "choose-event": "选择事件", event: "关联到此事件", source: "选择已有动作", action: "新增动作并关联", "new-event": "新建事件并关联", remove: "移除关联" };
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled)")?.focus(); }, [step]);
  return <AdminDialog title={titles[step.kind]} onClose={onClose}>
    <div ref={body} className="contents">
      {step.kind === "choose-event" ? <EventChoice detail={detail} onChoose={eventId => onStep({ kind: "event", eventId })} onClose={onClose} />
        : step.kind === "remove" ? <>
          <div className="min-h-0 space-y-3 overflow-y-auto p-4 text-[13px]"><p>{text(detail.options.events.find(event => event.id === step.action.eventId)?.title) || "未命名事件"}</p><p>{ACTION[step.action.action]} · {text(step.action.title)}</p><p className="text-ink-3">将移除当前帖子的来源关联，识别状态和处理说明保持不变。</p>{step.action.sources.length === 1 && <p role="alert" className="rounded-control bg-hot-soft p-3 text-hot">将移除最后一条来源，此动作将删除。保存前须预览事件状态、时间和范围影响。</p>}</div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-line p-4"><Button tone="ghost" onClick={onClose}>取消</Button><Button tone="danger" onClick={() => onRemove(step.action.id)}>确定移除</Button></footer>
        </> : step.kind === "new-event" ? <NewAssociation key="new-event" detail={detail} onClose={onClose} onAdd={onAdd} />
          : event && step.kind === "event" ? <>
            <div className="min-h-0 space-y-4 overflow-y-auto p-4"><p className="text-[13px] text-ink-3">目标事件：{text(event.title) || "未命名事件"}</p><div className="grid gap-3">
              <Button disabled={!!event.withdrawn || !detail.options.actions.some(action => action.eventId === event.id)} onClick={() => onStep({ kind: "source", eventId: event.id })}>补充已有动作来源</Button>
              <Button tone="primary" disabled={!!event.withdrawn || event.status === "cancelled"} onClick={() => onStep({ kind: "action", eventId: event.id })}>新增动作</Button>
            </div>{event.status === "cancelled" && <p className="text-[13px] text-amber-ink">事件已取消，可补充既有事实的来源；不通过新增动作恢复事件。</p>}{!detail.options.actions.some(action => action.eventId === event.id) && <p className="text-[13px] text-ink-4">暂无动作，请新增首个预告或确认。</p>}</div>
            <footer className="flex shrink-0 justify-end gap-2 border-t border-line p-4"><Button tone="ghost" onClick={() => onStep({ kind: "choose-event" })}>返回选择事件</Button><Button tone="ghost" onClick={onClose}>取消</Button></footer>
          </> : event && step.kind === "source" ? <ExistingSource key={event.id} detail={detail} event={event} additions={additions} onClose={onClose} onBack={() => onStep({ kind: "event", eventId: event.id })} onAdd={onAdd} />
            : event && step.kind === "action" ? <NewAssociation key={event.id} detail={detail} event={event} onClose={onClose} onAdd={onAdd} /> : <div className="p-4 text-[13px] text-hot">目标事件已不存在，请关闭后重新读取。</div>}
    </div>
  </AdminDialog>;
}

function EventChoice({ detail, onChoose, onClose }: { detail: AdminReviewDetail; onChoose: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const events = detail.options.events.filter(event => `${text(event.title)} ${KIND[event.type]}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (Date.parse(b.time?.split("/")[0] ?? "") || 0) - (Date.parse(a.time?.split("/")[0] ?? "") || 0));
  const totalPages = Math.ceil(events.length / 10);
  const currentPage = Math.min(page, Math.max(1, totalPages));
  const visible = events.slice((currentPage - 1) * 10, currentPage * 10);
  return <><div className="min-h-0 overflow-y-auto p-4"><section aria-label="选择事件" className="min-w-0">
    <Input aria-label="搜索事件" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="搜索事件标题或类型" />
    <div className="mt-3 h-[clamp(10rem,calc(100dvh-18rem),28rem)] overflow-y-auto p-1"><ul aria-label="可选事件" className="space-y-3">
      {visible.map(event => <li key={event.id}><button type="button" data-button-tone="ghost" disabled={!!event.withdrawn} className="w-full rounded-control p-2 text-left text-[13px] disabled:opacity-45" onClick={() => onChoose(event.id)}><span className="block break-words">{text(event.title) || "未命名事件"}</span><span className="mt-1 block text-[12px] text-ink-4">{KIND[event.type]} · {event.withdrawn ? "已撤回" : event.status ? STATUS[event.status] : "缺少有效初始动作"} · {stamp(event.time)}</span></button></li>)}
    </ul>{!events.length && <p className="py-3 text-[13px] text-ink-4">没有匹配事件，请调整搜索条件。</p>}</div>
    <nav aria-label="事件分页" className="mt-3 flex items-center justify-center gap-3 border-t border-line pt-3 text-center text-[12px] text-ink-4">
      {currentPage > 1 ? <a className="shrink-0 text-accent hover:underline" href="#" onClick={event => { event.preventDefault(); setPage(currentPage - 1); }}>上一页</a> : <span aria-disabled="true" className="shrink-0 opacity-45">上一页</span>}
      <span>共 {events.length} 条 · 第 {totalPages ? currentPage : 0} / {totalPages} 页</span>
      {currentPage < totalPages ? <a className="shrink-0 text-accent hover:underline" href="#" onClick={event => { event.preventDefault(); setPage(currentPage + 1); }}>下一页</a> : <span aria-disabled="true" className="shrink-0 opacity-45">下一页</span>}
    </nav>
  </section></div><footer className="flex shrink-0 justify-end gap-2 border-t border-line p-4"><Button tone="ghost" onClick={onClose}>取消</Button></footer></>;
}

function ExistingSource({ detail, event, additions, onClose, onBack, onAdd }: { detail: AdminReviewDetail; event: ReviewEvent; additions: AssociationAddition[]; onClose: () => void; onBack: () => void; onAdd: (addition: AssociationAddition) => string | undefined }) {
  const [actionId, setActionId] = useState("");
  const [updateConfirmation, setUpdateConfirmation] = useState(false);
  const [fact, setFact] = useState<ActionFact>(emptyFact);
  const [error, setError] = useState("");
  const actions = detail.options.actions.filter(action => action.eventId === event.id).sort((a, b) => b.sequence - a.sequence);
  const selected = actions.find(action => action.id === actionId);
  const alreadyLinked = (action: ReviewAction) => action.sources.some(source => source.postId === detail.post!.id) || additions.some(addition => addition.kind === "source" && addition.actionId === action.id);
  const canUpdate = selected?.action === "confirm" && selected.sources.length === 0;
  return <form className="flex min-h-0 flex-col" onSubmit={submission => {
    submission.preventDefault(); submission.stopPropagation();
    if (!selected || alreadyLinked(selected) || event.withdrawn) return;
    const message = onAdd({ key: crypto.randomUUID(), kind: "source", eventId: event.id, actionId: selected.id, ...(canUpdate && updateConfirmation ? { fact: { ...fact, action: "confirm", invalidatesEvent: false } } : {}) });
    if (message) setError(message);
  }}>
    <div className="min-h-0 space-y-4 overflow-y-auto p-4"><p className="text-[13px] text-ink-3">目标事件：{text(event.title) || "未命名事件"}</p>
      <fieldset className="space-y-2"><legend className="mb-2 text-[13px] font-medium">选择已有动作</legend>{actions.map(action => <label key={action.id} className="flex items-start gap-2 rounded-control border border-line p-3 text-[13px]"><input type="radio" name="association-action" className="mt-1 shrink-0" disabled={!!event.withdrawn || alreadyLinked(action)} checked={actionId === action.id} onChange={() => { setActionId(action.id); setFact(factOf(action)); setUpdateConfirmation(false); }} /><span className="min-w-0 break-words">{ACTION[action.action]} · {text(action.title)}<span className="mt-1 block text-[12px] text-ink-4">{stamp(action.time)} · {action.sources.length} 条来源{alreadyLinked(action) ? " · 当前帖子已关联或待添加" : ""}</span></span></label>)}</fieldset>
      {canUpdate && <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" aria-label="同时更新确认内容" className="mt-1" checked={updateConfirmation} onChange={change => setUpdateConfirmation(change.target.checked)} /><span>同时更新确认内容<span className="mt-1 block text-ink-4">补充官方证据时可修正标题、摘要和实际时间，保留此确认动作。</span></span></label>}
      {canUpdate && updateConfirmation && <FactFields fullWidthText fixedAction showHints={false} value={fact} onChange={setFact} />}
      {error && <p role="alert" className="text-[13px] text-hot">{error}</p>}
    </div>
    <footer className="flex shrink-0 justify-end gap-2 border-t border-line p-4"><Button tone="ghost" onClick={onBack}>返回</Button><Button tone="ghost" onClick={onClose}>取消</Button><Button type="submit" tone="primary" disabled={!selected || !!event.withdrawn || alreadyLinked(selected)}>确定</Button></footer>
  </form>;
}

function NewAssociation({ detail, event, onClose, onAdd }: { detail: AdminReviewDetail; event?: ReviewEvent; onClose: () => void; onAdd: (addition: AssociationAddition) => string | undefined }) {
  const { eventKinds } = useMonitor();
  const [draft, setDraft] = useState<EventDraft>(() => ({ type: eventKinds[0]!, title: "", summary: "", scope: "" }));
  const [fact, setFact] = useState<ActionFact>(() => ({ ...emptyFact(), title: { zh: text(detail.post?.title) }, summary: detail.post?.summary ? { zh: text(detail.post.summary) } : null }));
  const [error, setError] = useState("");
  const blocked = !!event?.withdrawn || event?.status === "cancelled";
  return <form className="flex min-h-0 flex-col" onSubmit={submission => {
    submission.preventDefault(); submission.stopPropagation(); if (blocked) return;
    const key = crypto.randomUUID();
    const message = onAdd(event ? { kind: "action", key, eventId: event.id, fact } : { kind: "event", key, event: draft, fact });
    if (message) setError(message);
  }}>
    <div className="min-h-0 space-y-4 overflow-y-auto p-4">
      <fieldset disabled={blocked} className="min-w-0 space-y-4">
        {event ? <p className="text-[13px] text-ink-3">目标事件：{text(event.title) || "未命名事件"}</p> : <section aria-label="新事件信息" className="space-y-3"><h3 className="text-[14px] font-medium">事件信息</h3><EventFields requiredTitle value={draft} onChange={patch => setDraft(current => ({ ...current, ...patch }))} /></section>}
        <section aria-label="关联动作内容" className="space-y-3"><h3 className="text-[14px] font-medium">{event ? "新增动作" : "首个动作"}</h3><FactFields fullWidthText showHints={false} initial={!event?.status} value={fact} onChange={value => { setFact(value); setError(""); }} /></section>
      </fieldset>
      <p className="rounded-control bg-bg-sunk p-3 text-[13px] text-ink-3">来源帖子：{text(detail.post?.title) || "无标题帖子"}</p>
      {error && <p role="alert" className="text-[13px] text-hot">{error}</p>}
    </div>
    <footer className="flex shrink-0 justify-end gap-2 border-t border-line p-4"><Button tone="ghost" onClick={onClose}>取消</Button><Button type="submit" tone="primary" disabled={blocked}>确定</Button></footer>
  </form>;
}
