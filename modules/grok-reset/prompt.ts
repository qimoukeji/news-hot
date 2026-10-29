import definition from "./definition.ts";
import { buildResetMonitorPrompt } from "@aihot/reset-monitor/prompt";
import type { ResetMonitorDefinition } from "@aihot/reset-monitor/definition";

export const promptVersion = "grok-reset-actions-2026-10-26.2";
export const productRules = `原文明示 Grok Bot、Grok、Imagine 或多个产品时忠实保留；没说明产品填 null，由代码根据配置作者补默认产品。
不能把 Grok Bot 与 Grok 普通额度关联为同一事件。Cursor 套餐只在原文明确适用于 Grok Bot 时记录，不把 Cursor 其他产品额度变成 Grok 事件。
官方一次性产品奖励额度是 bonus_credit，API 赠金不属于本监控；两个账号公告不证明两次重置或两次奖励，必须按同一事件证据关联。
三种事件统一使用 announce、confirm、progress、amend。关闭领取、到期和重新开放是 progress，不覆盖确认；官方明确取消整个事件是 amend 且 invalidatesEvent=true，其他动作均为 false。取消后不自动恢复，普通细则修订不改完成状态。`;
export const buildPrompt = (current: ResetMonitorDefinition) => buildResetMonitorPrompt(current, productRules);
export const prompt = buildPrompt(definition);
