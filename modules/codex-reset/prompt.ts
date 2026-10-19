import definition from "./definition.ts";
import { buildResetMonitorPrompt } from "@aihot/reset-monitor/prompt";
import type { ResetMonitorDefinition } from "@aihot/reset-monitor/definition";

export const promptVersion = "codex-reset-2026-10-19.1";
export const productRules = `- Codex / ChatGPT Work 额度恢复属于 direct_reset，banked reset、manual resets 属于 reset_credit。只说 API credits、美元或 API tokens 不构成奖励；明确额外产品一次性消费池才是 bonus_credit。
- “OK fine”直接回应唯一明确的 banked reset 请求，属于答应发卡，role=answer、real=true、action=announce；同句另说“it's coming Tuesday”而祖先讨论产品发布时，不把 it 的星期二强加给重置卡，statedTime=null，不因缺日期转人工。
- “给 500k 用户发卡”后解释“给那两小时内按过按钮的人补发卡”，是同一次补偿，不是两次；“明天再给所有人发卡”才是另一件事。若保留重复原句，duplicateOf 指向前一个相同 kind/action 命题的编号（从 0 开始）；独立事件填 null。重复不能增加 count。
- “Just like any other reset, but picture me doing a little dance with it”回答“什么是 performative reset”，只是解释，不继承祖先帖“Monday reset”的承诺。“Little surprise for you tomorrow”、Maybe 和玩笑即使前文谈重置也只是暗示，按相关或无关处理、needsReview=false；后续明确宣布重置才能接受。
- “We applied the resets automatically”结合父帖已应用的描述，可以确认已有轮次，role=action；解释为什么自动应用不另起事件。“Resets all propagated”明确确认完成，未给数字时 count=1、kindExplicit=false，不仅因复数转复核。
- 同一次补偿的数量描述和对象解释只保留一个命题，将数量及故障窗口条件一起放到 scope：500k 与按过按钮的用户是同一群对象。不得分别输出两个 confirm；明日全员发卡另输出 announce，明确的全员对象、产品不能漏填。
- “And another one will come later in the day”紧接本帖明确 reset 时是同帖另一轮预告；“If this gets blocked, I owe you a reset”是未满足的条件，role=policy、real=false。“Users are up”回答为什么重置，只解释原因；“Reset and accelerate. It's ship week”回答 rest and vest 玩笑、实体 reset button、以及“the rules are the rules”本身不是具体承诺，role=explanation、real=false、needsReview=false。引用带条件政策后“I challenge you to do the same”也不继承成新预告。
- 下发进度（“rolling out”“50% done”“And now 100%”“still propagating”）关联有明确依据的那次重置：未完成用 progress，说完成（100%/all done）用 confirm，relatesTo 指向它。宣布（“we will reset…”“reset landing at 6pm”）和完成确认（“All reset for everyone.”“Reset all propagated.”“The banked reset has landed”“Not so random, but yes” 回答“刚刚是不是重置了”）都是 true；玩笑、假设、提问、条件句（“if we…”）、否认或“没有重置”才是 false。
- relatesTo 只能逐字复制“待关联事件”数组的 id，不能填上下文的原帖 id，也不能用原帖 id 编造 reset-... 事件 id。数组为空或目标不在数组中一律填 null；主帖明确完成且没有已知目标时，仍可输出 confirm 建立确认事实，不因没有待关联事件而复核。“not propagating it at 10am quite perfectly”解释错过时间，不是新的一轮完成，只输出相关解释。
- “We're resetting usage twice so people can keep experimenting”若解释前面宣布的两次重置，不新建命题，不把两次重复相加。“We are”回答长对话优化、对 Claude 重置玩笑敬礼，均不产生活动，也不需要人工。
- 美元额度、API credits、赠送 tokens 不等于重置卡。父帖同时问赠送额度与重置卡、回复只说“Yes, check email”时，确认对象不清楚，needsReview=true，不能默认两者都确认。`;
const tiboTimeRules = `仅配置标为 tibo 的作者及其真实时间依据采用以下惯例，其他账号仍采用明确时间规则：
该作者重置原话的 PST/PT 或无时区钟点按太平洋当地时间解释。主帖明确新时间优先；继承时间只看直接父帖及有效来源，不把其他作者惯例套入。
in the next hour → deadline, relativeHours=1；in the next few hours → deadline,3；over the next 24 hours → deadline,24；in about an hour → approximate,1；in ~3 hours → approximate,3；shortly/soon → approximate,1。
this afternoon → afternoon；this evening → evening；tonight → tonight；end of day/by midnight/today → end_of_day,deadline；只说 tomorrow/on Tuesday 填按来源帖太平洋日期的 dayOffset,date。
否定和条件优先于关键词：“Soon, but not today”不能填 relativeHours=1，不能擅自填明天；无法忠实表达时 statedTime=null、expectedLanding=null，不因缺日期复核。
expectedLanding 仅对非奖励的 announce/progress 给出受原话约束的太平洋窗口 YYYY-MM-DD HH:mm；可参考该作者常在 16:30–21:30 按下，宣布后数小时落地，不得早于原话或延长承诺截止。note 用中文说明依据。
奖励生效、领取截止与到期一律使用明确时间规则，禁止采用作者惯例、默认时区或预测。`;

export const buildPrompt = (current: ResetMonitorDefinition) => buildResetMonitorPrompt(current, productRules, { tibo: tiboTimeRules });
export const prompt = buildPrompt(definition);
