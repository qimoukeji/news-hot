import { RESET_EVENT_KINDS, type ResetMonitorDefinition } from "@aihot/reset-monitor/definition";
import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";
const { collection: _collection, ...config } = validateResetMonitorConfig(RESET_MONITORS.codex);

export const definition: ResetMonitorDefinition = {
  monitorId: "codex", moduleName: "codex-reset", product: "Codex", organization: "OpenAI",
  ...config, authorName: config.authors.map(author => author.name).join("、"), pagePath: "/codex-reset", adminPath: "/admin/codex-reset",
  adminApiPath: "/api/admin/codex-reset", publicApiPath: "/api/v2/codex-resets", agentPath: "/codex-resets", mcpTool: "get_codex_resets",
  eventKinds: RESET_EVENT_KINDS,
  productAliases: [{ key: "codex", patterns: ["\\bcodex\\b", "\\bchatgpt\\s+work\\b"] }],
  description: "跟踪配置账号公布的 Codex 额度重置、重置卡与一次性奖励额度，保留北京时间、适用范围、多语言标题摘要与历史日历。",
};
export default definition;
