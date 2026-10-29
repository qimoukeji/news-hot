import { beijingDate, beijingTime } from "@aihot/contracts/time";
import type { EventStatus } from "../../public-v2.ts";

export const KIND = { direct_reset: "额度重置", reset_credit: "重置卡", bonus_credit: "奖励额度" };
export const ACTION = { announce: "预告", confirm: "确认", progress: "进展", amend: "修订" };
export const PROCESSING_STATUS = { pending: "待识别", processed: "已处理", needs_attention: "待处理", failed: "处理失败" };
export const STATUS: Record<EventStatus, string> = { announced: "已预告", in_progress: "进行中", completed: "已完成", cancelled: "已取消" };
export const text = (value: { zh?: string; en?: string } | null | undefined) => value?.zh ?? value?.en ?? "";
export function eventDate(value: string) {
  const start = value.split("/")[0]!;
  return start.length === 10 ? start : beijingDate(start);
}
export function stamp(value: string | null | undefined): string {
  if (!value) return "—";
  return value.split("/").map(at => at.length === 10 ? at : `${beijingDate(at)} ${beijingTime(at)}`).join(" – ");
}
