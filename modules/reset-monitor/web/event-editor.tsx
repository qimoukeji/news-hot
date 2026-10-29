import { useState } from "react";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { Button } from "@aihot/web/features/admin/ui";
import { emptyScope, type AdminEvent, type ReviewEvent } from "./admin-types.ts";
import { useMonitor } from "./context.tsx";
import { KIND, STATUS, stamp, text } from "./components/format.ts";
import { EventFields } from "./event-fields.tsx";
import { AdminDialog } from "./admin-dialog.tsx";

export function EventEditorDialog({ event, onClose, onCreated }: { event?: ReviewEvent; onClose: () => void; onCreated?: (event: { id: string; createdAt?: string }) => void }) {
  const { adminApiPath, eventKinds } = useMonitor();
  const { run, busy } = useAdminAction();
  const initial = () => ({ type: event?.type ?? eventKinds[0]!, title: text(event?.title), summary: text(event?.summary), scope: text(event?.scope?.note) });
  const [form, setForm] = useState(initial);
  const [preview, setPreview] = useState<{ previewToken: string; before: AdminEvent; after: AdminEvent } | null>(null);
  const close = () => { if (!busy) onClose(); };
  const change = (patch: Partial<typeof form>) => { setPreview(null); setForm(current => ({ ...current, ...patch })); };
  return <AdminDialog title={event ? "编辑事件" : "创建事件"} busy={busy} onClose={close}>
    <form className="flex min-h-0 flex-col" onSubmit={async submission => {
      submission.preventDefault();
      if (busy) return;
      if (!event) {
        const created = await run<{ id: string; createdAt?: string }>("POST", `${adminApiPath}/events`, {
          type: form.type, title: { zh: form.title.trim() }, summary: form.summary.trim() ? { zh: form.summary } : null,
          scope: form.scope.trim() ? { ...emptyScope(), note: { zh: form.scope.trim() } } : null,
        }, { label: "create-event", revalidate: false, success: "事件已创建，请在列表中添加动作" });
        if (!created) return;
        onCreated?.(created);
        onClose();
        return;
      }
      const patch: Record<string, unknown> = {};
      if (form.type !== event.type) patch.type = form.type;
      if (form.title !== text(event.title)) patch.title = { zh: form.title };
      if (form.summary !== text(event.summary)) patch.summary = form.summary.trim() ? { zh: form.summary } : null;
      if (form.scope !== initial().scope) patch.scope = { ...(event.scope ?? emptyScope()), note: form.scope.trim() ? { zh: form.scope.trim() } : null };
      const base = `${adminApiPath}/events/${encodeURIComponent(event.id)}`;
      if (form.type !== event.type && !preview) {
        setPreview(await run("POST", `${base}/preview`, { version: event.version, patch }, { label: "preview-event", revalidate: false }));
        return;
      }
      const saved = await run("PATCH", base, { version: event.version, patch, ...(form.type !== event.type ? { previewToken: preview!.previewToken } : {}) }, { label: "edit", success: "已保存，翻译将在后台自动处理" });
      if (saved) onClose();
    }}>
      <div className="min-h-0 overflow-y-auto p-4">
        <div className="grid min-w-0 gap-3 p-1" data-event-edit-fields>
        <fieldset disabled={busy} className="contents">
          <EventFields value={form} onChange={change} requiredTitle={!event} />
        </fieldset>
        {preview && <section aria-label="类型变更对事件的影响" className="rounded-control bg-bg-sunk p-3 text-[13px]">
          <h3 className="font-medium">类型变更对事件的影响</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">{([['修改前', preview.before], ['修改后', preview.after]] as const).map(([label, result]) => <div className="min-w-0" key={label}>
            <p className="text-ink-3">{label}</p><p>{KIND[result.type]} · {result.status ? STATUS[result.status] : "缺少有效动作"}</p><p className="break-words text-ink-3">事件时间：{stamp(result.time)}</p>
          </div>)}</div>
        </section>}
        </div>
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-line p-4"><Button tone="ghost" disabled={busy} onClick={close}>取消</Button><Button type="submit" tone="primary" busy={busy}>{!event ? "创建" : form.type === event.type ? "保存" : preview ? "确认保存" : "预览类型变更"}</Button></footer>
    </form>
  </AdminDialog>;
}
