import { Link, useSearchParams } from "react-router";
import type { AdminMonitorPagination } from "../contracts.ts";

export function MonitorPagination({ page, total, totalPages }: AdminMonitorPagination) {
  const [params] = useSearchParams();
  const to = (next: number) => {
    const q = new URLSearchParams(params);
    q.set("page", String(next));
    return `?${q}`;
  };
  return <nav aria-label="列表分页" className="mt-4 flex flex-wrap items-center justify-center gap-4 text-[13px] text-ink-3">
    <span>共 {total} 条 · 第 {totalPages ? page : 0} / {totalPages} 页</span>
    {page > 1 && <Link className="text-accent" to={to(page - 1)}>上一页</Link>}
    {page < totalPages && <Link className="text-accent" to={to(page + 1)}>下一页</Link>}
  </nav>;
}
