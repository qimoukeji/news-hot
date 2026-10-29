import { z } from "zod";
import { beijingDate } from "@aihot/contracts/time";
import { calendarDate } from "../public-v2.ts";

export function adminTimeFilter(input: { from?: string; to?: string }) {
  const { from, to } = z.object({ from: calendarDate.optional(), to: calendarDate.optional() })
    .refine(range => !range.from || !range.to || range.from <= range.to, { message: "开始日期不能晚于结束日期" })
    .parse(input);
  return (timestamp: string) => {
    const day = beijingDate(timestamp);
    return (!from || day >= from) && (!to || day <= to);
  };
}
