import { defineWebModule } from "@aihot/web/modules";
import { IconClock } from "@aihot/web/components/icons";
import { publicV2Path, type ResetMonitorWebDefinition } from "./definition.ts";

export type { ResetMonitorWebProfile } from "./web/context.tsx";

export function createMonitorWebModule(definition: ResetMonitorWebDefinition) {
  const { product, pagePath, adminPath, mcpTool } = definition;
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
        ["/api/v2/overview", "各平台额度活动总览", "总览 · ETag"],
        [publicV2Path(definition), bonuses ? "额度活动、动作与全部来源" : "重置事件、动作与全部来源", "日期查询 · ETag"],
      ] },
    } }),
  });
}
