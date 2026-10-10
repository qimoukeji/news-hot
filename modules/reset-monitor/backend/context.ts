import { AsyncLocalStorage } from "node:async_hooks";
import type { ResetMonitorDefinition } from "../definition.ts";
import type { Proposition } from "./recognize.ts";
import type { Estimate, Schedule, StatedTime, StatedWords } from "./time.ts";

export interface ResetMonitorBackendDefinition extends ResetMonitorDefinition {
  providerEnv: string;
  scanMinutesEnv: string;
  prompt: string;
  promptVersion: string;
  plans: readonly string[];
  quotaScope?: (scope: { audienceSource: string | null; productsZh: string | null }, evidence?: { excerpt: string; kind: Proposition["kind"] }) => string | null;
  excludeProposition?: (proposition: Proposition, sourceText: string, association?: { trustedEventKinds: readonly Proposition["kind"][] }) => string | null;
  names: {
    tick: string;
    lookback: string;
    purposePrefix: string;
    auditActionPrefix: string;
    auditSubjectPrefix: string;
    deliveryKind: string;
    deliveryPrefix: string;
  };
  timing: {
    resolve(words: StatedWords, postAt: Date, sourceText?: string): StatedTime | null;
    estimate(input: { schedule: Schedule | null; announcedAt: Date; model?: { earliestPacific: string; latestPacific: string; note: string } | null }): Estimate | null;
  };
}

const scope = new AsyncLocalStorage<ResetMonitorBackendDefinition>();

/** Every entry is bound once by its module. Async context also follows transactions and HTTP handlers. */
export function inMonitor<T>(definition: ResetMonitorBackendDefinition, run: () => T): T {
  return scope.run(definition, run);
}

export function monitor(): ResetMonitorBackendDefinition {
  const definition = scope.getStore();
  if (!definition) throw new Error("Reset monitor operation requires a bound definition");
  return definition;
}

export const monitorId = () => monitor().monitorId;
export const author = () => monitor().author;
export const purpose = (phase: "scan" | "lookback" | "context" | "recognize") => `${monitor().names.purposePrefix}.${phase}`;
export const auditAction = (action: string) => `${monitor().names.auditActionPrefix}.${action}`;
export const auditSubject = (kind: "post" | "event", id: string) => `${monitor().names.auditSubjectPrefix}-${kind}:${id}`;

export function bindMonitor<A extends unknown[], R>(definition: ResetMonitorBackendDefinition, operation: (...args: A) => R): (...args: A) => R {
  return (...args) => inMonitor(definition, () => operation(...args));
}

export function validateDefinition(definition: ResetMonitorBackendDefinition) {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.monitorId)) throw new Error("Invalid reset monitor ID");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(definition.author)) throw new Error("Invalid X monitor author");
  if (!definition.eventKinds.length || new Set(definition.eventKinds).size !== definition.eventKinds.length
    || definition.eventKinds.some((kind) => !["direct_reset", "reset_credit", "bonus_credit"].includes(kind))) throw new Error("Invalid reset monitor event kinds");
  for (const path of [definition.pagePath, definition.adminPath, definition.adminApiPath, definition.siteApiPath, definition.publicApiPath, definition.agentPath]) {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path)) throw new Error(`Invalid reset monitor path: ${path}`);
  }
}
