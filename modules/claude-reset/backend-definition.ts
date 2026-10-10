import definition from "./definition.ts";
import { prompt, promptVersion } from "./prompt.ts";
import { resolve, estimate } from "./time-policy.ts";
import { quotaScope } from "./scope-policy.ts";
import { excludeProposition } from "./recognition-policy.ts";
import { monitorNames } from "@aihot/reset-monitor/server";
import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";

export const backendDefinition: ResetMonitorBackendDefinition = {
  ...definition, providerEnv: "CLAUDE_RESET_PROVIDER", scanMinutesEnv: "CLAUDE_RESET_SCAN_MINUTES",
  prompt, promptVersion,
  plans: ["Free", "Pro", "Max", "Team", "Enterprise"], names: monitorNames(definition.monitorId), timing: { resolve, estimate }, quotaScope, excludeProposition,
};
