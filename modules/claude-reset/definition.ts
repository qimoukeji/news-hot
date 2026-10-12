import type { ResetMonitorDefinition } from "@aihot/reset-monitor/definition";

export const definition: ResetMonitorDefinition = {
  monitorId: "claude", moduleName: "claude-reset", product: "Claude", organization: "Anthropic",
  authors: [{ handle: "ClaudeDevs", name: "ClaudeDevs" }], authorName: "ClaudeDevs", pagePath: "/claude-reset", adminPath: "/admin/claude-reset",
  adminApiPath: "/api/admin/claude-reset", siteApiPath: "/api/site/claude-reset",
  publicApiPath: "/api/v1/claude-resets", agentPath: "/claude-resets", mcpTool: "get_claude_resets",
  timePolicy: "explicit", title: "Claude 额度动态", eventKinds: ["direct_reset", "reset_credit", "bonus_credit"],
  description: "跟踪 @ClaudeDevs 发布的 Claude 额度重置、重置卡与一次性奖励额度：官方活动、北京时间、适用范围和历史日历。",
};
export default definition;
