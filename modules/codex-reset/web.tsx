import { defineWebModule } from "@aihot/web/modules";
import { IconClock } from "@aihot/web/components/icons";

export default defineWebModule({
  name: "codex-reset",
  sidebar: { section: "监控", items: [{ to: "/codex-reset", label: "Codex 重置", icon: IconClock }] },
  tools: [{ to: "/codex-reset", label: "Codex 重置监控", icon: <IconClock /> }],
  admin: { content: [{ to: "/admin/monitor", label: "Codex 重置" }] },
  agent: async () => ({ default: {
    tools: [{ name: "get_codex_resets", does: "查看 Codex 重置与重置卡公告", ask: "Codex 最近有没有额度重置？" }],
    api: { group: "Codex 重置监控", rows: [
      ["/api/v1/codex-resets", "全部重置公告与关联原帖", "历史查询"],
      ["/api/v1/codex-resets/recent", "最近七天及未完成的重置", "增量查询 · ETag"],
    ] },
  } }),
});
