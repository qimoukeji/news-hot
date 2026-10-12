import { AsyncLocalStorage } from "node:async_hooks";
import { RESET_EVENT_KINDS, type ResetMonitorDefinition, type ResetMonitorCollection } from "../definition.ts";
import type { Proposition } from "./recognize.ts";
import type { Estimate, Schedule, StatedTime, StatedWords } from "./time.ts";

export interface ResetMonitorBackendDefinition extends ResetMonitorDefinition {
  providerEnv: string;
  scanMinutesEnv: string;
  prompt: string;
  buildPrompt?: (definition: ResetMonitorBackendDefinition) => string;
  promptVersion: string;
  plans: readonly string[];
  collectionFilter?: {
    query: string | readonly string[];
    supplementalQueries?: readonly string[];
    version: string;
    reason: string;
    signature?: string;
    configuration?: ResetMonitorCollection;
    accepts: (post: { text: string; isReply: boolean }) => boolean;
  };
  defaultProductForAuthor?: (author: string) => string | null;
  scopeConflicts?: (a: Proposition["scope"], b: Proposition["scope"]) => boolean;
  requireCrossAuthorEvidence?: boolean;
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
  timingProfiles?: Readonly<Record<string, ResetMonitorBackendDefinition["timing"]>>;
}

const scope = new AsyncLocalStorage<ResetMonitorBackendDefinition>();
const authorScope = new AsyncLocalStorage<string>();

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
export const authorHandles = () => monitor().authors.map((a) => a.handle.toLowerCase());
export const isAuthor = (handle: string) => authorHandles().includes(handle.replace(/^@/, "").toLowerCase());
export const authorNameFor = (handle: string) => monitor().authors.find(a => a.handle.toLowerCase() === handle.replace(/^@/, "").toLowerCase())?.name ?? `@${handle.replace(/^@/, "")}`;
export function withAuthorTime<T>(author: string, run: () => T): T { return authorScope.run(author, run); }
export function authorTiming(author = authorScope.getStore() ?? monitor().authors[0]!.handle) {
  const configured = monitor().authors.find(a => a.handle.toLowerCase() === author.replace(/^@/, "").toLowerCase());
  const profile = configured?.timePolicy;
  return profile && profile !== "explicit" ? monitor().timingProfiles?.[profile] ?? monitor().timing : monitor().timing;
}
export function authorTimePolicy(author = authorScope.getStore() ?? monitor().authors[0]!.handle): "explicit" | "predicted" {
  const configured = monitor().authors.find(a => a.handle.toLowerCase() === author.replace(/^@/, "").toLowerCase());
  return configured?.timePolicy && configured.timePolicy !== "explicit" && monitor().timingProfiles?.[configured.timePolicy] ? "predicted" : "explicit";
}
export const purpose = (phase: "scan" | "lookback" | "context" | "recognize") => `${monitor().names.purposePrefix}.${phase}`;
export const auditAction = (action: string) => `${monitor().names.auditActionPrefix}.${action}`;
export const auditSubject = (kind: "post" | "event", id: string) => `${monitor().names.auditSubjectPrefix}-${kind}:${id}`;

export function bindMonitor<A extends unknown[], R>(definition: ResetMonitorBackendDefinition, operation: (...args: A) => R): (...args: A) => R {
  return (...args) => inMonitor(definition, () => operation(...args));
}

export function validateDefinition(definition: ResetMonitorBackendDefinition) {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.monitorId)) throw new Error("Invalid reset monitor ID");
  if (!definition.authors.length || definition.authors.some((a) => !/^[A-Za-z0-9_]{1,15}$/.test(a.handle) || !a.name.trim())
    || new Set(definition.authors.map((a) => a.handle.toLowerCase())).size !== definition.authors.length) throw new Error("Invalid X monitor authors");
  if (definition.authors.some(a => a.timePolicy && a.timePolicy !== "explicit" && !definition.timingProfiles?.[a.timePolicy])) throw new Error("Unknown monitor author time policy");
  if (!definition.eventKinds.length || new Set(definition.eventKinds).size !== definition.eventKinds.length
    || definition.eventKinds.some((kind) => !RESET_EVENT_KINDS.includes(kind))) throw new Error("Invalid reset monitor event kinds");
  if (definition.collectionFilter) {
    const queries = typeof definition.collectionFilter.query === "string" ? [definition.collectionFilter.query] : definition.collectionFilter.query;
    if (!queries.length || [...queries, ...(definition.collectionFilter.supplementalQueries ?? [])].some(query => !query.trim()) || !definition.collectionFilter.version.trim() || !definition.collectionFilter.reason.trim()) {
      throw new Error("Invalid reset monitor collection filter");
    }
  }
  for (const path of [definition.pagePath, definition.adminPath, definition.adminApiPath, definition.siteApiPath, definition.publicApiPath, definition.agentPath]) {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path)) throw new Error(`Invalid reset monitor path: ${path}`);
  }
}
