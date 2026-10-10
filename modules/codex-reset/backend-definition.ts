import definition from "./definition.ts";
import { prompt, promptVersion } from "./prompt.ts";
import { resolve, estimate } from "./time-policy.ts";
import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";

export const backendDefinition: ResetMonitorBackendDefinition = {
  ...definition, providerEnv: "CODEX_RESET_PROVIDER", scanMinutesEnv: "CODEX_RESET_SCAN_MINUTES",
  prompt, promptVersion,
  plans: ["Plus", "Pro", "Business", "Enterprise"],
  names: { tick: "monitor.tick", lookback: "monitor.lookback", purposePrefix: "monitor",
    auditActionPrefix: "monitor", auditSubjectPrefix: "monitor", deliveryKind: "codex_reset", deliveryPrefix: "codex" },
  timing: { resolve, estimate },
};
