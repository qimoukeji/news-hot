import { monitor as currentMonitor, monitorId, author, purpose as requestPurpose, auditAction, auditSubject } from "./context.ts";
import type { ResetMonitorPageData, ResetMonitorEvent } from "../contracts.ts";
import { answer, stamp, NO_INTERNALS } from "@aihot/backend/publication/agent";
import { siteUrl } from "@aihot/backend/publication/links";
import { eventDisplayLabel } from "../event-kind.ts";
import { quotaScopeLabel } from "../quota-scope.ts";

const OPEN = new Set(["announced", "in_progress", "expired_unconfirmed"]);

function monitorEvent(e: ResetMonitorEvent, now: number): string[] {
  const status = e.presentation?.status ?? (e.status === "confirmed" ? "confirmed" : "announced");
  if (e.type === "bonus_credit") {
    const b = e.presentation?.bonusCredit;
    const lines = [`- 【奖励额度】${e.title}`, `  活动状态：${status === "expired" ? "奖励已到期" : status === "claim_closed" ? "领取已截止" : status === "available" ? "符合资格者可领取；不表示个人已领取或到账" : "官方预告，尚未确认开放"}`];
    for (const [label, value] of [["奖励", b?.amount], ["资格", b?.eligibility], ["领取方式", b?.claimMethod], ["使用细则", b?.usageTerms]] as const) if (value) lines.push(`  ${label}：${value}`);
    for (const [label, value] of [["领取截止", b?.claimDeadline], ["奖励到期", b?.expiresAt]] as const) lines.push(`  ${label}：${value?.at ? `北京时间 ${stamp(value.at, now)}（原话：${value.source}）` : `${value?.source ?? "原帖未说明"}；时间未说明`}`);
    lines.push(`  适用范围：${e.presentation?.audienceZh ?? e.presentation?.scopeLabel ?? "原帖没说明"}${e.presentation?.productsZh ? ` · ${e.presentation.productsZh}` : ""}`);
    if (e.posts[0]) lines.push(`  ${currentMonitor().authorName} 原帖：${e.posts[0].text} ${e.posts[0].url}`);
    return lines;
  }
  const timing = currentMonitor().timePolicy === "explicit" ? "原帖时间" : "预计时间";
  const note = status === "likely_completed" ? "（按预计时间应已生效，但没有确认帖）" : status === "expired_unconfirmed" ? `（已过${timing}，仍在等待确认）` : "";
  const lines = [`- ${e.type === "reset_credit" ? "【发重置卡】" : "【额度重置】"}${e.title}${note}`];
  const receipt = e.confirmationBasis === "receipt_review";
  if (receipt) lines.push(`  人工核实到账：${e.occurredOn ?? "到账日期未确定"}（已核实账户收到；不代表 ${currentMonitor().authorName} 已发确认帖，也不代表所有账户都已到账）`);
  else if (e.confirmedAt) lines.push(`  确认帖：${stamp(e.confirmedAt, now)}（确认帖的时间，不是精确到账时间）`);
  else if (e.occurredOn) lines.push(`  核实到账：${e.occurredOn}`);
  const window = e.estimate ?? e.schedule;
  if (e.status !== "confirmed" && window?.from) {
    lines.push(`  ${currentMonitor().timePolicy === "explicit" ? "原帖时间" : "预计"}：${stamp(window.from, now)}${window.through ? ` 至 ${stamp(window.through, now)}` : ""}${e.estimate?.reason ? `（${e.estimate.reason}）` : ""}`);
  }
  if (e.status !== "confirmed" && !window && currentMonitor().timePolicy === "explicit") lines.push("  时间未说明（原话见原帖）");
  const who = e.presentation?.audienceZh ?? e.presentation?.scopeLabel ?? "原帖没说明";
  const cycle = quotaScopeLabel(e.presentation?.quotaScope);
  lines.push(`  适用范围：${who}${e.presentation?.productsZh ? ` · ${e.presentation.productsZh}` : ""}${cycle ? ` · ${cycle}` : ""}`);
  const post = e.posts[0];
  if (post) lines.push(`  ${receipt ? `${currentMonitor().authorName} 相关原帖（仅作背景，不是到账确认）` : `${currentMonitor().authorName} 原帖`}${post.publishedAt ? `（${stamp(post.publishedAt, now)}）` : ""}：${post.text} ${post.url}`);
  return lines;
}

