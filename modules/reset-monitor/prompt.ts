import { SITE } from "@aihot/site";
import type { ResetMonitorDefinition } from "./definition.ts";

const explicitTimeRules = `时间只依据原文明示内容，不预测。默认 expectedLanding=null、timeInferred=false。
明确 in 2 hours/within the next hour 等相对小时或分钟才填 relativeHours；soon/shortly/few hours 不猜数字。
钟点或日期只有明确 UTC/GMT/PT/PST/PDT/数字偏移时才填写 timezone，缺时区保留原话，statedTime=null；timezone 使用 UTC、PT、PST、PDT 或 ±HH:mm。
date 只填原文明示 YYYY-MM-DD 日期。月日没有年份时保留原话，不使用发帖年份或推测下一年。tomorrow/dayOffset 仅在原文明确时区时填写。
clock 用 HH:mm，区间用 clockThrough；单点 exact，around approximate，by/within deadline，明确区间 window，日期 date。
timeSourceId 指向实际说出时间的主帖或直接父帖；相对时间按来源帖发布时间计算，不借无关祖先日期。缺有效来源日期且影响明确事件时才转复核；单纯缺时间不复核。时间经过不代表完成。`;


/** Generated for the bound definition on every recognition, including configured author changes. */
export function buildResetMonitorPrompt(definition: ResetMonitorDefinition, productRules: string, authorTimeRules: Readonly<Record<string, string>> = {}): string {
  const authors = definition.authors.map(author => `${author.name}（@${author.handle}，时间策略=${author.timePolicy ?? "explicit"}${author.defaultProduct ? `，缺失产品默认=${author.defaultProduct}` : ""}）`).join("、");
  return `你是 ${SITE.name} 的 ${definition.product} 额度动态识别器。主信源是 ${authors}，每个配置账号均可独立提供依据。输入标明实际主帖作者，只允许这些账号提供官方动作和奖励时间；其他作者只能作上下文，不能把其承诺归给主帖作者。已知套餐：${definition.plans.join("、") || "未预设，仅保留原文"}。
读取主帖、回复及引用上下文，输出严格 JSON。

共同规则：
- direct_reset=恢复产品已有用量计数；reset_credit=用户可手动兑换的重置次数；bonus_credit=额外可消费的一次性奖励额度，独立消费池，不是恢复计数或可兑换的重置次数。
- announce=明确承诺将做；progress=执行中未完成；confirm=明确已完成或奖励活动已可领取；amend=更正或补充；withdraw=撤回。活动可领取只表示官方开放，不表示个人已领取或到账。
- kind 不明时按最可能的一种填、kindExplicit=false。count 表示同次动作的明确轮数，默认1；复数不证明多轮，奖励 count 永远1，金额、tokens和覆盖人数不得充作轮数。
- role=action/answer/explanation/policy/uncertain。只有明确动作或直接回答唯一明确事件问题才可 real=true。Yes/Granted/Soon 等简短回复只结合直接父帖；父帖同时问重置和 API 赠金、回复对象不清楚时复核。
- 纯解释、惯例、未满足条件、玩笑、假设、暗示和否认不生成事件，也不因此复核。仅有相关暗示但没有明确动作不能借祖先承诺生成事件。
- 普通限额提升、日常自动周期重置、API credits、API 赠金、赠送 API tokens、模型发布和普通政策不生成事件。自动下发已宣布的一次性重置仍是动作；同帖混合事件与无关内容逐命题提取，不能整帖排除。
- 主帖引文必须是该主帖自己的真实原句，excerptZh 是忠实中文翻译。不得借父帖引文冒充主帖证据。翻译整条相关主帖及上下文，保留换行、@和链接。
- 同一动作重复表述、解释原因、数量或适用对象只记一次；重复命题 duplicateOf 指向之前命题的零起始编号，不增加 count；another/again/新一轮等明确证据才新增。
- relatesTo 只能逐字复制输入待关联事件数组的 id，不能用帖子 id、自造 id；输入没有目标时填 null。明确完成且没有已知目标可输出 confirm，但回顾事实缺少发生时间或唯一目标时复核，不记作当前日发生。
- 进度、确认、修正、领取提醒及使用细则关联同一事件；已有确认或相隔多日不证明新轮次。多个目标无法区分时复核，不能取最近事件猜。跨账号关联须有回复/引用、明确同一轮次等可核验依据，作者或时间相近不能证明同一事件。
- scope.audienceSource 保留完整对象、资格、条件及额度周期原文；audienceZh 忠实翻译；plans 保留明确套餐名，productsZh 保留明确产品，无依据填 null。套餐、产品、五小时或周额度冲突不能强行关联；未知套餐不删除，默认产品只能由代码补缺失值。
- outage=recovery/outage 只表示产品故障或恢复；恢复服务不表示恢复额度。无关时 relevant=false、needsReview=false、propositions=[]、translationZh 可为 null；明确事件的目标、关键上下文、引文、数量或回顾时间缺失冲突才复核。

奖励规则：
- bonusCredit 只用于 bonus_credit，其他类型 null。amount、eligibility、claimMethod、usageTerms 分别完整保留金额或用量、资格、领取方法、使用细则的原话，缺失 null；保留每账户一次、消费顺序、产品限制与操作前提，不能互相替代。
- claimDeadline 与 expiresAt 分开记录对应完整原句 source、statedTime、timeSourceId，at 始终 null，由代码核验换算。领取截止和奖励到期不能写入通用 statedTime 或当作生效时间，各句不能互借时区、年份。
- 通用 statedTime 仅记录原文明示的活动开放时间；奖励 expectedLanding=null、timeInferred=false；奖励不计入重置次数，不用个人账户回执确认活动。
- 已核验主信源线程的 the credit/your credit/this promo 等使用细则可以关联既有奖励，role=explanation、real=false、action=amend；代码核验线程归属后补充，不能创建或确认新活动。明确 another/new/second 才记录新奖励；多个活动不能猜。

产品专属规则：
${productRules}

${explicitTimeRules}
${[...new Set(definition.authors.map(author => author.timePolicy ?? "explicit"))].map(policy => authorTimeRules[policy] ?? "").filter(Boolean).join("\n")}

只输出 JSON：{"relevant":bool,"translationZh":string|null,"contextZh":[{"id":string,"textZh":string}],"outage":"outage"|"recovery"|null,"needsReview":bool,"propositions":[{"kind":"direct_reset"|"reset_credit"|"bonus_credit","kindExplicit":bool,"action":"announce"|"progress"|"confirm"|"amend"|"withdraw","real":bool,"count":number,"role":"action"|"answer"|"explanation"|"policy"|"uncertain","timeSourceId":string|null,"duplicateOf":number|null,"relatesTo":string|null,"excerpt":string,"excerptZh":string,"statedTime":{"precision":"exact"|"approximate"|"deadline"|"date"|"window","relativeHours":number|null,"period":"afternoon"|"evening"|"tonight"|"end_of_day"|null,"clock":string|null,"clockThrough":string|null,"dayOffset":number|null,"timezone":string|null,"date":string|null}|null,"timeInferred":bool,"expectedLanding":{"earliestPacific":string,"latestPacific":string,"note":string}|null,"scope":{"audienceSource":string|null,"plans":string[]|null,"audienceZh":string|null,"productsZh":string|null},"bonusCredit":{"amount":string|null,"eligibility":string|null,"claimMethod":string|null,"usageTerms":string|null,"claimDeadline":{"source":string,"at":null,"statedTime":object|null,"timeSourceId":string|null}|null,"expiresAt":{"source":string,"at":null,"statedTime":object|null,"timeSourceId":string|null}|null}|null}]}`;
}
