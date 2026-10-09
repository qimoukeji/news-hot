import { z } from "zod";
import { defineServerModule } from "@aihot/backend/modules";
import { modulePublication } from "@aihot/backend/publication/modules";
import { siteUrl } from "@aihot/backend/publication/links";
import type { CodexResetPageData } from "./contracts.ts";
import { codexResetPage, codexResetVersion, codexResetsSnapshot, codexResetsRecent } from "./backend/read.ts";
import { loadSiteCodexResetPage, loadSiteCodexResetDay } from "./backend/publication.ts";
import { codexAnswer } from "./backend/agent.ts";
import { monitorTick } from "./backend/scan.ts";
import { scanCron, scanMinutes } from "./config.ts";
import { registerHttp } from "./api/routes.ts";

const read = <T>(view: string) => modulePublication<T>("codex-reset", view);
export default defineServerModule({
  name: "codex-reset",
  publications: {
    page: () => loadSiteCodexResetPage(),
    day: ({ date }) => loadSiteCodexResetDay(String(date)),
    version: () => codexResetVersion(),
    snapshot: () => codexResetsSnapshot(), recent: () => codexResetsRecent(),
    agent: () => codexResetPage(),
  },
  http: registerHttp,
  models: { monitor: { label: "Codex 重置识别", env: "MONITOR_MODEL", purposes: ["monitor.recognize"] } },
  schedules: [
    { name: "monitor.tick", cron: scanCron(), retryLimit: 0, when: () => process.env.COLLECT_ENABLED === "true", run: () => monitorTick() },
    { name: "monitor.lookback", cron: "40 4 * * *", retryLimit: 0, when: () => process.env.COLLECT_ENABLED === "true", run: () => monitorTick({ lookbackHours: 24 }) },
  ],
  sitemap: { pages: [{ loc: siteUrl("/codex-reset"), changefreq: "hourly" }] },
  llms: () => ({ api: ["- Codex 重置：/api/v1/codex-resets/recent（最近七天及未完成事件）；/api/v1/codex-resets（完整历史）"],
    pace: [`Codex 重置每 ${scanMinutes()} 分钟查询一次`], pages: ["- Codex 重置监控：/codex-reset"],
    usage: ["- 预计时间不是到账确认；人工核实账户到账也不代表所有账户都到账。"] }),
  agent: { abilities: [{
    path: "/codex-resets", title: "Codex 重置", ask: "Codex 最近有没有额度重置或重置卡？",
    answer: async () => codexAnswer(await read<CodexResetPageData>("agent")),
    etagPrefix: "codex-agent", cacheControl: "public, max-age=60, s-maxage=60",
    mcp: { tool: "get_codex_resets", use: "for Codex reset announcements and confirmations",
      description: "查询 Codex 额度重置与重置卡，区分公告、预计生效和已确认到账。", input: z.object({}),
      run: async () => { const data = await read<CodexResetPageData>("agent"); return { text: codexAnswer(data), structured: { ...data } }; },
    },
  }] },
});