export function monitorAnswer(d: ResetMonitorPageData, now = Date.now()): string {
  const hasBonus = currentMonitor().eventKinds.includes("bonus_credit");
  const kinds = currentMonitor().eventKinds.map(eventDisplayLabel).join("、");
  const weekAgo = now - 7 * 86400_000;
  const open = d.events.filter((e) => e.presentation && OPEN.has(e.presentation.status));
  const recent = d.events.filter((e) => !open.includes(e) && e.updatedAt !== null && Date.parse(e.updatedAt) >= weekAgo).slice(0, 6);
  const available = d.events.filter((e) => e.type === "bonus_credit" && e.presentation?.status === "available" && !open.includes(e) && !recent.includes(e));
  const last = d.lastLanded && !open.includes(d.lastLanded) && !recent.includes(d.lastLanded) ? d.lastLanded : null;
  const data = [
    "## 正在等待生效的预告",
    ...(open.length ? open.flatMap((e) => monitorEvent(e, now)) : [`- 监控记录中没有 ${currentMonitor().authorName} 已宣布、还没生效的${hasBonus ? "额度活动" : "重置或发卡"}。`]),
    ...(available.length ? ["", "## 可领取的奖励活动", ...available.flatMap((e) => monitorEvent(e, now))] : []),
    "",
    "## 最近 7 天",
    ...(recent.length ? recent.flatMap((e) => monitorEvent(e, now)) : [`- 监控记录中最近 7 天没有新的${hasBonus ? "额度活动" : "重置或发卡"}。`]),
    ...(last ? ["", "## 上一次", ...monitorEvent(last, now)] : []),
    ...(d.outage?.publishedAt
      ? ["", "## 故障", `- ${currentMonitor().authorName} ${stamp(d.outage.publishedAt, now)} 确认 ${currentMonitor().product} 故障${d.outage.recoveredAt ? `，${stamp(d.outage.recoveredAt, now)} 恢复` : ""}：${d.outage.text ?? d.outage.originalText} ${d.outage.url}`]
      : []),
  ];
  const checked = d.checkedAt ? `最近一次完整核对：北京时间 ${stamp(d.checkedAt, now)}。` : "";
  const monitor = d.monitor?.status === "healthy" ? "监控正常。" : "监控数据可能有延迟，结果不一定是最新的。";
  return answer([
    `# ${hasBonus ? currentMonitor().title ?? `${currentMonitor().product} 额度动态` : `${currentMonitor().product} 额度重置（公告与到账核实）`}`,
    "",
    `${monitor}${checked}近 90 天额度重置 ${d.stats.resets90} 次、发重置卡 ${d.stats.credits90} 次${hasBonus ? `、奖励额度活动 ${d.stats.bonuses90} 次` : ""}${d.stats.lastResetDate ? `，上一次确认的额度重置在 ${d.stats.lastResetDate}` : ""}。`,
    `日历与全部记录：${siteUrl(currentMonitor().pagePath)}`,
  ], data, [
    hasBonus ? `区分${kinds}；奖励活动可领取不代表个人已领取或到账，领取截止与奖励到期分别表达；缺时间或时区保留原话。` : `先分清「额度重置」和「发重置卡」，再说清是 ${currentMonitor().authorName} 的预告还是已确认的事实；时间写北京时间。`,
    `人工核实到账和 ${currentMonitor().authorName} 发帖确认是两种证据；前者只说明已核实账户收到，不能说成 ${currentMonitor().authorName} 确认或所有用户都已到账。`,
    currentMonitor().timePolicy === "explicit" ? "仅换算原帖明确时间；时间未说明时保留原话，过了原帖时间也不代表完成。" : "预计时间只是估计，过了预计时间不等于已经完成；标注「应已生效」的也没有确认帖。",
    "没有预告就说目前没有公布下一次，不要根据过去的间隔推测；这里没有任何人的个人额度。",
    NO_INTERNALS,
  ]);
}
