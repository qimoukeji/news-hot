import { useEffect, useRef, useState, type ReactNode } from "react";
import { Input, Select } from "@aihot/web/features/admin/ui";
import type { BusinessTime } from "../public-v2.ts";
import { Field } from "./admin-field.tsx";
import { defaultTimeZone, fromTimeInput, toTimeInput, type TimeInput, type TimeInputKind } from "./business-time.ts";

const timeZones = [
  { value: "America/Los_Angeles", label: "太平洋时间" },
  { value: "UTC", label: "UTC" },
  { value: defaultTimeZone, label: "北京时间" },
];

export function BusinessTimeField({ actionField, value, required = false, emptyLabel = "未填写", onChange }: { actionField: ReactNode; value: BusinessTime | null; required?: boolean; emptyLabel?: string; onChange: (value: BusinessTime | null) => void }) {
  const [input, setInput] = useState(() => toTimeInput(value));
  const [error, setError] = useState("");
  const validity = useRef<HTMLSelectElement>(null);
  const preserved = useRef(value);
  useEffect(() => { validity.current?.setCustomValidity(error || (required && input.kind === "empty" ? "请选择明确的业务时间" : "")); }, [error, input.kind, required]);
  const change = (patch: Partial<TimeInput>) => {
    const next = { ...input, ...patch };
    setInput(next);
    try {
      const result = fromTimeInput(next, preserved.current);
      preserved.current = result;
      validity.current?.setCustomValidity(required && next.kind === "empty" ? "请选择明确的业务时间" : "");
      setError(""); onChange(result);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "请选择有效的业务时间";
      validity.current?.setCustomValidity(message);
      setError(message);
      onChange(null);
    }
  };
  const changeZone = (timeZone: string) => {
    if (input.kind !== "date" && input.kind !== "empty") {
      try {
        const current = fromTimeInput(input, preserved.current);
        if (current) {
          setInput(toTimeInput(current, timeZone));
          preserved.current = current;
          validity.current?.setCustomValidity("");
          setError(""); onChange(current);
          return;
        }
      } catch { /* Incomplete input keeps its clock fields while selecting an interpretation zone. */ }
    }
    change({ timeZone });
  };
  return <section aria-label="业务时间选择" className="grid min-w-0 grid-cols-2 gap-3 md:col-span-2">
    {actionField}
    <Field label="业务时间"><Select ref={validity} required={required} value={input.kind} onChange={event => {
      const kind = event.target.value as TimeInputKind;
      change({ kind, start: "", end: "" });
    }}>
      <option value="empty">{emptyLabel}</option><option value="instant">具体时刻</option><option value="date">日期</option><option value="range">时间区间</option><option value="deadline">截止时间</option>
    </Select></Field>
    {input.kind !== "empty" && <div className="col-span-2 grid min-w-0 gap-3 sm:grid-cols-2">
      <Field label="时间时区"><Select value={input.timeZone} onChange={event => changeZone(event.target.value)}>
        {!timeZones.some(zone => zone.value === input.timeZone) && <option value={input.timeZone} hidden disabled>原时区：{input.timeZone}</option>}
        {timeZones.map(zone => <option key={zone.value} value={zone.value}>{zone.label}</option>)}
      </Select></Field>
      <Field label={input.kind === "range" ? "开始时间" : input.kind === "date" ? "业务日期" : input.kind === "deadline" ? "截止时间" : "业务时刻"}>
        <Input required type={input.kind === "date" ? "date" : "datetime-local"} step={input.kind === "date" ? undefined : "1"} value={input.start} onChange={event => change({ start: event.target.value })} />
      </Field>
      {input.kind === "range" && <Field label="结束时间"><Input required type="datetime-local" step="1" value={input.end} onChange={event => change({ end: event.target.value })} /></Field>}
    </div>}
    {error && <p role="alert" className="col-span-2 text-[12px] text-hot">{error}</p>}
  </section>;
}
