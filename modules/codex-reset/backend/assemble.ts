import * as shared from "@aihot/reset-monitor/backend/assemble";
import { bindMonitor } from "@aihot/reset-monitor/backend/context";
import { backendDefinition } from "../backend-definition.ts";
export const quotedInPost = bindMonitor(backendDefinition, shared.quotedInPost);
export const applyRecognition = bindMonitor(backendDefinition, shared.applyRecognition);
export type { Applied } from "@aihot/reset-monitor/backend/assemble";
