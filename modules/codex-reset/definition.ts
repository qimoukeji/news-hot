import type { ResetMonitorDefinition } from "@aihot/reset-monitor/definition";

export const definition: ResetMonitorDefinition = {
  monitorId: "codex", moduleName: "codex-reset", product: "Codex", organization: "OpenAI",
  author: "thsottiaux", authorName: "Tibo", pagePath: "/codex-reset", adminPath: "/admin/monitor",
  adminApiPath: "/api/admin/monitor", siteApiPath: "/api/site/codex-reset",
  publicApiPath: "/api/v1/codex-resets", agentPath: "/codex-resets", mcpTool: "get_codex_resets",
  timePolicy: "predicted",
  eventKinds: ["direct_reset", "reset_credit"],
  description: "跟踪 Tibo 公布的 Codex 额度重置与重置卡发放：推算的北京时间生效窗口、适用范围、中文原帖与历史日历。",
};
export default definition;
