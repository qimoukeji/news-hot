import { useState } from "react";
import { Button } from "@aihot/web/features/admin/ui";
import { AdminDialog } from "./admin-dialog.tsx";
import { useMonitor } from "./context.tsx";
import { useReviewDetail } from "./use-review-detail.ts";
import { AssociationManager } from "./association-manager.tsx";

export function PostAssociationDialog({ postId, linked, onClose, onDone }: { postId: string; linked: boolean; onClose: () => void; onDone: () => void }) {
  const { adminApiPath } = useMonitor();
  const base = `${adminApiPath}/posts/${encodeURIComponent(postId)}`;
  const { detail, error, revision, reload } = useReviewDetail(base, "post");
  const [busy, setBusy] = useState(false);
  return <AdminDialog title={linked ? "管理关联" : "关联事件"} busy={busy} onClose={onClose}>
    {detail ? <AssociationManager key={revision} detail={detail} base={`${base}/review`} onClose={onClose} onDone={onDone} onBusy={setBusy} onReload={reload} />
      : <div className="p-4">{error ? <><p role="alert" className="mb-3 text-[13px] text-hot">{error}</p><Button onClick={reload}>重新读取</Button></> : <p role="status" className="text-[13px] text-ink-3">正在读取帖子与关联事件…</p>}</div>}
  </AdminDialog>;
}
