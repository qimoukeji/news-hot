import { useState } from "react";
import { Button } from "@aihot/web/features/admin/ui";
import { AdminDialog } from "./admin-dialog.tsx";
import type { AdminPost } from "./admin-types.ts";
import { stamp, text } from "./components/format.ts";
import { SourcePicker } from "./review-fields.tsx";

export function ActionSources({ posts, selected, disabled, canAdd, onAdd, onRemove }: {
  posts: AdminPost[]; selected: string[]; disabled: boolean; canAdd: boolean; onAdd: () => void; onRemove: (id: string) => void;
}) {
  return <section aria-label="已关联帖子" className="min-w-0 rounded-control border border-line">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-3"><h3 className="text-[13px] font-medium">来源帖子 <span className="num text-ink-4">（{selected.length}）</span></h3><Button size="sm" tone="primary" disabled={disabled || !canAdd} onClick={onAdd}>添加关联帖子</Button></header>
    {selected.length ? <ul className="divide-y divide-line">{selected.map(id => {
      const post = posts.find(post => post.id === id)!;
      return <li key={id} className="relative min-w-0 p-3">
        <h4>{text(post.title) || "无标题帖子"}</h4><Button size="sm" tone="danger" className="absolute right-3 top-3" disabled={disabled} aria-label={`移除来源：${text(post.title) || "无标题帖子"}`} onClick={() => onRemove(id)}>移除</Button>
        {post.summary && <p className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-3">{text(post.summary)}</p>}
        <div className="mt-2 flex items-center justify-between gap-3 text-[12px]"><p className="min-w-0 break-words text-ink-4">@{post.author} · {stamp(post.publishedAt)}</p><a className="shrink-0 text-accent hover:underline" href={post.url} target="_blank" rel="noreferrer">查看原帖 ↗</a></div>
      </li>;
    })}</ul> : <p className="p-4 text-[13px] text-ink-4">无关联帖子。确认动作可以不关联帖子，其他动作请添加来源；一个动作可关联多条帖子。</p>}
  </section>;
}

export function AddActionSources({ posts, onClose, onConfirm }: { posts: AdminPost[]; onClose: () => void; onConfirm: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return <AdminDialog title="选择来源帖子" onClose={onClose}>
    <form className="flex min-h-0 flex-col" onSubmit={event => { event.preventDefault(); event.stopPropagation(); if (selected.length) onConfirm(selected); }}>
      <div className="min-h-0 overflow-y-auto p-4"><SourcePicker posts={posts} selected={selected} onChange={setSelected} /></div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line p-4"><span className="mr-auto text-[12px] text-ink-4">已选择 {selected.length} 条</span><Button tone="ghost" onClick={onClose}>取消</Button><Button type="submit" tone="primary" disabled={!selected.length}>确认添加</Button></footer>
    </form>
  </AdminDialog>;
}
