import { RESET_EVENT_KINDS, type ResetMonitorDefinition } from "@aihot/reset-monitor/definition";
import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";

const { collection: _collection, ...config } = validateResetMonitorConfig(RESET_MONITORS.gemini);

export const definition: ResetMonitorDefinition = {
  monitorId: "gemini", moduleName: "gemini-reset", product: "Gemini", organization: "Google",
  ...config, authorName: config.authors.map(author => author.name).join("、"),
  pagePath: "/gemini-reset", adminPath: "/admin/gemini-reset", adminApiPath: "/api/admin/gemini-reset",
  publicApiPath: "/api/v2/gemini-resets", agentPath: "/gemini-resets", mcpTool: "get_gemini_resets",
  title: "Gemini 额度动态", eventKinds: RESET_EVENT_KINDS,
  description: "跟踪 Varun Mohan 发布的 Gemini 与 Google Antigravity 额度重置、重置卡和一次性奖励额度。",
};
export default definition;
