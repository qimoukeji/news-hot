import { RESET_EVENT_KINDS, type ResetMonitorDefinition } from "@aihot/reset-monitor/definition";
import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";
const { collection: _collection, ...config } = validateResetMonitorConfig(RESET_MONITORS.claude);

export const definition: ResetMonitorDefinition = {
  monitorId: "claude", moduleName: "claude-reset", product: "Claude", organization: "Anthropic",
  ...config, authorName: config.authors.map(author => author.name).join("、"), pagePath: "/claude-reset", adminPath: "/admin/claude-reset",
  adminApiPath: "/api/admin/claude-reset", publicApiPath: "/api/v2/claude-resets", agentPath: "/claude-resets", mcpTool: "get_claude_resets",
  title: "Claude 额度动态", eventKinds: RESET_EVENT_KINDS,
  productAliases: [{ key: "claude_code", patterns: ["\\bclaude\\s+code\\b"] }, { key: "claude", patterns: ["\\bclaude\\b"] }],
  description: "跟踪配置账号发布的 Claude 额度重置、重置卡与一次性云会话奖励额度：官方活动、北京时间、适用范围和历史日历。",
};
export default definition;
