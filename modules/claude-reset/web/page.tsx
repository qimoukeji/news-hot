import { createPublicLoader, publicHeaders } from "@aihot/reset-monitor/web/loaders.server";
import { createPublicPage } from "@aihot/reset-monitor/web/page";
import type { ResetMonitorSitePage } from "@aihot/reset-monitor/contracts";
import { definition } from "../definition.ts";

function TimingHelp({ data }: { data: ResetMonitorSitePage }) {
  return <>
    <p><strong className="font-semibold text-ink-3">明确时间才换算。</strong>原帖写明时区的时间，或明确的相对小时数，换算为北京时间。未说明时间、无时区钟点和模糊表达保留原话，显示“时间未说明”。</p>
    <p><strong className="font-semibold text-ink-3">分别记录官方活动与个人额度。</strong>奖励活动可领取表示官方已开放活动，个人是否领取以产品内显示为准。领取截止与奖励到期独立记录；缺金额、时间或时区不补齐。重置仍等待官方确认或账户核实。</p>
    <p><strong className="font-semibold text-ink-3">按套餐和额度周期记录。</strong>五小时额度、周额度及适用套餐按原帖说明保留。一次性云会话赠额记录为奖励额度；额度提升、API 赠金、普通限额调整和日常自动重置规则不生成事件。</p>
    <p><strong className="font-semibold text-ink-3">持续跟踪 @ClaudeDevs 的公开帖子。</strong>每 {data.scanMinutes} 分钟检查一次。其他作者只作为必要上下文，不能成为官方承诺。个人额度和重置卡余额以 Claude 内显示为准。</p>
  </>;
}

const route = createPublicPage({ ...definition, timingHelp: TimingHelp });
export const loader = createPublicLoader(definition);
export const headers = publicHeaders;
export const { handle, meta } = route;
export default route.default;
