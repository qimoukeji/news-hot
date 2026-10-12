import type { ResetMonitorDefinition } from "@aihot/reset-monitor/definition";

export const definition: ResetMonitorDefinition = {
  monitorId: "grok", moduleName: "grok-reset", product: "Grok", organization: "xAI",
  authors: [{ handle: "bot", name: "Grok Bot" }, { handle: "grok", name: "Grok" }], authorName: "Grok 官方",
  pagePath: "/grok-reset", adminPath: "/admin/grok-reset", adminApiPath: "/api/admin/grok-reset",
  siteApiPath: "/api/site/grok-reset", publicApiPath: "/api/v1/grok-resets", agentPath: "/grok-resets", mcpTool: "get_grok_resets",
  timePolicy: "explicit", title: "Grok 额度动态", eventKinds: ["direct_reset", "reset_credit", "bonus_credit"],
  description: "跟踪 @bot 与 @grok 的额度重置、重置卡和一次性奖励额度，保留适用产品、套餐、北京时间与关联原帖。",
};
export default definition;
