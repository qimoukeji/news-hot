import type { CodexResetPageData, CodexResetEvent } from "../contracts.ts";
import { answer, stamp, NO_INTERNALS } from "@aihot/backend/publication/agent";
import { siteUrl } from "@aihot/backend/publication/links";

const OPEN = new Set(["announced", "in_progress", "expired_unconfirmed"]);

function codexEvent(e: CodexResetEvent, now: number): string[] {
  const status = e.presentation?.status ?? (e.status === "confirmed" ? "confirmed" : "announced");
  const note = status === "likely_completed" ? "（按预计时间应已生效，但没有确认帖）" : status === "expired_unconfirmed" ? "（已过预计时间，仍在等待确认）" : "";
  const lines = [`- ${e.type === "reset_credit" ? "【发重置卡】" : "【额度重置】"}${e.title}${note}`];
  const receipt = e.confirmationBasis === "receipt_review";
  if (receipt) lines.push(`  人工核实到账：${e.occurredOn ?? "到账日期未确定"}（已核实账户收到；不代表 Tibo 已发确认帖，也不代表所有账户都已到账）`);
  else if (e.confirmedAt) lines.push(`  确认帖：${stamp(e.confirmedAt, now)}（确认帖的时间，不是精确到账时间）`);
  else if (e.occurredOn) lines.push(`  核实到账：${e.occurredOn}`);
  const window = e.estimate ?? e.schedule;
  if (e.status !== "confirmed" && window?.from) {
    lines.push(`  预计：${stamp(window.from, now)}${window.through ? ` 至 ${stamp(window.through, now)}` : ""}${e.estimate?.reason ? `（${e.estimate.reason}）` : ""}`);
  }
  const who = e.presentation?.audienceZh ?? e.presentation?.scopeLabel ?? "原帖没说明";
  lines.push(`  适用范围：${who}${e.presentation?.productsZh ? ` · ${e.presentation.productsZh}` : ""}`);
  const post = e.posts[0];
  if (post) lines.push(`  ${receipt ? "Tibo 相关原帖（仅作背景，不是到账确认）" : "Tibo 原帖"}${post.publishedAt ? `（${stamp(post.publishedAt, now)}）` : ""}：${post.text} ${post.url}`);
  return lines;
}

export function codexAnswer(d: CodexResetPageData, now = Date.now()): string {
  const weekAgo = now - 7 * 86400_000;
  const open = d.events.filter((e) => e.presentation && OPEN.has(e.presentation.status));
  const recent = d.events.filter((e) => !open.includes(e) && e.updatedAt !== null && Date.parse(e.updatedAt) >= weekAgo).slice(0, 6);
  const last = d.lastLanded && !open.includes(d.lastLanded) && !recent.includes(d.lastLanded) ? d.lastLanded : null;
  const data = [
    "## 正在等待生效的预告",
    ...(open.length ? open.flatMap((e) => codexEvent(e, now)) : ["- 监控记录中没有 Tibo 已宣布、还没生效的重置或发卡。"]),
    "",
    "## 最近 7 天",
    ...(recent.length ? recent.flatMap((e) => codexEvent(e, now)) : ["- 监控记录中最近 7 天没有新的重置或发卡。"]),
    ...(last ? ["", "## 上一次", ...codexEvent(last, now)] : []),
    ...(d.outage?.publishedAt
      ? ["", "## 故障", `- Tibo ${stamp(d.outage.publishedAt, now)} 确认 Codex 故障${d.outage.recoveredAt ? `，${stamp(d.outage.recoveredAt, now)} 恢复` : ""}：${d.outage.text ?? d.outage.originalText} ${d.outage.url}`]
      : []),
  ];
  const checked = d.checkedAt ? `最近一次完整核对：北京时间 ${stamp(d.checkedAt, now)}。` : "";
  const monitor = d.monitor?.status === "healthy" ? "监控正常。" : "监控数据可能有延迟，结果不一定是最新的。";
  return answer([
    "# Codex 额度重置（公告与到账核实）",
    "",
    `${monitor}${checked}近 90 天额度重置 ${d.stats.resets90} 次、发重置卡 ${d.stats.credits90} 次${d.stats.lastResetDate ? `，上一次确认的额度重置在 ${d.stats.lastResetDate}` : ""}。`,
    `日历与全部记录：${siteUrl("/codex-reset")}`,
  ], data, [
    "先分清「额度重置」和「发重置卡」，再说清是 Tibo 的预告还是已确认的事实；时间写北京时间。",
    "人工核实到账和 Tibo 发帖确认是两种证据；前者只说明已核实账户收到，不能说成 Tibo 确认或所有用户都已到账。",
    "预计时间只是估计，过了预计时间不等于已经完成；标注「应已生效」的也没有确认帖。",
    "没有预告就说目前没有公布下一次，不要根据过去的间隔推测；这里没有任何人的个人额度。",
    NO_INTERNALS,
  ]);
}
