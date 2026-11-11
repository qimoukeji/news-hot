import definition from "./definition.ts";
import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";
import { prompt, promptVersion, buildPrompt } from "./prompt.ts";
import { excludeProposition } from "./recognition-policy.ts";
import { monitorNames } from "@aihot/reset-monitor/server";
import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";

export const backendDefinition: ResetMonitorBackendDefinition = {
  collection: validateResetMonitorConfig(RESET_MONITORS.claude).collection,
  ...definition, providerEnv: "CLAUDE_RESET_PROVIDER", scanMinutesEnv: "CLAUDE_RESET_SCAN_MINUTES",
  prompt, promptVersion, buildPrompt,
  names: monitorNames(definition.monitorId), excludeProposition, requireCrossAuthorEvidence: true,
};
