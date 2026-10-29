import { RESET_EVENT_KINDS, type ResetMonitorDefinition } from "@aihot/reset-monitor/definition";
import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";
const { collection: _collection, ...config } = validateResetMonitorConfig(RESET_MONITORS.grok);

export const definition: ResetMonitorDefinition = {
  monitorId: "grok", moduleName: "grok-reset", product: "Grok", organization: "xAI",
  ...config, authorName: config.authors.map(author => author.name).join("、"),
  pagePath: "/grok-reset", adminPath: "/admin/grok-reset", adminApiPath: "/api/admin/grok-reset",
  publicApiPath: "/api/v2/grok-resets", agentPath: "/grok-resets", mcpTool: "get_grok_resets",
  title: "Grok 额度动态", eventKinds: RESET_EVENT_KINDS,
  productAliases: [{ key: "bot", patterns: ["\\bgrok\\s*bot\\b"] },
    { key: "imagine", patterns: ["\\b(?:grok\\s*)?imagine\\b"] }, { key: "grok", patterns: ["\\bgrok\\b"] }],
  description: "跟踪配置账号的 Grok 额度重置、重置卡和一次性奖励额度，保留适用产品、套餐、北京时间与关联原帖。",
};
export default definition;
