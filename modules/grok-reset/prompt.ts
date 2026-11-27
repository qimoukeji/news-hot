import definition from "./definition.ts";
import { buildResetMonitorPrompt } from "@aihot/reset-monitor/prompt";
import type { ResetMonitorDefinition } from "@aihot/reset-monitor/definition";

export const promptVersion = "grok-reset-actions-2026-11-27.1";
export const productRules = `Cursor 其他产品的额度不属于本监控；只有原帖明确与 Grok 的额度活动相关时才记录。
官方一次性产品奖励额度是 bonus_credit，API 赠金不属于本监控；多条公告须按同一事件的证据关联，避免重复记录重置或奖励。
三种事件统一使用 announce、confirm、progress、amend。关闭领取、到期和重新开放是 progress，不覆盖确认；官方明确取消整个事件是 amend 且 invalidatesEvent=true，其他动作均为 false。取消后不自动恢复，普通细则修订不改完成状态。`;
export const buildPrompt = (current: ResetMonitorDefinition) => buildResetMonitorPrompt(current, productRules);
export const prompt = buildPrompt(definition);
