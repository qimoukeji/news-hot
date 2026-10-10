import * as shared from "@aihot/reset-monitor/backend/publication";
import { bindMonitor } from "@aihot/reset-monitor/backend/context";
import { backendDefinition } from "../backend-definition.ts";
export const siteCodexResetPage = bindMonitor(backendDefinition, shared.siteResetMonitorPage);
export const loadSiteCodexResetPage = bindMonitor(backendDefinition, shared.loadSiteResetMonitorPage);
export const loadSiteCodexResetDay = bindMonitor(backendDefinition, shared.loadSiteResetMonitorDay);
