import definition from "./definition.ts";
import { RESET_MONITORS, validateResetMonitorConfig } from "@aihot/site/reset-monitors";
import { prompt, promptVersion, buildPrompt } from "./prompt.ts";
import { excludeProposition } from "./recognition-policy.ts";
import { quotaScope, scopeConflicts, defaultProductForAuthor } from "./scope-policy.ts";
import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";

export const backendDefinition: ResetMonitorBackendDefinition = {
  collection: validateResetMonitorConfig(RESET_MONITORS.codex).collection,
  ...definition, providerEnv: "CODEX_RESET_PROVIDER", scanMinutesEnv: "CODEX_RESET_SCAN_MINUTES",
  prompt, promptVersion, buildPrompt,
  quotaScope, scopeConflicts, defaultProductForAuthor, excludeProposition, requireCrossAuthorEvidence: true,
  names: { tick: "monitor.tick", purposePrefix: "monitor",
    auditActionPrefix: "monitor", auditSubjectPrefix: "monitor", deliveryKind: "codex_reset", deliveryPrefix: "codex" },
};
