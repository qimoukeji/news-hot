import * as shared from "@aihot/reset-monitor/backend/recognize";
import { bindMonitor } from "@aihot/reset-monitor/backend/context";
import { backendDefinition } from "../backend-definition.ts";
export const recognizePost = bindMonitor(backendDefinition, shared.recognizePost);
export { promptVersion as RECOGNIZE_PROMPT_VERSION } from "../prompt.ts";
export const RecognitionSchema = shared.RecognitionSchema;
export type { ContextInput, OpenEventInput, Recognition, Proposition } from "@aihot/reset-monitor/backend/recognize";
