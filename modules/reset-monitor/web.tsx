import { defineWebModule } from "@aihot/web/modules";
import { IconClock } from "@aihot/web/components/icons";
import type { ResetMonitorWebDefinition } from "./definition.ts";

export type { ResetMonitorWebProfile } from "./web/context.tsx";

export function createMonitorWebModule(definition: ResetMonitorWebDefinition) {
  const { product, pagePath, adminPath, publicApiPath, mcpTool } = definition;
  const title = definition.title ?? `${product} 重置监控`;
  const bonuses = definition.eventKinds.includes("bonus_credit");
  const navLabel = definition.title ?? `${product} 重置`;
  return defineWebModule({
    name: definition.moduleName,
    sidebar: { section: "监控", items: [{ to: pagePath, label: navLabel, icon: IconClock }] },
    tools: [{ to: pagePath, label: title, icon: <IconClock /> }],
    admin: { content: [{ to: adminPath, label: navLabel }] },
    agent: async () => ({ default: {
      tools: [{ name: mcpTool, does: `查看 ${product} ${bonuses ? "重置、重置卡与奖励额度" : "重置与重置卡"}公告`, ask: `${product} 最近有没有${bonuses ? "奖励额度或" : ""}额度重置？` }],
      api: { group: title, rows: [
        [publicApiPath, bonuses ? "全部额度活动与关联原帖" : "全部重置公告与关联原帖", "历史查询"],
        [`${publicApiPath}/recent`, bonuses ? "最近七天及未结束的额度活动" : "最近七天及未完成的重置", "增量查询 · ETag"],
      ] },
    } }),
  });
}
