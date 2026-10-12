import definition from "./definition.ts";
import { prompt, promptVersion, buildPrompt } from "./prompt.ts";
import { resolve, estimate } from "./time-policy.ts";
import { quotaScope, productForAuthor, scopeConflicts } from "@aihot/reset-monitor/backend/scope-policy";
import { buildCollectionFilter } from "@aihot/reset-monitor/collection-filter";
import { excludeProposition } from "./recognition-policy.ts";
import { monitorNames } from "@aihot/reset-monitor/server";
import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";
import { monitor } from "@aihot/reset-monitor/backend/context";

export const backendDefinition: ResetMonitorBackendDefinition = {
  ...definition, providerEnv: "CLAUDE_RESET_PROVIDER", scanMinutesEnv: "CLAUDE_RESET_SCAN_MINUTES",
  prompt, promptVersion, buildPrompt, collectionFilter: buildCollectionFilter(definition.collection),
  names: monitorNames(definition.monitorId), timing: { resolve, estimate }, quotaScope, excludeProposition,
  defaultProductForAuthor: author => productForAuthor(monitor().authors, author),
  scopeConflicts: (a, b) => scopeConflicts(a, b, monitor().productAliases), requireCrossAuthorEvidence: true,
};
