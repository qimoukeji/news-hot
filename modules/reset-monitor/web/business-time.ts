import { Temporal } from "@js-temporal/polyfill";
import type { BusinessTime } from "../public-v2.ts";

export const defaultTimeZone = "Asia/Shanghai";
export type TimeInputKind = BusinessTime["kind"] | "empty";
export type TimeInput = { kind: TimeInputKind; timeZone: string; start: string; end: string };

export function businessDate(value: BusinessTime | null, timeZone = defaultTimeZone, publishedAt?: string): string {
  if (value === null) {
    if (!publishedAt) throw new Error("未知业务时间需要来源发布时间归日");
    return Temporal.Instant.from(publishedAt).toZonedDateTimeISO(timeZone).toPlainDate().toString();
  }
  return value.kind === "date" ? value.date : Temporal.Instant.from(value.kind === "range" ? value.from : value.at).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}


export function toTimeInput(value: BusinessTime | null, timeZone = value?.kind === "date" ? value.timeZone : defaultTimeZone): TimeInput {
  const local = (at: string) => Temporal.Instant.from(at).toZonedDateTimeISO(timeZone).toPlainDateTime().toString({ smallestUnit: "second" });
  return { kind: value?.kind ?? "empty", timeZone,
    start: !value ? "" : value.kind === "date" ? value.date : local(value.kind === "range" ? value.from : value.at),
    end: value?.kind === "range" ? local(value.through) : "" };
}

/** Reject both missing and repeated local clock times rather than silently shifting them. */
export function fromTimeInput(input: TimeInput, original: BusinessTime | null = null): BusinessTime | null {
  if (input.kind === "empty") return null;
  if (!input.start || input.kind === "range" && !input.end) throw new Error("请选择完整的业务时间");
  if (/^[+-]/.test(input.timeZone)) throw new Error("请选择有效的 IANA 时区");
  try { new Intl.DateTimeFormat("en", { timeZone: input.timeZone }); } catch { throw new Error("请选择有效的 IANA 时区"); }
  if (input.kind === "date") return { kind: "date", date: Temporal.PlainDate.from(input.start).toString(), timeZone: input.timeZone };
  const prior = original?.kind === input.kind ? toTimeInput(original, input.timeZone) : null;
  const instant = (at: string, edge: "start" | "end") => {
    if (prior && original && original.kind !== "date" && Temporal.PlainDateTime.compare(prior[edge], at) === 0) {
      return original.kind === "range" ? original[edge === "start" ? "from" : "through"] : original.at;
    }
    try { return Temporal.PlainDateTime.from(at).toZonedDateTime(input.timeZone, { disambiguation: "reject" }).toInstant().toString(); }
    catch { throw new Error("该本地时刻无效或存在夏令时歧义，请调整时间或选择 UTC"); }
  };
  const at = instant(input.start, "start");
  if (input.kind !== "range") return { kind: input.kind, at };
  const through = instant(input.end, "end");
  if (Temporal.Instant.compare(through, at) < 0) throw new Error("结束时间不能早于开始时间");
  return { kind: "range", from: at, through };
}
