import { buildResetMonitorPrompt } from "@aihot/reset-monitor/prompt";
import type { ResetMonitorDefinition } from "@aihot/reset-monitor/definition";
import definition from "./definition.ts";

export const promptVersion = "gemini-reset-actions-2026-11-27.1";
const productRules = `记录原帖明确针对 Gemini 或 Google Antigravity 用户额度的动作。原帖所说的 Antigravity 额度重置按其明示范围记录；同一次重置覆盖多个模型时保留一个事件，并在摘要写明原帖点名的模型。Antigravity 的变动不外推到 Gemini 网页、App、API 或其他产品。
“Resetting everyone’s Gemini quota on Antigravity”是当下执行的额度重置。明确承诺未来才执行时用 announce；仅描述常规重置周期、模型上线或通过缓存优化让用户能完成更多任务时不生成动作。`;

export const buildPrompt = (current: ResetMonitorDefinition) => buildResetMonitorPrompt(current, productRules);
export const prompt = buildPrompt(definition);
