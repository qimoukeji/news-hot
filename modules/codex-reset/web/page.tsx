import { createPublicLoader, publicHeaders } from "@aihot/reset-monitor/web/loaders.server";
import { createPublicPage } from "@aihot/reset-monitor/web/page";
import type { ResetMonitorSitePage } from "@aihot/reset-monitor/contracts";
import { definition } from "../definition.ts";

const inUsual = (minutes: number) => minutes >= 7 * 60 + 30 && minutes <= 12 * 60 + 30;

function TimingHelp({ data: d }: { data: ResetMonitorSitePage }) {
  return <>
    <p><strong className="font-semibold text-ink-3">有原话就按原话。</strong>Tibo 写了时间（如 “6pm PST”“next hour”“end of day”），按太平洋时间换算成北京时间，并多留一两个小时——他的确认帖通常比说的时间晚一点。只写了日期的，按他以往的习惯落在当天太平洋时间傍晚。</p>
    <p><strong className="font-semibold text-ink-3">没写时间就按习惯。</strong>Tibo 多在太平洋时间 16:30–21:30 按下重置按钮，也就是北京时间第二天早上 07:30–12:30。{d.confirmMinutes.length ? `近 ${d.confirmMinutes.length} 次确认中有 ${d.confirmMinutes.filter(inUsual).length} 次在这个时段。` : ""}推算只是参考，以 Tibo 的确认和你 Codex 里的用量为准。</p>
    <p><strong className="font-semibold text-ink-3">已生效、应已生效、等待中。</strong>Tibo 发帖确认或经账户到账核实后，标为“已生效”，并注明确认依据；确认帖日期不代表精确到账时间。预计时间过去几个小时仍没有确认，显示“应已生效”，不等于已确认。重置卡与额度重置分开记录，发卡不代表额度已恢复。</p>
    <p><strong className="font-semibold text-ink-3">持续跟踪 Tibo 的公开帖子。</strong>每 {d.scanMinutes} 分钟检查一次。只有明确的重置或发卡消息才会推送飞书群。个人额度和重置卡余额请在 Codex 内查看。</p>
  </>;
}

const route = createPublicPage({ ...definition, timingHelp: TimingHelp });
export const loader = createPublicLoader(definition);
export const headers = publicHeaders;
export const { handle, meta } = route;
export default route.default;
