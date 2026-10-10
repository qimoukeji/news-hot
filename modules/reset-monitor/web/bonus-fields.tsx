import type { ResetMonitorBonusCredit } from "../contracts.ts";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { Input } from "@aihot/web/features/admin/ui";
import { Field } from "./admin-field.tsx";

export const emptyBonus = (): ResetMonitorBonusCredit => ({ amount: null, eligibility: null, claimMethod: null, usageTerms: null, claimDeadline: null, expiresAt: null });

export function BonusCreditFields({ value, onChange }: { value: ResetMonitorBonusCredit | null | undefined; onChange: (value: ResetMonitorBonusCredit) => void }) {
  const bonus = value ?? emptyBonus();
  return <>
    {(["amount", "eligibility", "claimMethod", "usageTerms"] as const).map((key) => <Field key={key} label={{ amount: "奖励金额或用量（原话）", eligibility: "资格条件（原话）", claimMethod: "领取方式（原话）", usageTerms: "使用细则（原话）" }[key]}>
      <Input value={bonus[key] ?? ""} onChange={(e) => onChange({ ...bonus, [key]: e.target.value || null })} />
    </Field>)}
    {(["claimDeadline", "expiresAt"] as const).map((key) => {
      const label = key === "claimDeadline" ? "领取截止" : "奖励到期";
      const time = bonus[key];
      return <div key={key} className="grid gap-3 md:col-span-2 md:grid-cols-2">
        <Field label={`${label}（原话）`} hint="保留原帖时间和时区表述；未说明留空。"><Input value={time?.source ?? ""} onChange={(e) => onChange({ ...bonus, [key]: e.target.value ? { source: e.target.value, at: time?.at ?? null } : null })} /></Field>
        <Field label={`${label}（北京时间）`} hint="原帖明确时间及时区才填写；没有时区就留空。"><Input type="datetime-local" disabled={!time?.source} value={time?.at ? `${beijingDate(time.at)}T${beijingTime(time.at)}` : ""} onChange={(e) => onChange({ ...bonus, [key]: { source: time!.source, at: e.target.value ? `${e.target.value}:00+08:00` : null } })} /></Field>
      </div>;
    })}
  </>;
}
