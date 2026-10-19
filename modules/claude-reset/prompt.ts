import definition from "./definition.ts";
import { buildResetMonitorPrompt } from "@aihot/reset-monitor/prompt";
import type { ResetMonitorDefinition } from "@aihot/reset-monitor/definition";

export const promptVersion = "claude-reset-2026-10-19.1";
export const productRules = `只把明确的一次性云会话奖励活动作为 Claude 的 bonus_credit；API 赠金、每月 API credits 与普通限额提升继续排除。
cloud sessions 的 one time bonus credit 是独立消费池，先消费赠额再计入套餐限额，不是 reset_credit。
“You can still claim the one time bonus credit for cloud sessions ... Run /claim-credit ...”是 bonus_credit、confirm，表示官方活动开放，不代表个人到账；“We will offer a one time bonus credit for cloud sessions”是 announce。
“We will reset five-hour usage for Pro”是 direct_reset；“We have granted one reset credit that you can redeem to reset your weekly usage”是 reset_credit。同帖奖励和重置分开提取。
保留每账户一次、仅云会话、自动消费、消费顺序及 GitHub 启动前提，不能把这些使用细则替换为订阅资格或领取方式。
忠实保留五小时与每周额度范围、Claude / Claude Code 产品、原文明示的套餐及仅受影响用户等条件，未说不假设全员或两个周期都重置。`;
export const buildPrompt = (current: ResetMonitorDefinition) => buildResetMonitorPrompt(current, productRules);
export const prompt = buildPrompt(definition);
