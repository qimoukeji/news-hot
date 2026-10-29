import { useState } from "react";
import { Input, Select, Textarea } from "@aihot/web/features/admin/ui";
import { Field } from "./admin-field.tsx";
import { ACTION, stamp, text } from "./components/format.ts";
import type { ActionFact, AdminPost } from "./admin-types.ts";

export function SourcePicker({ posts, selected, onChange }: { posts: AdminPost[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const matching = posts.filter(post => `${text(post.title)} ${post.author}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id));
  const totalPages = Math.ceil(matching.length / 10);
  const currentPage = Math.min(page, Math.max(1, totalPages));
  const visible = matching.slice((currentPage - 1) * 10, currentPage * 10);
  return <section aria-label="选择来源帖子" className="min-w-0">
    <Input aria-label="搜索来源帖子" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="搜索帖子标题或作者" />
    <div className="mt-3 h-[clamp(10rem,calc(100dvh-18rem),28rem)] space-y-3 overflow-y-auto p-1">{visible.map(post => <label key={post.id} className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-1 shrink-0" checked={selected.includes(post.id)} onChange={event => onChange(event.target.checked ? [...selected, post.id] : selected.filter(id => id !== post.id))} /><span className="min-w-0 break-words">{text(post.title) || "无标题帖子"}<span className="block text-[12px] text-ink-4">@{post.author} · {stamp(post.publishedAt)}{post.replyTo && " · 回复"}{post.filteredOut && " · 被过滤，添加有效来源后保留"}</span></span></label>)}{!matching.length && <p className="py-3 text-[13px] text-ink-4">没有可选择的帖子，请调整搜索条件或先采集新的帖子。</p>}</div>
    <nav aria-label="来源帖子分页" className="mt-3 flex items-center justify-center gap-3 border-t border-line pt-3 text-center text-[12px] text-ink-4">
      {currentPage > 1 ? <a className="shrink-0 text-accent hover:underline" href="#" onClick={event => { event.preventDefault(); setPage(currentPage - 1); }}>上一页</a> : <span aria-disabled="true" className="shrink-0 opacity-45">上一页</span>}
      <span>共 {matching.length} 条 · 第 {totalPages ? currentPage : 0} / {totalPages} 页</span>
      {currentPage < totalPages ? <a className="shrink-0 text-accent hover:underline" href="#" onClick={event => { event.preventDefault(); setPage(currentPage + 1); }}>下一页</a> : <span aria-disabled="true" className="shrink-0 opacity-45">下一页</span>}
    </nav>
  </section>;
}
export function FactFields({ value, initial = false, fullWidthText = false, requiresTime = false, showHints = true, fixedAction = false, onChange }: { value: ActionFact; initial?: boolean; fullWidthText?: boolean; requiresTime?: boolean; showHints?: boolean; fixedAction?: boolean; onChange: (value: ActionFact) => void }) {
  return <div className="grid min-w-0 gap-4 md:grid-cols-2">
    <Field label="动作" hint={!showHints ? undefined : initial ? "新事件的第一个动作只能是预告或确认。" : "三类事件使用相同动作；取消请选修订并勾选事件失效。"}><Select disabled={fixedAction} value={value.action} onChange={event => { const action = event.target.value as ActionFact["action"]; onChange({ ...value, action, invalidatesEvent: action === "amend" && value.invalidatesEvent }); }}>{Object.entries(ACTION).map(([key, label]) => <option value={key} key={key} disabled={initial && !["announce", "confirm"].includes(key)}>{label}</option>)}</Select></Field>
    <Field label="明确业务时间" hint={!showHints ? undefined : requiresTime ? "无关联帖子的确认必须填写明确生效时间；支持日期、带时区时间或时间区间。" : "预告留空时保存发帖当天的北京时间日期，其他动作保存发帖时刻；支持日期、带时区时间或时间区间。"}><Input required={requiresTime} value={value.time ?? ""} onChange={event => onChange({ ...value, time: event.target.value.trim() || null })} placeholder="2026-10-23 或 2026-10-23T08:00:00Z" /></Field>
    <div className={fullWidthText ? "md:col-span-2" : undefined}><Field label="动作标题（中文）"><Input required value={text(value.title)} onChange={event => onChange({ ...value, title: { zh: event.target.value } })} /></Field></div>
    <div className={fullWidthText ? "md:col-span-2" : undefined}><Field label="动作摘要（中文）"><Textarea value={text(value.summary)} onChange={event => onChange({ ...value, summary: event.target.value.trim() ? { zh: event.target.value } : null })} /></Field></div>
    {value.action === "amend" && <label className="flex items-start gap-2 text-[13px] md:col-span-2"><input type="checkbox" className="mt-1" checked={value.invalidatesEvent} onChange={event => onChange({ ...value, invalidatesEvent: event.target.checked })} /><span>取消活动，使事件失效{showHints && <span className="mt-1 block text-[12px] text-ink-4">保留历史和来源，退出总览时间、次数与间隔统计。须有官方明确取消依据。</span>}</span></label>}
  </div>;
}
export const factOf = (action: ActionFact): ActionFact => ({ action: action.action, invalidatesEvent: action.invalidatesEvent, title: action.title, summary: action.summary, time: action.time });
export const emptyFact = (): ActionFact => ({ action: "announce", invalidatesEvent: false, title: { zh: "" }, summary: null, time: null });
