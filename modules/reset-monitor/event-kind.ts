import type { ResetMonitorEventKind } from "./contracts.ts";

export function eventLabel(kind: ResetMonitorEventKind): string {
  return kind === "bonus_credit" ? "奖励额度" : kind === "reset_credit" ? "发重置卡" : "全员重置";
}

export function eventDisplayLabel(kind: ResetMonitorEventKind): string {
  return kind === "bonus_credit" ? "奖励额度" : kind === "reset_credit" ? "重置卡发放" : "额度重置";
}
