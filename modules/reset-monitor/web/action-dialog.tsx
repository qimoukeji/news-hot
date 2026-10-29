import { useEffect, useRef, useState } from "react";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { Button } from "@aihot/web/features/admin/ui";
import type { AdminReviewDetail, ReviewCommands, ReviewPreview } from "./admin-types.ts";
import { useMonitor } from "./context.tsx";
import { text } from "./components/format.ts";
import { FactFields, emptyFact, factOf } from "./review-fields.tsx";
import { ReviewImpact } from "./review-preview.tsx";
import { AdminDialog } from "./admin-dialog.tsx";
import { ActionSources, AddActionSources } from "./action-sources.tsx";
import { useReviewDetail } from "./use-review-detail.ts";

export function ActionDialog({ eventId, actionId, onClose, onDone }: { eventId: string; actionId?: string; onClose: () => void; onDone: () => void }) {
  const { adminApiPath } = useMonitor();
  const base = `${adminApiPath}/events/${encodeURIComponent(eventId)}/review`;
  const { detail, error, revision, reload } = useReviewDetail(base, "event");
  const [busy, setBusy] = useState(false);
  const missing = detail && actionId && !detail.actions.some(action => action.id === actionId);
  return <AdminDialog title={actionId ? "编辑动作" : "添加动作"} busy={busy} onClose={onClose}>
    {detail && !missing ? <ActionForm key={revision} detail={detail} actionId={actionId} base={base} onClose={onClose} onDone={onDone} onBusy={setBusy} onReload={reload} />
      : <div className="p-5">{error || missing ? <><p role="alert" className="mb-4 text-[13px] text-hot">{error || "此动作已不存在，请关闭弹框并刷新列表。"}</p><Button onClick={reload}>重新读取</Button></> : <p role="status" className="text-[13px] text-ink-3">正在读取事件与来源…</p>}</div>}
  </AdminDialog>;
}

function ActionForm({ detail, actionId, base, onClose, onDone, onBusy, onReload }: {
  detail: AdminReviewDetail; actionId?: string; base: string; onClose: () => void; onDone: () => void; onBusy: (busy: boolean) => void; onReload: () => void;
}) {
  const original = detail.actions.find(action => action.id === actionId);
  const [fact, setFact] = useState(() => original ? factOf(original) : emptyFact());
  const originalIds = original?.sources.map(source => source.postId) ?? [];
  const [postIds, setPostIds] = useState(originalIds);
  const [pickingSources, setPickingSources] = useState(false);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const { run, busy } = useAdminAction();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.querySelector<HTMLElement>("select")?.focus(); }, []);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const changed = () => { setPreview(null); setError(""); };
  const factChanged = !!original && JSON.stringify(fact) !== JSON.stringify(factOf(original));
  const added = postIds.filter(id => !originalIds.includes(id));
  const removed = originalIds.filter(id => !postIds.includes(id));
  const dirty = !original || factChanged || added.length > 0 || removed.length > 0;
  const removingLastSource = !!originalIds.length && !postIds.length;
  const sourceLessConfirmation = fact.action === "confirm" && !postIds.length && !removingLastSource;
  const commands: ReviewCommands = {
    events: { create: [], update: [] },
    actions: { create: original ? [] : [{ ...fact, localKey: "new-action", eventId: detail.event!.id }], update: original && factChanged && !removingLastSource ? [{ id: original.id, ...fact }] : [] },
    sources: {
      add: (original ? added : postIds).map(postId => ({ ...(original ? { actionId: original.id } : { actionKey: "new-action" }), postId })),
      remove: original ? removed.map(postId => ({ actionId: original.id, postId })) : [],
    }, orders: [],
  };
  const body = { version: detail.version, versions: detail.versions, ...commands };
  const onError = (status: number) => { if (status === 409) setConflict(true); };
  const eventLabel = (id: string) => text(detail.options.events.find(event => event.id === id)?.title) || "未命名事件";
  const actionLabel = (id: string) => text(detail.options.actions.find(action => action.id === id)?.title) || "新增动作";
  const sourceNames = (ids: string[]) => ids.map(id => text(detail.options.posts.find(post => post.id === id)?.title) || "无标题帖子").join("、") || "无";
  return <><form ref={form} className="flex min-h-0 flex-col" onSubmit={async event => {
    event.preventDefault();
    if (busy || conflict || !dirty) return;
    if (!removingLastSource && !postIds.length && fact.action !== "confirm") { setError("只有确认动作可以不关联帖子，其他动作必须选择至少一条来源帖子"); return; }
    if (sourceLessConfirmation && !fact.time?.trim()) { setError("无关联帖子的确认必须填写明确生效时间"); return; }
    if (preview) {
      const result = await run("POST", base, { ...body, previewToken: preview.previewToken }, { label: "submit-action", revalidate: false, onError, success: "动作变更已提交" });
      if (result) onDone(); else { setPreview(null); setError("提交失败，请核对提示后重试。"); }
    } else {
      const result = await run<ReviewPreview>("POST", `${base}/preview`, body, { label: "preview-action", revalidate: false, onError });
      setPreview(result); if (!result) setError("无法预览，请核对提示后重试。");
    }
  }}>
    <div className="min-h-0 overflow-y-auto p-4">
      <fieldset disabled={busy || conflict || (!original && detail.event?.withdrawn)} className="min-w-0 space-y-4">
        <FactFields fullWidthText showHints={false} requiresTime={sourceLessConfirmation} value={fact} initial={!original && !detail.event?.status} onChange={value => { setFact(value.action === "confirm" && !postIds.length && !text(value.title).trim() ? { ...value, title: { zh: "人工核实已生效" } } : value); changed(); }} />
        <ActionSources posts={detail.options.posts} selected={postIds} disabled={busy || conflict} canAdd={!detail.event?.withdrawn} onAdd={() => setPickingSources(true)} onRemove={id => { setPostIds(postIds.filter(postId => postId !== id)); changed(); }} />
      </fieldset>
      {removingLastSource && <p role="alert" className="mt-4 text-[13px] text-hot">将移除最后一条来源，此动作将删除。请核对事件当前影响范围。</p>}
      {detail.event?.withdrawn && <p className="mt-4 text-[13px] text-amber-ink">此事件已撤回，不能新增动作或增加来源。</p>}
      {conflict ? <div role="alert" className="mt-4 space-y-2 text-[13px] text-hot"><p>事件版本已变化，请重新读取后核对并预览。重新读取将清除当前输入。</p><Button disabled={busy} onClick={onReload}>重新读取</Button></div> : error && <p role="alert" className="mt-4 text-[13px] text-hot">{error}</p>}
      {preview && <div className="mt-4 space-y-4" aria-label="变更预览"><ReviewImpact preview={preview} eventLabel={eventLabel} actionLabel={actionLabel} sourceNames={sourceNames} /></div>}
    </div>
    <footer className="flex shrink-0 justify-end gap-2 border-t border-line p-4"><Button tone="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" tone={preview ? "primary" : "secondary"} busy={busy} disabled={conflict || !dirty || (!original && !!detail.event?.withdrawn)}>{preview ? "确认提交" : "预览影响"}</Button></footer>
  </form>{pickingSources && <AddActionSources posts={detail.options.posts.filter(post => !postIds.includes(post.id))} onClose={() => setPickingSources(false)} onConfirm={ids => { setPostIds([...postIds, ...ids]); setPickingSources(false); changed(); }} />}</>;
}
