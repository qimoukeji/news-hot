import { beijingDate, beijingTime } from "@aihot/contracts/time";
import type { BusinessTime, EventStatus } from "../../public-v2.ts";
import { businessDate } from "../business-time.ts";
import { formatBusinessTime } from "../../business-time.ts";

export const KIND = { direct_reset: "额度重置", reset_credit: "重置卡", bonus_credit: "奖励额度" };
export const ACTION = { announce: "预告", confirm: "确认", progress: "进展", amend: "修订" };
export const PROCESSING_STATUS = { pending: "待识别", processed: "已处理", needs_attention: "待处理", failed: "处理失败" };
export const STATUS: Record<EventStatus, string> = { announced: "已预告", in_progress: "进行中", completed: "已完成", cancelled: "已取消" };
export const text = (value: { zh?: string; en?: string } | null | undefined) => value?.zh ?? value?.en ?? "";
export const eventDate = businessDate;
export function stamp(value: BusinessTime | string | null | undefined): string {
  if (!value) return "—";
  return typeof value === "string" ? `${beijingDate(value)} ${beijingTime(value)}` : formatBusinessTime(value);
}
