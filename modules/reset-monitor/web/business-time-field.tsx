import { useEffect, useRef, useState, type ReactNode } from "react";
import { Input, Select } from "@aihot/web/features/admin/ui";
import type { BusinessTime } from "../public-v2.ts";
import { Field } from "./admin-field.tsx";
import { stamp } from "./components/format.ts";
import { defaultTimeZone, fromTimeInput, toTimeInput, type TimeInput, type TimeInputKind } from "./business-time.ts";

const timeZones = [
  { value: "America/Los_Angeles", label: "太平洋时间" },
  { value: "UTC", label: "UTC" },
  { value: defaultTimeZone, label: "北京时间" },
];

export function BusinessTimeField({ actionField, value, sourcedConfirmAt, onChange }: { actionField: ReactNode; value: BusinessTime | null; sourcedConfirmAt?: string; onChange: (value: BusinessTime | null) => void }) {
  const [input, setInput] = useState(() => toTimeInput(value));
  const [error, setError] = useState("");
  const validity = useRef<HTMLSelectElement>(null);
  const preserved = useRef(value);
  useEffect(() => { validity.current?.setCustomValidity(error || (input.kind === "empty" ? "请选择明确的业务时间" : "")); }, [error, input.kind, sourcedConfirmAt]);
  const change = (patch: Partial<TimeInput>) => {
    const next = { ...input, ...patch };
    setInput(next);
    try {
      const result = fromTimeInput(next, preserved.current);
      preserved.current = result;
      validity.current?.setCustomValidity(next.kind === "empty" ? "请选择明确的业务时间" : "");
      setError(""); onChange(result);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "请选择有效的业务时间";
      validity.current?.setCustomValidity(message);
      setError(message);
      onChange(null);
    }
  };
  const changeZone = (timeZone: string) => {
    if (input.kind !== "empty") {
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
    {sourcedConfirmAt ? <Field label="业务时间" hint="取最早的来源帖子发布时间。"><Input readOnly value={stamp(sourcedConfirmAt)} /></Field>
      : <Field label="业务时间"><Select ref={validity} required value={input.kind === "empty" ? "" : input.kind} onChange={event => {
      const kind = (event.target.value || "empty") as TimeInputKind;
      change({ kind, start: "", end: "" });
    }}>
      <option value="">请选择时间</option><option value="instant">具体时刻</option><option value="range">时间区间</option><option value="deadline">截止时间</option>
    </Select></Field>}
    {!sourcedConfirmAt && input.kind !== "empty" && <div className="col-span-2 grid min-w-0 gap-3 sm:grid-cols-2">
      <Field label="时间时区"><Select value={input.timeZone} onChange={event => changeZone(event.target.value)}>
        {timeZones.map(zone => <option key={zone.value} value={zone.value}>{zone.label}</option>)}
      </Select></Field>
      <Field label={input.kind === "range" ? "开始时间" : input.kind === "deadline" ? "截止时间" : "业务时刻"}>
        <Input required type="datetime-local" step="1" value={input.start} onChange={event => change({ start: event.target.value })} />
      </Field>
      {input.kind === "range" && <Field label="结束时间"><Input required type="datetime-local" step="1" value={input.end} onChange={event => change({ end: event.target.value })} /></Field>}
    </div>}
    {!sourcedConfirmAt && error && <p role="alert" className="col-span-2 text-[12px] text-hot">{error}</p>}
  </section>;
}
