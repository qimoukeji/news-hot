import definition from "./definition.ts";
import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";
import { prompt, promptVersion, buildPrompt } from "./prompt.ts";
import { defaultProductForAuthor, scopeConflicts, quotaScope } from "./scope-policy.ts";
import { excludeProposition } from "./recognition-policy.ts";
import { monitorNames } from "@aihot/reset-monitor/server";
import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";

export const backendDefinition: ResetMonitorBackendDefinition = {
  collection: validateResetMonitorConfig(RESET_MONITORS.grok).collection,
  ...definition, providerEnv: "GROK_RESET_PROVIDER", scanMinutesEnv: "GROK_RESET_SCAN_MINUTES",
  prompt, promptVersion, buildPrompt, names: monitorNames(definition.monitorId),
  quotaScope, defaultProductForAuthor, scopeConflicts, excludeProposition, requireCrossAuthorEvidence: true,
};
