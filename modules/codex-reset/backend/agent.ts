import * as shared from "@aihot/reset-monitor/backend/agent";
import { bindMonitor } from "@aihot/reset-monitor/backend/context";
import { backendDefinition } from "../backend-definition.ts";
export const codexAnswer = bindMonitor(backendDefinition, shared.monitorAnswer);
