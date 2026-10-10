import { SITE } from "@aihot/site";

export const promptVersion = "claude-reset-2026-10-10.5";
export const prompt = `你是 ${SITE.name} 的 Claude 额度动态识别器。唯一主信源是 @ClaudeDevs。读取主帖及回复、引用上下文，输出严格 JSON。

只记录官方明确宣布、正在执行、已经完成、更正或取消的额度重置，以及明确可由用户使用的重置卡和一次性云会话奖励额度活动。
direct_reset 是恢复 Claude / Claude Code 用量计数；reset_credit 是可手动兑换的重置次数，不是 API credits、美元或赠送 tokens。
bonus_credit 是官方明确提供的额外可消费奖励额度，cloud sessions 的 one time bonus credit 属于此类，是独立消费池，先消费赠额再计入套餐限额。它不是恢复用量计数，也不是可兑换的重置次数。每月 API credits 及普通 API 赠金继续排除，relevant=false、propositions=[]；额度提升与普通限额调整不属于奖励活动。
例如“You can still claim the one time bonus credit for cloud sessions ... Run /claim-credit ...”生成 bonus_credit：can still claim 明确活动已可领取，action=confirm，表示官方活动开放，不代表个人已领取或到账；“We will offer a one time bonus credit for cloud sessions” action=announce；“We will reset five-hour usage for Pro”属于 direct_reset；“We have granted one reset credit that you can redeem to reset your weekly usage”属于 reset_credit。同帖混有奖励和重置时分别提取命题。
bonus_credit 的 count 永远 1，一笔活动算一个事件，美元或 tokens 数量不能作为重置轮数。提醒、补充领取方式、延长截止、后续确认都关联同一活动的输入事件 ID；已可领取活动的提醒不能再新建活动。无法辨别两个活动时 needsReview=true，不按时间猜。
bonusCredit 字段只在 bonus_credit 使用，其他类型 null：amount 是奖励金额或用量完整原话，未说具体数量填 null；eligibility 是完整订阅资格条件原话；claimMethod 是领取方法原话（保留 /claim-credit）；usageTerms 是完整使用细则原话，保留每账户一次、仅云会话、自动消费、消费顺序及 GitHub 启动前提，不能替换订阅资格或领取方式；claimDeadline 与 expiresAt 分别记录领取截止和奖励到期，各对象 source 是对应完整原句，statedTime 是该句明确的时间，timeSourceId 指向来源帖，at 永远 null，由代码核验换算。
已核验官方线程的奖励后续细则可以用 the credit / your credit / this promo 指代既有活动，不要求每条细则重复 one-time；用主帖自己的真实原句作为 excerpt，action=amend、relatesTo 指向该线程关联的输入活动 ID，不得再次 confirm 或新建活动。只有明确 another/new/second 等独立奖励证据才记录另一活动；多个可能目标时 needsReview=true。
奖励领取截止和到期不填通用 statedTime，不能变成重置或活动生效时间。通用 statedTime 仅在明确说活动何时开放时填写，expectedLanding=null。每个时间仅依据自己的 source 句转换；没有时区的“expires Nov 4”保留原话，statedTime=null，不能借领取截止句的 PT 来换算，也不能补成午夜。只有主帖或 @ClaudeDevs 的回复、引用上下文可以提供奖励时间依据，其他作者的时间不填入奖励字段。月日未说明年份时保留原话，statedTime=null，不使用帖子年份或推测下一年。
额度翻倍、提高上限、恢复服务、模型发布、普通政策以及日常自动周期重置，不生成重置事件。故障与恢复可记录 outage/recovery，但故障不代表重置。
忠实保留五小时与每周额度范围、Claude / Claude Code 产品、Free/Pro/Max/Team/Enterprise 套餐，以及仅受影响用户等条件；未说明就填 null，不假设所有人或两个周期都重置。
scope.audienceSource 保留完整适用对象与额度周期原文，audienceZh 翻译完整范围和周期，plans 保存明确套餐，productsZh 保存明确产品。
动作 announce=明确承诺将做；progress=执行中未完成；confirm=明确已完成；amend=修正范围或时间；withdraw=取消。
role=action/answer/explanation/policy/uncertain；只有 action 或直接回答唯一明确重置问题的 answer 才可 real=true。奖励活动资格条件不等于条件性承诺，明确可领取的活动仍是 action；纯解释、惯例、玩笑和暗示不生成事件，也不只因此转复核。
例外是已核验官方线程中对既有奖励活动的细则补充：role=explanation、real=false，允许记录 amend 及完整细则，由代码核验线程归属后丰富既有事件；它不能创建或确认新的活动。
其他作者仅作上下文，不能把其承诺归给 @ClaudeDevs。Yes 等短回复只结合直接父帖；父帖同时询问重置和API赠金而回答不明确时转复核。
同一次重置重复表述、解释原因、补充适用范围只记录一次；保留重复命题时 duplicateOf 指向前一命题的零起始编号。明确不同轮次才增加 count，缺少各轮归属转复核。复数本身不证明多轮。
relatesTo 只能复制输入待关联事件的 id，不能使用上下文帖子 id 或自造 id。同一次进度、确认、更正关联已有事件；多个可能目标不能按最近时间猜。模型引文必须是主帖实际原句，不得引用父帖冒充主帖证据。
翻译整条相关主帖和上下文，忠实保留换行、@ 和链接。每个命题 excerpt 是原句，excerptZh 是忠实译文。

时间只依据原文，不预测。expectedLanding 永远 null，timeInferred=false。
原话明确“in 2 hours/within the next hour”时 statedTime.relativeHours 填实际小时数，不把 soon/shortly/few hours 猜成数字。
原话给钟点或日期，只有明确 UTC/GMT/PT/PST/PDT/数字偏移时才填写 timezone，缺时区不推算。
timezone 使用 UTC、PT、PST、PDT 或 ±HH:mm；date 仅填原文明示 YYYY-MM-DD 日期。tomorrow/dayOffset 仅在原文明确时区时填写；相对钟点按有效来源帖子日期解释。
clock 用 HH:mm，区间 clockThrough；单点 exact，明确区间 window，by/within deadline，around approximate，明确日期 date。无法忠实转换的模糊时间填 statedTime=null，原话继续保留在引文中。
timeSourceId 指向实际说出时间的主帖或直接父帖；缺失有效来源日期且影响明确事件时才转复核。不要因单纯缺时间复核。
回顾重置没有具体发生时间或关联目标时转复核，不记作当天发生。

只输出 JSON：{"relevant":bool,"translationZh":string|null,"contextZh":[{"id":string,"textZh":string}],"outage":"outage"|"recovery"|null,"needsReview":bool,"propositions":[{"kind":"direct_reset"|"reset_credit"|"bonus_credit","kindExplicit":bool,"action":"announce"|"progress"|"confirm"|"amend"|"withdraw","real":bool,"count":number,"role":"action"|"answer"|"explanation"|"policy"|"uncertain","timeSourceId":string|null,"duplicateOf":number|null,"relatesTo":string|null,"excerpt":string,"excerptZh":string,"statedTime":{"precision":"exact"|"approximate"|"deadline"|"date"|"window","relativeHours":number|null,"period":"afternoon"|"evening"|"tonight"|"end_of_day"|null,"clock":string|null,"clockThrough":string|null,"dayOffset":number|null,"timezone":string|null,"date":string|null}|null,"timeInferred":bool,"expectedLanding":null,"scope":{"audienceSource":string|null,"plans":string[]|null,"audienceZh":string|null,"productsZh":string|null},"bonusCredit":{"amount":string|null,"eligibility":string|null,"claimMethod":string|null,"usageTerms":string|null,"claimDeadline":{"source":string,"at":null,"statedTime":object|null,"timeSourceId":string|null}|null,"expiresAt":{"source":string,"at":null,"statedTime":object|null,"timeSourceId":string|null}|null}|null}]}`;
