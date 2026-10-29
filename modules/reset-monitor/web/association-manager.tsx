import { useEffect, useState } from "react";
import { Button, Textarea } from "@aihot/web/features/admin/ui";
import { Field } from "./admin-field.tsx";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { ACTION, KIND, STATUS, stamp, text } from "./components/format.ts";
import type { ActionFact, AdminReviewDetail, EventKind, ReviewAction, ReviewEvent, ReviewPreview } from "./admin-types.ts";
import { buildAssociationCommands, type AssociationAddition } from "./association-draft.ts";
import { AssociationOperationDialog, type AssociationStep } from "./association-dialogs.tsx";
import { factOf } from "./review-fields.tsx";
import { ReviewImpact } from "./review-preview.tsx";

type AssociationRow = { key: string; eventId: string; eventTitle: string; eventType: EventKind; event?: ReviewEvent; fact: ActionFact; sourceCount: number; current?: ReviewAction; addition?: AssociationAddition; removed?: boolean };

export function AssociationManager({ detail, base, onClose, onDone, onBusy, onReload }: { detail: AdminReviewDetail; base: string; onClose: () => void; onDone: () => void; onBusy: (busy: boolean) => void; onReload: () => void }) {
  const [step, setStep] = useState<AssociationStep | null>(null);
  const [additions, setAdditions] = useState<AssociationAddition[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [completeProcessing, setCompleteProcessing] = useState(false);
  const [keepPost, setKeepPost] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy } = useAdminAction();
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const changed = () => { setPreview(null); setError(""); };
  const current = detail.actions.filter(action => action.sources.some(source => source.postId === detail.post!.id));
  const rows: AssociationRow[] = current.map(action => {
    const event = detail.options.events.find(event => event.id === action.eventId)!;
    return { key: action.id, eventId: event.id, eventTitle: text(event.title) || "未命名事件", eventType: event.type, event, fact: factOf(action), sourceCount: action.sources.length, current: action, removed: removed.includes(action.id) };
  });
  for (const addition of additions) {
    if (addition.kind === "event") rows.push({ key: addition.key, eventId: `event-${addition.key}`, eventTitle: addition.event.title.trim(), eventType: addition.event.type, fact: addition.fact, sourceCount: 1, addition });
    else {
      const event = detail.options.events.find(event => event.id === addition.eventId)!;
      const action = addition.kind === "source" ? detail.options.actions.find(action => action.id === addition.actionId) : undefined;
      rows.push({ key: addition.key, eventId: event.id, eventTitle: text(event.title) || "未命名事件", eventType: event.type, event,
        fact: addition.kind === "source" ? addition.fact ?? factOf(action!) : addition.fact, sourceCount: (action?.sources.length ?? 0) + 1, addition });
    }
  }
  const groups = new Map<string, AssociationRow[]>();
  for (const row of rows) groups.set(row.eventId, [...groups.get(row.eventId) ?? [], row]);
  const postReview = completeProcessing || keepPost;
  const dirty = additions.length > 0 || removed.length > 0 || postReview;
  const blocked = busy || conflict;
  const eventLabel = (id: string) => text(detail.options.events.find(event => event.id === id)?.title) || text(preview?.changes.find(change => change.eventId === id)?.after?.title) || "新建事件";
  const actionLabel = (id: string) => {
    const change = preview?.actionChanges.find(change => change.actionId === id);
    return text(detail.options.actions.find(action => action.id === id)?.title) || text(change?.after?.title ?? change?.before?.title) || "新增动作";
  };
  const sourceNames = (ids: string[]) => ids.map(id => text(detail.options.posts.find(post => post.id === id)?.title) || "无标题帖子").join("、") || "无";
  return <><form className="flex min-h-0 flex-col" onSubmit={async submission => {
    submission.preventDefault(); if (blocked || !dirty || step || postReview && !reason.trim()) return;
    const commands = buildAssociationCommands(additions, removed, detail.post!.id);
    const body = { version: detail.version, versions: detail.versions, ...commands, ...(completeProcessing ? { completeProcessing: true } : {}), ...(keepPost ? { keepPost: true } : {}), ...(postReview ? { reason: reason.trim() } : {}) };
    const onError = (status: number) => { if (status === 409) setConflict(true); };
    if (preview) {
      const saved = await run("POST", base, { ...body, previewToken: preview.previewToken }, { label: "save-associations", revalidate: false, onError, success: postReview ? "帖子复核已保存" : "帖子关联已保存" });
      if (saved) onDone(); else { setPreview(null); setError("保存失败，请核对后重试，当前草稿已保留。"); }
    } else {
      const result = await run<ReviewPreview>("POST", `${base}/preview`, body, { label: "preview-associations", revalidate: false, onError });
      setPreview(result); if (!result) setError("无法预览，请核对后重试。");
    }
  }}>
    <div className="min-h-0 space-y-4 overflow-y-auto p-4">
      <section aria-label="当前关联" className="min-w-0">
        <header className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[14px] font-medium">当前关联</h3><div className="flex items-center gap-2"><Button size="sm" disabled={blocked} onClick={() => setStep({ kind: "choose-event" })}>关联已有事件</Button><Button size="sm" tone="primary" disabled={blocked} onClick={() => setStep({ kind: "new-event" })}>新建事件</Button></div></header>
        <p className="mt-3 text-[12px] text-ink-4">{groups.size} 个事件 · {rows.length} 个动作{dirty && ` · ${additions.length + removed.length} 项待保存`}</p>
        <div className="mt-3 space-y-3">{[...groups.values()].map(group => <section key={group[0]!.eventId} className="overflow-hidden rounded-control border border-line" aria-label={`关联事件：${group[0]!.eventTitle}`}>
          <header className="bg-bg-sunk p-3"><h4 className="break-words text-[13px] font-medium">{group[0]!.eventTitle}</h4><p className="mt-1 text-[12px] text-ink-4">{KIND[group[0]!.eventType]} · {group[0]!.event ? group[0]!.event.withdrawn ? "已撤回" : group[0]!.event.status ? STATUS[group[0]!.event.status] : "缺少有效初始动作" : "待创建"}</p></header>
          <ul className="divide-y divide-line">{group.map(row => <li key={row.key} className="flex items-start justify-between gap-3 p-3 text-[13px]" aria-label={`关联动作：${text(row.fact.title)}`}>
            <div className={`min-w-0 ${row.removed ? "opacity-60" : ""}`}><p className="break-words">{ACTION[row.fact.action]} · {text(row.fact.title)}</p><p className="mt-1 text-[12px] text-ink-4">{stamp(row.fact.time)} · {row.sourceCount} 条来源{row.removed ? <span className="ml-2 text-amber-ink">待移除</span> : row.addition && <span className="ml-2 text-accent">{row.addition.kind === "source" ? "待补充来源" : "待添加"}</span>}</p></div>
            {row.addition || row.removed ? <Button size="sm" tone="ghost" disabled={blocked} aria-label={`撤销：${text(row.fact.title)}`} onClick={() => { if (row.addition) setAdditions(additions.filter(addition => addition.key !== row.addition!.key)); else setRemoved(removed.filter(id => id !== row.current!.id)); changed(); }}>撤销</Button>
              : <Button size="sm" tone="danger" disabled={blocked} aria-label={`移除关联：${text(row.fact.title)}`} onClick={() => setStep({ kind: "remove", action: row.current! })}>移除关联</Button>}
          </li>)}</ul>
        </section>)}{!rows.length && <p className="py-6 text-center text-[13px] text-ink-4">暂无关联事件</p>}</div>
      </section>
      <section aria-label="帖子复核" className="space-y-3 border-t border-line pt-3">
        <div className="flex flex-wrap gap-2">{detail.post!.processingStatus !== "processed" && <Button size="sm" disabled={blocked} onClick={() => { setCompleteProcessing(!completeProcessing); changed(); }}>{completeProcessing ? "取消完成处理" : "完成处理"}</Button>}{detail.post!.filteredOut && <Button size="sm" disabled={blocked} onClick={() => { setKeepPost(!keepPost); changed(); }}>{keepPost ? "取消保留帖子" : "保留帖子"}</Button>}</div>
        {postReview && <Field label="复核理由"><Textarea required disabled={blocked} value={reason} onChange={event => { setReason(event.target.value); changed(); }} /></Field>}
      </section>
      {conflict ? <div role="alert" className="space-y-2 text-[13px] text-hot"><p>关联记录已变化，请重新读取后核对并预览。重新读取将清除当前草稿。</p><Button disabled={busy} onClick={onReload}>重新读取</Button></div> : error && <p role="alert" className="text-[13px] text-hot">{error}</p>}
      {preview && <section aria-label="变更预览" className="space-y-4 border-t border-line pt-4"><h3 className="text-[14px] font-medium">变更预览</h3><ReviewImpact preview={preview} eventLabel={eventLabel} actionLabel={actionLabel} sourceNames={sourceNames} /></section>}
    </div>
    <footer className="flex shrink-0 justify-end gap-2 border-t border-line p-4"><Button tone="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" tone="primary" busy={busy} disabled={!dirty || conflict || postReview && !reason.trim()}>{preview ? "保存" : "预览影响"}</Button></footer>
  </form>{step && <AssociationOperationDialog step={step} detail={detail} additions={additions} onStep={setStep} onClose={() => setStep(null)} onAdd={addition => {
    let staged = addition;
    if (addition.kind === "action" && addition.fact.action === "confirm") {
      const actionId = detail.options.events.find(event => event.id === addition.eventId)?.unsourcedConfirmationId;
      if (actionId) staged = { kind: "source", key: addition.key, eventId: addition.eventId, actionId, fact: addition.fact };
    }
    if (staged.kind === "source" && additions.some(existing => existing.kind === "source" && staged.kind === "source" && existing.actionId === staged.actionId)) return "此动作已在待保存列表中，请先撤销对应变更。";
    setAdditions([...additions, staged]); setStep(null); changed();
  }} onRemove={actionId => { setRemoved([...removed, actionId]); setStep(null); changed(); }} />}</>;
}
