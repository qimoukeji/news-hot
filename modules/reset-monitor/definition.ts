/** Public display and route configuration. No backend configuration or credentials. */
import type { ResetMonitorEventKind } from "./contracts.ts";

export const RESET_EVENT_KINDS = ["direct_reset", "reset_credit", "bonus_credit"] as const satisfies readonly ResetMonitorEventKind[];
export interface ResetMonitorAuthor {
  handle: string;
  name: string;
  defaultProduct?: string;
}
export interface ResetMonitorCollectionConfig {
  /** Replies to other accounts; self-replies have their own switch. */
  includeReplies: boolean;
  includeSelfReplies: boolean;
  resetOnly: boolean;
  keywords: readonly string[];
  /** Maximum newly purchased search pages per task, shared by all configured authors. */
  maxPagesPerRun?: number;
}
export function validateCollectionConfig(value: ResetMonitorCollectionConfig): ResetMonitorCollectionConfig {
  if (!value || typeof value.includeReplies !== "boolean" || typeof value.includeSelfReplies !== "boolean" || typeof value.resetOnly !== "boolean" || !Array.isArray(value.keywords)
    || value.keywords.some(keyword => typeof keyword !== "string" || !/^[\p{L}\p{M}\p{N}]+(?:[ '\u2019-][\p{L}\p{M}\p{N}]+)*$/u.test(keyword))
    || new Set(value.keywords.map(keyword => keyword.toLowerCase())).size !== value.keywords.length
    || value.resetOnly && !value.keywords.length) throw new Error("Invalid reset monitor collection configuration: keywords must be distinct literal words or phrases");
  if (value.maxPagesPerRun !== undefined && (!Number.isSafeInteger(value.maxPagesPerRun) || value.maxPagesPerRun < 1)) {
    throw new Error("Invalid reset monitor collection configuration: maxPagesPerRun must be a positive integer");
  }
  return value;
}
export interface ResetMonitorSiteConfig {
  publicV2?: import("./public-v2.ts").PublicV2Config;
  authors: readonly ResetMonitorAuthor[];
  plans: readonly string[];
  collection: ResetMonitorCollectionConfig;
}
export interface ResetMonitorProductAlias { key: string; patterns: readonly string[] }

export interface ResetMonitorWebDefinition {
  publicV2?: import("./public-v2.ts").PublicV2Config;
  monitorId: string;
  moduleName: string;
  product: string;
  organization: string;
  authors: readonly ResetMonitorAuthor[];
  plans: readonly string[];
  productAliases?: readonly ResetMonitorProductAlias[];
  authorName: string;
  pagePath: string;
  adminPath: string;
  adminApiPath: string;
  publicApiPath: string;
  agentPath: string;
  mcpTool: string;
  description: string;
  title?: string;
  eventKinds: readonly ResetMonitorEventKind[];
}

export type ResetMonitorDefinition = ResetMonitorWebDefinition;


export const publicV2Path = (definition: ResetMonitorWebDefinition) => definition.publicApiPath;
