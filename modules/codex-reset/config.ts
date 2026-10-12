import * as shared from "@aihot/reset-monitor/config";
import { bindMonitor } from "@aihot/reset-monitor/backend/context";
import { backendDefinition } from "./backend-definition.ts";
export const scanMinutes = bindMonitor(backendDefinition, shared.scanMinutes);
export const scanCron = bindMonitor(backendDefinition, shared.scanCron);
export const collectorName = bindMonitor(backendDefinition, shared.collectorName);
export const cursorKey = bindMonitor(backendDefinition, shared.cursorKey);
export const watermarksKey = bindMonitor(backendDefinition, shared.watermarksKey);
