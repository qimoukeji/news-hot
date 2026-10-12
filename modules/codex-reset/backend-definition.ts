import definition from "./definition.ts";
import { prompt, promptVersion, buildPrompt } from "./prompt.ts";
import { resolve as tiboResolve, estimate as tiboEstimate } from "./time-policy.ts";
import { resolve, estimate } from "@aihot/reset-monitor/backend/explicit-time";
import { buildCollectionFilter } from "@aihot/reset-monitor/collection-filter";
import { excludeProposition } from "./recognition-policy.ts";
import { quotaScope, scopeConflicts, defaultProductForAuthor } from "./scope-policy.ts";
import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";

export const backendDefinition: ResetMonitorBackendDefinition = {
  ...definition, providerEnv: "CODEX_RESET_PROVIDER", scanMinutesEnv: "CODEX_RESET_SCAN_MINUTES",
  prompt, promptVersion, buildPrompt, collectionFilter: buildCollectionFilter(definition.collection),
  quotaScope, scopeConflicts, defaultProductForAuthor, excludeProposition, requireCrossAuthorEvidence: true,
  names: { tick: "monitor.tick", lookback: "monitor.lookback", purposePrefix: "monitor",
    auditActionPrefix: "monitor", auditSubjectPrefix: "monitor", deliveryKind: "codex_reset", deliveryPrefix: "codex" },
  timing: { resolve, estimate },
  timingProfiles: { tibo: { resolve: tiboResolve, estimate: tiboEstimate } },
};
