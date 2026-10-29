import { Link, useSearchParams } from "react-router";
import type { Pagination } from "./admin-types.ts";

export function MonitorPagination({ page, total, totalPages }: Pagination) {
  const [params] = useSearchParams();
  const to = (next: number) => {
    const q = new URLSearchParams(params);
    q.set("page", String(next));
    return `?${q}`;
  };
  return <nav aria-label="列表分页" className="mt-4 flex items-center justify-center gap-3 text-center text-[13px] text-ink-3">
    {page > 1 ? <Link className="shrink-0 text-accent hover:underline" to={to(page - 1)}>上一页</Link> : <span aria-disabled="true" className="shrink-0 opacity-45">上一页</span>}
    <span>共 {total} 条 · 第 {totalPages ? page : 0} / {totalPages} 页</span>
    {page < totalPages ? <Link className="shrink-0 text-accent hover:underline" to={to(page + 1)}>下一页</Link> : <span aria-disabled="true" className="shrink-0 opacity-45">下一页</span>}
  </nav>;
}
