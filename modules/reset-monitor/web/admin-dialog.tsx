import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@aihot/web/features/admin/ui";

export function AdminDialog({ title, busy = false, onClose, children }: { title: string; busy?: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")?.focus();
    return () => { element.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} aria-modal="true" className="fixed inset-0 m-auto max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-2xl overflow-hidden rounded-sheet bg-raised p-0 text-ink shadow-2xl ring-1 ring-line-strong backdrop:bg-ink/30 backdrop:backdrop-blur-[2px]" onCancel={event => {
    event.preventDefault(); event.stopPropagation(); if (!busy) onClose();
  }} onKeyDown={event => {
    if (event.key !== "Tab") return;
    event.stopPropagation();
    const fields = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]")].filter(field => field.getClientRects().length && field.closest("dialog") === event.currentTarget);
    const first = fields[0], last = fields.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="flex max-h-[calc(100dvh-1.5rem)] flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line p-4"><h2 id={titleId} className="text-[16px] font-semibold">{title}</h2><Button size="sm" tone="ghost" disabled={busy} onClick={onClose}>关闭</Button></header>
      {children}
    </div>
  </dialog>;
}
