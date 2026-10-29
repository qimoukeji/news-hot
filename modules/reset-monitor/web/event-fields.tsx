import { Input, Select, Textarea } from "@aihot/web/features/admin/ui";
import { Field } from "./admin-field.tsx";
import { useMonitor } from "./context.tsx";
import { KIND } from "./components/format.ts";
import type { EventKind, EventDraft } from "./admin-types.ts";
export type { EventDraft } from "./admin-types.ts";

export function EventFields({ value, onChange, requiredTitle = false }: { value: EventDraft; onChange: (patch: Partial<EventDraft>) => void; requiredTitle?: boolean }) {
  const { eventKinds } = useMonitor();
  return <>
    <Field label="类型"><Select value={value.type} onChange={event => onChange({ type: event.target.value as EventKind })}>{eventKinds.map(kind => <option key={kind} value={kind}>{KIND[kind]}</option>)}</Select></Field>
    <Field label="标题（中文）"><Input required={requiredTitle} value={value.title} onChange={event => onChange({ title: event.target.value })} /></Field>
    <Field label="摘要（中文）"><Textarea value={value.summary} onChange={event => onChange({ summary: event.target.value })} /></Field>
    <Field label="影响范围（中文）" hint="说明适用用户、套餐或额度限制。"><Textarea value={value.scope} onChange={event => onChange({ scope: event.target.value })} /></Field>
  </>;
}
