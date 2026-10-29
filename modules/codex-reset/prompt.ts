import definition from "./definition.ts";
import { buildResetMonitorPrompt } from "@aihot/reset-monitor/prompt";
import type { ResetMonitorDefinition } from "@aihot/reset-monitor/definition";

export const promptVersion = "codex-reset-actions-2026-10-26.2";
export const productRules = `Codex / ChatGPT Work 的既有额度恢复是 direct_reset；banked reset、manual reset 是 reset_credit。API 赠金、美元和 API tokens 不是奖励额度事件。
“We reset Codex usage”或“Resets all propagated”可明确确认；“rolling out”“50% done”“still propagating”是进展，“100%”“all done”只有明确对应已有事件时才确认。
同一次补偿的覆盖人数和资格解释是同一事实，例如 500k 用户与那两小时内按过按钮的人；补充其条件，不重复建立确认。“明天再给所有人发卡”“another one will come later”有明确新一轮含义时另建事件。
“OK fine”仅在随帖引用或本站已保存直接父帖唯一且明确请求 banked reset 时才可能构成预告；回复本身须提供接受或承诺的依据。父帖缺失或对象不唯一时复核。本帖只说 it 且上下文讨论产品发布，不能把产品发布的星期二赋给重置。
“Just like any other reset, but picture me doing a little dance with it”是定义解释；“Little surprise for you tomorrow”、Maybe、实体 reset button、Claude 玩笑、“Users are up”和“the rules are the rules”不承诺额度动作。
“If this gets blocked, I owe you a reset”是未满足条件。“We're resetting usage twice so people can keep experimenting”若只是解释已宣布两轮，不重复创建两轮。
父内容同时问 API 赠金和重置卡、外层仅说“Yes, check email”时对象不清楚，需复核，不能默认两者都确认。明确回顾已完成的额度动作但没有可解析时间时采用发帖时间；对象或关联不明确仍须复核，不能凭时间猜测目标事件。
三种事件统一使用 announce、confirm、progress、amend。关闭领取、到期和重新开放是 progress，不覆盖确认；官方明确取消整个事件是 amend 且 invalidatesEvent=true，其他动作均为 false。取消后不自动恢复，普通细则修订不改完成状态。`;
export const buildPrompt = (current: ResetMonitorDefinition) => buildResetMonitorPrompt(current, productRules);
export const prompt = buildPrompt(definition);
