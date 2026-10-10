import * as shared from "@aihot/reset-monitor/backend/evidence";
import { bindMonitor } from "@aihot/reset-monitor/backend/context";
import { backendDefinition } from "../backend-definition.ts";
export const actionEvidence = bindMonitor(backendDefinition, shared.actionEvidence);
export const timeSource = bindMonitor(backendDefinition, shared.timeSource);
