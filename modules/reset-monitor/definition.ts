/** Public display and route configuration. No backend configuration or credentials. */
import type { ResetMonitorEventKind } from "./contracts.ts";

export interface ResetMonitorWebDefinition {
  monitorId: string;
  moduleName: string;
  product: string;
  organization: string;
  author: string;
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
