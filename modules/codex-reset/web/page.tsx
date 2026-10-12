import { createPublicLoader, publicHeaders } from "@aihot/reset-monitor/web/loaders.server";
import { createPublicPage } from "@aihot/reset-monitor/web/page";
import { useMonitor } from "../../reset-monitor/web/context.tsx";
import type { ResetMonitorSitePage } from "@aihot/reset-monitor/contracts";
import { definition } from "../definition.ts";

function TimingHelp({ data: d }: { data: ResetMonitorSitePage }) {
  const { authors } = useMonitor();
  return <>
    <p><strong className="font-semibold text-ink-3">有原话就按原话。</strong>明确的时间与时区换算为北京时间。时间依据按事件记录，其他账号不套用作者惯例；缺时间或时区时保留原话。</p>
    <p><strong className="font-semibold text-ink-3">作者惯例须明确绑定。</strong>只有配置绑定 Tibo 时间策略的作者，才允许对重置或重置卡使用太平洋时间惯例和预计窗口。预计只是参考，以官方确认和 Codex 内用量为准；奖励的开放、领取截止和到期时间均不预测。</p>
    <p><strong className="font-semibold text-ink-3">确认、预计与奖励分开。</strong>官方发帖确认或经账户核实后注明依据，确认帖日期不代表精确到账时间。“应已生效”只适用于允许预测的事件，不等于已确认。奖励可领取不表示个人已领取或到账，也不计入重置次数。</p>
    <p><strong className="font-semibold text-ink-3">持续跟踪配置账号。</strong>每 {d.scanMinutes} 分钟检查 {authors.map(author => `@${author.handle}`).join("、")}。其他作者只作为必要上下文。个人额度、重置卡和奖励余额请在 Codex 内查看。</p>
  </>;
}

const route = createPublicPage({ ...definition, timingHelp: TimingHelp });
export const loader = createPublicLoader(definition);
export const headers = publicHeaders;
export const { handle, meta } = route;
export default route.default;
