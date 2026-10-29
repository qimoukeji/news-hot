import definition from "./definition.ts";
import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";
import { prompt, promptVersion, buildPrompt } from "./prompt.ts";
import { quotaScope, productForAuthor, scopeConflicts } from "@aihot/reset-monitor/backend/scope-policy";
import { excludeProposition } from "./recognition-policy.ts";
import { monitorNames } from "@aihot/reset-monitor/server";
import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";
import { monitor } from "@aihot/reset-monitor/backend/context";

export const backendDefinition: ResetMonitorBackendDefinition = {
  collection: validateResetMonitorConfig(RESET_MONITORS.claude).collection,
  ...definition, providerEnv: "CLAUDE_RESET_PROVIDER", scanMinutesEnv: "CLAUDE_RESET_SCAN_MINUTES",
  prompt, promptVersion, buildPrompt,
  names: monitorNames(definition.monitorId), quotaScope, excludeProposition,
  defaultProductForAuthor: author => productForAuthor(monitor().authors, author),
  scopeConflicts: (a, b) => scopeConflicts(a, b, monitor().productAliases), requireCrossAuthorEvidence: true,
};
