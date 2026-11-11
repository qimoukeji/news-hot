import { Link } from "react-router";
import { Badge, Card, DataTable, Empty, Time } from "@aihot/web/features/admin/ui";
import type { ReviewNotificationRunData } from "../review-notification-run-data.ts";
import { reviewNotificationErrorMessage, reviewNotificationRunResult } from "./review-notification-run-result.ts";

export default function ReviewNotificationRuns({ data }: { data: unknown }) {
  const { latest, history, issues, monitors } = data as ReviewNotificationRunData;
  const result = latest ? reviewNotificationRunResult(latest, monitors) : null;
  return <Card title="帖子人工核对通知" className="mt-5" pad={false}>
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <span>最近一次执行</span>
        {latest && result ? <><Time at={latest.finishedAt ?? latest.startedAt} /><Badge tone={result.tone}>{result.label}</Badge></> : <span>暂无执行记录</span>}
      </div>
      {result?.summary && <p className="mt-1 text-[12.5px] text-ink-3">{result.summary}</p>}
    </div>
    {history.length > 0 && <div className="flex max-h-72 flex-col border-t border-line">
      <h3 className="px-4 py-2 text-[12.5px] font-medium text-ink-2">近期执行记录</h3>
      <DataTable dense scrollable rows={history.map(run => ({ ...run, result: reviewNotificationRunResult(run, monitors) }))} rowKey={run => run.id} columns={[
        { key: "time", label: "执行时间", render: run => <Time at={run.finishedAt ?? run.startedAt} /> },
        { key: "status", label: "执行结果", render: run => <Badge tone={run.result.tone}>{run.result.label}</Badge> },
        { key: "detail", label: "通知统计", render: run => <span className="text-ink-3">{run.result.summary ?? "—"}</span> },
      ]} />
    </div>}
    <div className="flex max-h-72 flex-col border-t border-line">
      <h3 className="px-4 py-2 text-[12.5px] font-medium text-ink-2">近期发送失败或结果未知的轮次</h3>
      {issues.length ? <DataTable dense scrollable rows={issues} rowKey={issue => `${issue.monitorId}:${issue.postId}:${issue.attemptedAt}`} columns={[
        { key: "post", label: "帖子", render: issue => <Link className="text-accent hover:underline" to={`${monitors[issue.monitorId].adminPath}?${new URLSearchParams({ kind: "posts", q: issue.postId, collectionFilter: "all" })}`}>{monitors[issue.monitorId].product} · {issue.postId}</Link> },
        { key: "status", label: "发送结果", render: issue => <Badge tone={issue.status === "failed" ? "bad" : "warn"}>{issue.status === "failed" ? "发送失败" : "结果未知"}</Badge> },
        { key: "time", label: "尝试时间", render: issue => <Time at={issue.attemptedAt} /> },
        { key: "error", label: "原因", render: issue => issue.error ? reviewNotificationErrorMessage(issue.error) : issue.status === "unknown" ? "发送结果未确认；不重试" : "未记录原因" },
      ]} /> : <Empty>近期没有发送失败或结果未知的轮次</Empty>}
    </div>
  </Card>;
}
