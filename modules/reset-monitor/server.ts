import { z } from "zod";
import { defineServerModule } from "@aihot/backend/modules";
import { modulePublication } from "@aihot/backend/publication/modules";
import { siteUrl } from "@aihot/backend/publication/links";
import type { FastifyInstance } from "fastify";
import type { ResetMonitorPageData } from "./contracts.ts";
import { inMonitor, bindMonitor, validateDefinition, type ResetMonitorBackendDefinition } from "./backend/context.ts";
import { resetPage, resetVersion, resetsSnapshot, resetsRecent } from "./backend/read.ts";
import { loadSiteResetMonitorPage, loadSiteResetMonitorDay } from "./backend/publication.ts";
import { monitorAnswer } from "./backend/agent.ts";
import { monitorTick } from "./backend/scan.ts";
import { scanCron, scanMinutes } from "./config.ts";
import { registerHttp } from "./api/routes.ts";
import { eventDisplayLabel } from "./event-kind.ts";

export function monitorNames(id: string): ResetMonitorBackendDefinition["names"] {
  return { tick: `${id}-reset.tick`, lookback: `${id}-reset.lookback`, purposePrefix: `reset_monitor.${id}`,
    auditActionPrefix: `reset_monitor.${id}`, auditSubjectPrefix: `reset_monitor.${id}`,
    deliveryKind: `${id}_reset`, deliveryPrefix: id };
}

/** Fastify executes handlers later, so each handler must enter its own immutable monitor scope. */
function scopedHttp(app: FastifyInstance, definition: ResetMonitorBackendDefinition) {
  const scoped = new Proxy(app, {
    get(target, key) {
      const member = Reflect.get(target, key);
      if (["get", "post", "patch"].includes(String(key))) return (...args: unknown[]) => {
        const handler = args[args.length - 1] as (...input: unknown[]) => unknown;
        args[args.length - 1] = function (this: unknown, ...input: unknown[]) {
          return inMonitor(definition, () => handler.apply(this, input));
        };
        return member.apply(target, args);
      };
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return inMonitor(definition, () => registerHttp(scoped));
}

export function createMonitorServer(definition: ResetMonitorBackendDefinition) {
  validateDefinition(definition);
  const bound = <A extends unknown[], R>(fn: (...args: A) => R) => bindMonitor(definition, fn);
  const read = () => modulePublication<ResetMonitorPageData>(definition.moduleName, "agent");
  const bonusEnabled = definition.eventKinds.includes("bonus_credit");
  const subject = bonusEnabled ? definition.title ?? `${definition.product} 额度动态` : `${definition.product} 重置`;
  const kinds = definition.eventKinds.map(eventDisplayLabel).join("、");
  return inMonitor(definition, () => defineServerModule({
    name: definition.moduleName,
    publications: {
      page: bound(() => loadSiteResetMonitorPage()),
      day: bound(({ date }: Record<string, unknown>) => loadSiteResetMonitorDay(String(date))),
      version: bound(() => resetVersion()), snapshot: bound(() => resetsSnapshot()), recent: bound(() => resetsRecent()),
      agent: bound(() => resetPage()),
    },
    http: (app) => scopedHttp(app, definition),
    models: { monitor: { label: "重置监控识别", env: "MONITOR_MODEL", purposes: [`${definition.names.purposePrefix}.recognize`] } },
    schedules: [
      { name: definition.names.tick, cron: scanCron(), retryLimit: 0, when: () => process.env.COLLECT_ENABLED === "true", run: bound(() => monitorTick()) },
      { name: definition.names.lookback, cron: "40 4 * * *", retryLimit: 0, when: () => process.env.COLLECT_ENABLED === "true", run: bound(() => monitorTick({ lookbackHours: 24 })) },
    ],
    sitemap: { pages: [{ loc: siteUrl(definition.pagePath), changefreq: "hourly" }] },
    llms: bound(() => ({ api: [`- ${subject}：${definition.publicApiPath}/recent（最近七天及未完成事件）；${definition.publicApiPath}（完整历史）`],
      pace: [`${subject}每 ${scanMinutes()} 分钟查询一次`], pages: [`- ${bonusEnabled ? subject : `${definition.product} 重置监控`}：${definition.pagePath}`],
      usage: ["- 按事件的作者时间策略表达时间；仅明确绑定作者惯例的事件允许预计，其他事件缺时间保留原话。原帖或预计时间都不是到账确认；人工核实账户到账不代表所有账户到账。", ...(bonusEnabled ? ["- 奖励活动可领取不代表个人已领取或到账；领取截止与奖励到期分别表达，奖励时间不预测。"] : [])] })),
    agent: { abilities: [{
      path: definition.agentPath, title: subject, ask: bonusEnabled ? `${definition.product} 最近有没有${kinds}？` : `${definition.product} 最近有没有额度重置或重置卡？`,
      answer: bound(async () => monitorAnswer(await read())),
      etagPrefix: `${definition.monitorId}-agent`, cacheControl: "public, max-age=60, s-maxage=60",
      mcp: { tool: definition.mcpTool, use: `for ${definition.product} ${bonusEnabled ? "quota events and bonus credit campaigns" : "reset announcements and confirmations"}`,
        description: `查询 ${definition.product} ${kinds}，按事件的作者时间策略区分原帖明确时间、允许的预计时间与完成确认；缺时间保留原话，公开采集覆盖说明。${bonusEnabled ? "奖励活动可领取不表示个人到账，领取截止和奖励到期分别表达，不预测奖励时间。" : "人工核实到账不代表所有账户到账。"}`, input: z.object({}),
        run: bound(async () => { const data = await read(); return { text: monitorAnswer(data), structured: { ...data } }; }),
      },
    }] },
  }));
}
