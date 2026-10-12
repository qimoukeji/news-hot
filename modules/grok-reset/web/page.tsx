import { createPublicLoader, publicHeaders } from "@aihot/reset-monitor/web/loaders.server";
import { createPublicPage } from "@aihot/reset-monitor/web/page";
import { useMonitor } from "../../reset-monitor/web/context.tsx";
import type { ResetMonitorSitePage } from "@aihot/reset-monitor/contracts";
import { definition } from "../definition.ts";

function TimingHelp({ data }: { data: ResetMonitorSitePage }) {
  const { authors } = useMonitor();
  return <>
    <p><strong className="font-semibold text-ink-3">明确时间才换算。</strong>原帖明确的时区或相对时长换算为北京时间；缺时间显示“时间未说明”，不预测到账。</p>
    <p><strong className="font-semibold text-ink-3">按产品与套餐记录。</strong>原帖未说明产品时，只使用该账号配置的默认产品；明确说明时按原文记录，不覆盖已有信息，套餐不推测。</p>
    <p><strong className="font-semibold text-ink-3">活动开放与个人到账分别记录。</strong>奖励可领取不表示个人已领取或到账，领取截止与奖励到期独立记录。普通限额调整、API 赠金和日常自动重置不生成事件。</p>
    <p><strong className="font-semibold text-ink-3">持续跟踪配置账号。</strong>每 {data.scanMinutes} 分钟检查 {authors.map(author => `@${author.handle}`).join("、")}，其他作者只作必要上下文。个人额度以产品内显示为准。</p>
  </>;
}
const route = createPublicPage({ ...definition, timingHelp: TimingHelp });
export const loader = createPublicLoader(definition);
export const headers = publicHeaders;
export const { handle, meta } = route;
export default route.default;
