import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { Button, Input, Select, Textarea } from "@aihot/web/features/admin/ui";
import { AdminDialog } from "./admin-dialog.tsx";
import { Field } from "./admin-field.tsx";
import { useMonitor } from "./context.tsx";
import { stamp, text } from "./components/format.ts";
import type { AdminPost, AdminReviewDetail } from "./admin-types.ts";

export function PostEditorDialog({ postId, onClose, onDone }: { postId?: string; onClose: () => void; onDone: (post?: Pick<AdminPost, "publishedAt">) => void }) {
  const { adminApiPath } = useMonitor();
  const [post, setPost] = useState<AdminPost | null>(null);
  const [loaded, setLoaded] = useState(!postId);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const reloadPost = () => { setLoaded(false); setError(""); setReload(value => value + 1); };
  useEffect(() => {
    if (!postId) return;
    const controller = new AbortController();
    setLoaded(false); setError("");
    void (async () => {
      try {
        const response = await fetch(`${adminApiPath}/posts/${encodeURIComponent(postId)}`, { credentials: "same-origin", signal: controller.signal });
        if (response.status === 401) { window.location.href = `/api/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`; return; }
        const value = await response.json() as AdminReviewDetail & { detail?: string };
        if (!response.ok || !value.post) throw new Error(value.detail ?? "读取帖子失败，请重试");
        if (!controller.signal.aborted) { setPost(value.post); setLoaded(true); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取帖子失败"); }
    })();
    return () => controller.abort();
  }, [adminApiPath, postId, reload]);
  return <AdminDialog title={postId ? "编辑帖子" : "创建帖子"} busy={busy} onClose={onClose}>
    {loaded ? <PostForm key={reload} post={postId ? post! : undefined} onClose={onClose} onDone={onDone} onBusy={setBusy} onReload={reloadPost} />
      : <div className="p-4">{error ? <><p role="alert" className="mb-3 text-[13px] text-hot">{error}</p><Button onClick={reloadPost}>重新读取</Button></> : <p role="status" className="text-[13px] text-ink-3">正在读取帖子…</p>}</div>}
  </AdminDialog>;
}

function PostForm({ post, onClose, onDone, onBusy, onReload }: { post?: AdminPost; onClose: () => void; onDone: (post?: Pick<AdminPost, "publishedAt">) => void; onBusy: (busy: boolean) => void; onReload: () => void }) {
  const { adminApiPath, authors } = useMonitor();
  const [form, setForm] = useState(() => ({ author: authors[0]?.handle ?? "", publishedAt: "", url: "", title: text(post?.title), summary: text(post?.summary), original: "" }));
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const { run, busy } = useAdminAction();
  const element = useRef<HTMLFormElement>(null);
  useEffect(() => { element.current?.querySelector<HTMLElement>(post ? 'input[aria-label="标题（中文）"]' : "select")?.focus(); }, [post]);
  useLayoutEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const change = (patch: Partial<typeof form>) => { setForm(current => ({ ...current, ...patch })); setError(""); };
  const dirty = !post || form.title.trim() !== text(post.title) || form.summary !== text(post.summary);
  return <form ref={element} className="flex min-h-0 flex-col" onSubmit={async event => {
    event.preventDefault(); if (busy || conflict || !dirty || !form.title.trim()) return;
    const onError = (status: number) => { if (status === 409 && post) setConflict(true); };
    const editorial = { title: { zh: form.title.trim() }, summary: form.summary.trim() ? { zh: form.summary } : null };
    let result: AdminPost | null;
    if (post) {
      const patch = { ...(form.title.trim() !== text(post.title) ? { title: editorial.title } : {}), ...(form.summary !== text(post.summary) ? { summary: editorial.summary } : {}) };
      result = await run<AdminPost>("PATCH", `${adminApiPath}/posts/${encodeURIComponent(post.id)}`, { version: post.version, patch }, { revalidate: false, onError, success: "帖子已保存" });
    }
    else {
      const at = new Date(`${form.publishedAt}+08:00`);
      if (!Number.isFinite(at.getTime())) { setError("请填写有效的发布时间"); return; }
      result = await run<AdminPost>("POST", `${adminApiPath}/posts`, { ...editorial, author: form.author, publishedAt: at.toISOString(), url: form.url.trim(), text: form.original.trim() || null }, { revalidate: false, onError, success: "帖子已创建" });
    }
    if (result) onDone(post ? undefined : result); else setError(post ? "保存失败，请核对后重试" : "创建失败，请核对后重试");
  }}>
    <div className="min-h-0 space-y-4 overflow-y-auto p-4">
      {post && <section aria-label="帖子来源" className="min-w-0 rounded-control border border-line bg-bg-sunk p-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-3"><span>@{post.author}</span><time dateTime={post.publishedAt}>{stamp(post.publishedAt)}</time></div>
        <p className="mt-2 break-all text-ink-4">{post.url}</p>
        {(post.text || post.quotedPost?.text) && <details className="mt-3"><summary className="cursor-pointer text-ink-3">查看已存原文</summary>{post.text && <p aria-label="帖子原文" className="mt-2 whitespace-pre-wrap break-words text-ink-3">{post.text}</p>}{post.quotedPost?.text && <blockquote aria-label="引用原文" className="mt-3 whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-ink-4">{post.quotedPost.text}</blockquote>}</details>}
      </section>}
      <fieldset disabled={busy || conflict} className="min-w-0 space-y-4">
        {!post && <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field label="作者"><Select value={form.author} onChange={event => change({ author: event.target.value })}>{authors.map(author => <option key={author.handle} value={author.handle}>{author.name} · @{author.handle}</option>)}</Select></Field>
          <Field label="发布时间（北京时间）"><Input required type="datetime-local" value={form.publishedAt} onChange={event => change({ publishedAt: event.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="原帖链接"><Input required type="url" value={form.url} onChange={event => change({ url: event.target.value })} /></Field></div>
        </div>}
        <Field label="标题（中文）"><Input required value={form.title} onChange={event => change({ title: event.target.value })} /></Field>
        <Field label="摘要（中文）"><Textarea value={form.summary} onChange={event => change({ summary: event.target.value })} /></Field>
        {!post && <Field label="原文"><Textarea rows={5} value={form.original} onChange={event => change({ original: event.target.value })} /></Field>}
      </fieldset>
      {error && <p role="alert" className="text-[13px] text-hot">{error}</p>}
      {conflict && <div className="space-y-2 text-[13px] text-hot"><p>帖子版本已变化，请重新读取后核对。重新读取将清除当前输入。</p><Button onClick={onReload}>重新读取</Button></div>}
    </div>
    <footer className="flex shrink-0 justify-end gap-2 border-t border-line p-4"><Button tone="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" tone="primary" busy={busy} disabled={conflict || !dirty || !form.title.trim()}>{post ? "保存" : "创建"}</Button></footer>
  </form>;
}
