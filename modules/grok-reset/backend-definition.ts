import definition from "./definition.ts";
import { prompt, promptVersion } from "./prompt.ts";
import { resolve, estimate } from "./time-policy.ts";
import { defaultProductForAuthor, scopeConflicts } from "./scope-policy.ts";
import { excludeProposition } from "./recognition-policy.ts";
import { monitorNames } from "@aihot/reset-monitor/server";
import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";

export const backendDefinition: ResetMonitorBackendDefinition = {
  ...definition, providerEnv: "GROK_RESET_PROVIDER", scanMinutesEnv: "GROK_RESET_SCAN_MINUTES",
  prompt, promptVersion, plans: [], names: monitorNames(definition.monitorId),
  timing: { resolve, estimate }, defaultProductForAuthor, scopeConflicts, excludeProposition, requireCrossAuthorEvidence: true,
};
