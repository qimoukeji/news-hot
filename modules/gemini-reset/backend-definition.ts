import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";
import { monitorNames } from "@aihot/reset-monitor/server";
import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";
import { excludeNonEvent } from "@aihot/reset-monitor/backend/recognition-policy";
import definition from "./definition.ts";
import { buildPrompt, prompt, promptVersion } from "./prompt.ts";

export const backendDefinition: ResetMonitorBackendDefinition = {
  collection: validateResetMonitorConfig(RESET_MONITORS.gemini).collection,
  ...definition, providerEnv: "GEMINI_RESET_PROVIDER", scanMinutesEnv: "GEMINI_RESET_SCAN_MINUTES",
  buildPrompt, prompt, promptVersion, names: monitorNames(definition.monitorId), excludeProposition: excludeNonEvent,
};
