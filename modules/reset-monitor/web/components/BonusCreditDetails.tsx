import type { ResetMonitorBonusCredit, ResetMonitorBonusTime } from "../../contracts.ts";
import { stamp } from "./format";

function BonusTime({ value }: { value: ResetMonitorBonusTime | null | undefined }) {
  if (!value) return <>时间未说明</>;
  return <>{value.source}{value.at ? ` · 北京时间 ${stamp(value.at)}` : " · 时间未说明"}</>;
}

export function BonusCreditDetails({ value }: { value: ResetMonitorBonusCredit | null | undefined }) {
  return <><dl className="mt-3 grid gap-1 text-[12.5px] leading-[1.8] text-ink-3">
    <div><dt className="inline">奖励金额或用量：</dt><dd className="inline">{value?.amount ?? "原帖未说明"}</dd></div>
    <div><dt className="inline">资格条件：</dt><dd className="inline">{value?.eligibility ?? "原帖未说明"}</dd></div>
    <div><dt className="inline">领取方式：</dt><dd className="inline">{value?.claimMethod ?? "原帖未说明"}</dd></div>
    <div><dt className="inline">使用细则：</dt><dd className="inline">{value?.usageTerms ?? "原帖未说明"}</dd></div>
    <div><dt className="inline">领取截止：</dt><dd className="inline"><BonusTime value={value?.claimDeadline} /></dd></div>
    <div><dt className="inline">奖励到期：</dt><dd className="inline"><BonusTime value={value?.expiresAt} /></dd></div>
  </dl><p className="mt-1 text-[12.5px] leading-[1.8] text-ink-4">记录官方奖励活动，个人领取情况及余额以产品内显示为准。</p></>;
}
