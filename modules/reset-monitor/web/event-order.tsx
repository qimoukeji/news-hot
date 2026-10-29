import { useEffect, useState } from "react";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { Button } from "@aihot/web/features/admin/ui";
import { AdminDialog } from "./admin-dialog.tsx";
import { useMonitor } from "./context.tsx";
import { useReviewDetail } from "./use-review-detail.ts";
import { ReviewImpact } from "./review-preview.tsx";
import { text } from "./components/format.ts";
import type { AdminReviewDetail, ReviewPreview } from "./admin-types.ts";

export function EventOrderDialog({ eventId, onClose, onDone }: { eventId: string; onClose: () => void; onDone: () => void }) {
  const { adminApiPath } = useMonitor();
  const base = `${adminApiPath}/events/${encodeURIComponent(eventId)}/review`;
  const { detail, error, revision, reload } = useReviewDetail(base, "event");
  const [busy, setBusy] = useState(false);
  return <AdminDialog title="调整动作顺序" busy={busy} onClose={onClose}>
    {detail ? <OrderForm key={revision} detail={detail} base={base} onClose={onClose} onDone={onDone} onBusy={setBusy} onReload={reload} />
      : <div className="p-4">{error ? <><p role="alert" className="mb-3 text-[13px] text-hot">{error}</p><Button onClick={reload}>重新读取</Button></> : <p role="status">正在读取动作顺序…</p>}</div>}
  </AdminDialog>;
}
function OrderForm({ detail, base, onClose, onDone, onBusy, onReload }: { detail: AdminReviewDetail; base: string; onClose: () => void; onDone: () => void; onBusy: (busy: boolean) => void; onReload: () => void }) {
  const initial = [...detail.actions].sort((a, b) => a.sequence - b.sequence).map(action => action.id);
  const [order, setOrder] = useState(initial);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [conflict, setConflict] = useState(false);
  const { run, busy } = useAdminAction();
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const actionLabel = (id: string) => text(detail.actions.find(action => action.id === id)?.title) || "未命名动作";
  const move = (index: number, delta: number) => { const next = [...order]; [next[index], next[index + delta]] = [next[index + delta]!, next[index]!]; setOrder(next); setPreview(null); };
  const dirty = order.some((id, index) => id !== initial[index]);
  return <form className="flex min-h-0 flex-col" onSubmit={async event => {
    event.preventDefault(); if (!dirty || busy || conflict) return;
    const body = { version: detail.version, versions: detail.versions, reason: "调整动作顺序", orders: [{ eventId: detail.event!.id, actionIds: order }] };
    const onError = (status: number) => { if (status === 409) setConflict(true); };
    if (preview) { if (await run("POST", base, { ...body, previewToken: preview.previewToken }, { revalidate: false, onError, success: "动作顺序已保存" })) onDone(); else setPreview(null); }
    else setPreview(await run<ReviewPreview>("POST", `${base}/preview`, body, { revalidate: false, onError }));
  }}>
    <div className="min-h-0 space-y-4 overflow-y-auto p-4"><ol aria-label="动作顺序" className="space-y-3">{order.map((id, index) => <li key={id} className="flex items-center justify-between gap-3 text-[13px]"><span className="min-w-0 break-words">{actionLabel(id)}</span><div className="flex shrink-0 gap-2"><Button size="sm" disabled={busy || conflict || index === 0} aria-label={`上移：${actionLabel(id)}`} onClick={() => move(index, -1)}>上移</Button><Button size="sm" disabled={busy || conflict || index === order.length - 1} aria-label={`下移：${actionLabel(id)}`} onClick={() => move(index, 1)}>下移</Button></div></li>)}</ol>
      {conflict && <div role="alert" className="text-[13px] text-hot"><p>动作记录已变化，请重新读取并预览。</p><Button onClick={onReload}>重新读取</Button></div>}
      {preview && <ReviewImpact preview={preview} actionLabel={actionLabel} eventLabel={() => text(detail.event?.title)} sourceNames={() => ""} />}
    </div><footer className="flex shrink-0 justify-end gap-2 border-t border-line p-4"><Button tone="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" tone="primary" busy={busy} disabled={!dirty || conflict}>{preview ? "确认提交" : "预览影响"}</Button></footer>
  </form>;
}
