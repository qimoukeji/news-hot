import { z } from "zod";
import { config } from "@aihot/backend/config";
import { processPublicV2Pending } from "./backend/public-v2-generate.ts";
import { defineServerModule } from "@aihot/backend/modules";
import { modulePublication } from "@aihot/backend/publication/modules";
import type { FastifyInstance } from "fastify";
import type { ResetSnapshot } from "./public-v2.ts";
import { inMonitor, bindMonitor, validateDefinition, type ResetMonitorBackendDefinition } from "./backend/context.ts";
import { monitorAnswer } from "./backend/agent.ts";
import { monitorTick } from "./backend/scan.ts";
import { scanCron, scanMinutes } from "./config.ts";
import { registerHttp } from "./api/routes.ts";
import { eventDisplayLabel } from "./event-kind.ts";
import { publicV2Snapshot, publicV2Sources } from "./backend/public-v2.ts";
import { paginatePublicV2, type PublicV2Query } from "./backend/public-v2-list.ts";
import { platformOverviewSchema } from "./public-v2.ts";

export function monitorNames(id: string): ResetMonitorBackendDefinition["names"] {
  return { tick: `${id}-reset.tick`, purposePrefix: `reset_monitor.${id}`,
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
  const read = () => modulePublication<ResetSnapshot>(definition.moduleName, "snapshotV2");
  const bonusEnabled = definition.eventKinds.includes("bonus_credit");
  const subject = bonusEnabled ? definition.title ?? `${definition.product} 额度动态` : `${definition.product} 重置`;
  const kinds = definition.eventKinds.map(eventDisplayLabel).join("、");
  return inMonitor(definition, () => defineServerModule({
    name: definition.moduleName,
    publications: {
      ...(definition.publicV2 ? {
        snapshotV2: bound(() => publicV2Snapshot()),
        eventsV2: bound(async (query: Record<string, unknown>) => paginatePublicV2(await publicV2Snapshot(), query as unknown as PublicV2Query)),
        overviewV2: bound(async ({ now }: Record<string, unknown>) => {
          const { schemaVersion: _schema, generatedAt: _generated, events: _events, ...overview } = await publicV2Snapshot(Number(now));
          return platformOverviewSchema.parse({ ...overview, sources: publicV2Sources(definition) });
        }),
      } : {}),
    },
    http: (app) => scopedHttp(app, definition),
    models: { monitor: { label: "重置监控识别与 v2 补全", env: "MONITOR_MODEL", purposes: [`${definition.names.purposePrefix}.recognize`, `${definition.names.purposePrefix}.public_v2`] } },
    schedules: [
      { name: `${definition.monitorId}-reset.translate`, cron: "* * * * *", retryLimit: 0, when: () => Boolean(definition.publicV2) && config.modelCallsEnabled, run: bound(() => processPublicV2Pending()) },
      { name: definition.names.tick, cron: scanCron(), retryLimit: 0, run: bound(() => monitorTick()) },
    ],
    sitemap: { pages: [{ loc: definition.pagePath, changefreq: "hourly" }] },
    llms: bound(() => ({ api: [`- ${subject}：${definition.publicApiPath}（v2 动作与来源；按日期查询）`],
      pace: [`${subject}每 ${scanMinutes()} 分钟查询一次`], pages: [`- ${bonusEnabled ? subject : `${definition.product} 重置监控`}：${definition.pagePath}`],
      usage: ["- 三类事件共用动作与状态；总览根据有效确认的历史间隔推算，预测不构成确认。", ...(bonusEnabled ? ["- 奖励活动确认不代表个人已领取或到账；领取截止与奖励到期只作为进展表达。"] : [])] })),
    agent: { abilities: [{
      apiPath: `/api/v2/agent${definition.agentPath}`,
      path: definition.agentPath, title: subject, ask: bonusEnabled ? `${definition.product} 最近有没有${kinds}？` : `${definition.product} 最近有没有额度重置或重置卡？`,
      answer: bound(async () => monitorAnswer(await read())),
      etagPrefix: `${definition.monitorId}-agent-v2.3`, cacheControl: "public, max-age=60, s-maxage=60",
      mcp: { tool: definition.mcpTool, use: `for ${definition.product} ${bonusEnabled ? "quota events and bonus credit campaigns" : "reset announcements and confirmations"}`,
        description: `查询 ${definition.product} ${kinds}，返回 v2 事件和完整动作时间线，每个动作包含全部原帖链接。三类事件共用状态与统计规则，取消修订使事件退出总览与统计。${bonusEnabled ? "奖励确认不表示个人到账，领取截止与奖励到期作为进展表达。" : "个人账户报告不构成活动完成确认。"}`, input: z.object({}),
        run: bound(async () => { const data = await read(); return { text: monitorAnswer(data), structured: { ...data } }; }),
      },
    }] },
  }));
}
