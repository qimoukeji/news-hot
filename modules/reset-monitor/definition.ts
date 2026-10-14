/** Public display and route configuration. No backend configuration or credentials. */
import type { ResetMonitorEventKind } from "./contracts.ts";

export const RESET_EVENT_KINDS = ["direct_reset", "reset_credit", "bonus_credit"] as const satisfies readonly ResetMonitorEventKind[];
export interface ResetMonitorAuthor {
  handle: string;
  name: string;
  defaultProduct?: string;
  /** Optional profile name registered by the product module; absent means explicit. */
  timePolicy?: string;
}
export interface ResetMonitorCollection {
  mode: "all" | "announcements_and_relevant_replies";
  words?: readonly string[];
  phrases?: readonly string[];
  productWords?: readonly string[];
  benefitWords?: readonly string[];
  chinese?: readonly string[];
  selfPhrases?: readonly string[];
  /** Explicit query partitioning preserves saved initialization cursors. */
  queryGroups?: { query: readonly string[]; supplementalQueries?: readonly string[]; version: string; reason: string };
}
export interface ResetMonitorSiteConfig {
  publicV2?: import("./public-v2.ts").PublicV2Config;
  processingMode?: "automatic" | "collect_only" | "automatic_incremental";
  authors: readonly ResetMonitorAuthor[];
  plans: readonly string[];
  collection?: ResetMonitorCollection;
}
export interface ResetMonitorProductAlias { key: string; patterns: readonly string[] }

export interface ResetMonitorWebDefinition {
  publicV2?: import("./public-v2.ts").PublicV2Config;
  processingMode?: ResetMonitorSiteConfig["processingMode"];
  monitorId: string;
  moduleName: string;
  product: string;
  organization: string;
  authors: readonly ResetMonitorAuthor[];
  plans: readonly string[];
  collection?: ResetMonitorCollection;
  productAliases?: readonly ResetMonitorProductAlias[];
  authorName: string;
  pagePath: string;
  adminPath: string;
  adminApiPath: string;
  siteApiPath: string;
  publicApiPath: string;
  agentPath: string;
  mcpTool: string;
  timePolicy: "predicted" | "explicit";
  description: string;
  title?: string;
  eventKinds: readonly ResetMonitorEventKind[];
}

export type ResetMonitorDefinition = ResetMonitorWebDefinition;

export const collectsForwardOnly = (definition: Pick<ResetMonitorDefinition, "processingMode">) => definition.processingMode === "collect_only" || definition.processingMode === "automatic_incremental";

export const publicV2Path = (definition: ResetMonitorWebDefinition) => definition.publicApiPath.replace(/^\/api\/v1\//, "/api/v2/");
