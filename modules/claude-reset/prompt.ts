import definition from "./definition.ts";
import { buildResetMonitorPrompt } from "@aihot/reset-monitor/prompt";
import type { ResetMonitorDefinition } from "@aihot/reset-monitor/definition";

export const promptVersion = "claude-reset-actions-2026-11-10.3";
export const productRules = `只把明确的一次性云会话奖励活动作为 Claude 的 bonus_credit；API 赠金、每月 API credits 与普通限额提升继续排除。
cloud sessions 的 one time bonus credit 是独立消费池，先消费赠额再计入套餐限额，不是 reset_credit。
“You can still claim the one time bonus credit for cloud sessions ... Run /claim-credit ...”是 bonus_credit、confirm，表示官方活动开放，不代表个人到账；“We will offer a one time bonus credit for cloud sessions”是 announce。
“We will reset five-hour usage for Pro”是 direct_reset；“We have granted one reset credit that you can redeem to reset your weekly usage”是 reset_credit。同帖奖励和重置分开提取。
按订阅时长发放若干次、允许留存或随时使用的 resets 是重置卡，即使没有 credit 一词。官方当前发放且明确现在可使用时是 reset_credit、confirm，确认的是发卡或开放使用，不是已经消耗重置卡；未来才发放是 announce。使用、兑换截止和卡片到期只保留在摘要，不作发放时间。混合帖子里的试用限额提升不单独建事件，不同套餐的数量和使用条件完整保留。
Claude 官方 Fable launch offers 中的 Fable limit reset 是用户在 Settings > Usage 主动使用的重置次数，发放时属于 reset_credit，使用后恢复额度不等于官方直接重置所有账户。来源帖明确同时给不同套餐分配 Fable reset 次数时，按同一轮发卡活动保留各套餐数量和限制，不因另附试用而误判成 direct_reset；不扩展到原帖未列出的套餐或周期。普通 generic reset 仍按共享规则判断。
例如同帖“We're giving Ultra and Team Premium users Fable resets ... Use them anytime by March 8. Pro and Team Standard get a week to try Fable 5.2 ... plus one reset.”表达同一轮发卡：一个 reset_credit 事件、一个 confirm 动作，摘录同时保留发放、可使用及各套餐句子。后一句的 one reset 也是该发卡活动的次数，不建第二个 direct_reset 事件。3 月 8 日的使用期限只归其明确适用的那组套餐，不扩展到其他套餐。
保留每账户一次、仅云会话、自动消费、消费顺序及 GitHub 启动前提，不能把这些使用细则替换为订阅资格或领取方式。
三种事件统一使用 announce、confirm、progress、amend。关闭领取、到期和重新开放是 progress，不覆盖确认；官方明确取消整个事件是 amend 且 invalidatesEvent=true，其他动作均为 false。取消后不自动恢复，普通细则修订不改完成状态。`;
export const buildPrompt = (current: ResetMonitorDefinition) => buildResetMonitorPrompt(current, productRules);
export const prompt = buildPrompt(definition);
