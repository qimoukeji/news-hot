import type { ResetMonitorSiteConfig } from "@aihot/reset-monitor/definition";
import { RESET_MONITOR_V2 } from "./reset-monitor-v2.ts";

/** Public, credential-free configuration. Restart API and worker after changes. */
export const RESET_MONITORS = {
  codex: {
    publicV2: RESET_MONITOR_V2.codex,
    processingMode: "automatic_incremental",
    authors: [{ handle: "thsottiaux", name: "Tibo", timePolicy: "tibo" }],
    plans: ["Plus", "Pro", "Business", "Enterprise"],
  },
  claude: {
    publicV2: RESET_MONITOR_V2.claude,
    processingMode: "automatic_incremental",
    authors: [{ handle: "ClaudeDevs", name: "ClaudeDevs" }],
    plans: ["Free", "Pro", "Max", "Team", "Enterprise"],
  },
  grok: {
    publicV2: RESET_MONITOR_V2.grok,
    processingMode: "automatic_incremental",
    authors: [{ handle: "bot", name: "Grok Bot", defaultProduct: "Grok Bot" },
      { handle: "grok", name: "Grok", defaultProduct: "Grok 普通额度" }],
    plans: [],
  },
} satisfies Record<string, ResetMonitorSiteConfig>;

export function validateResetMonitorConfig(config: ResetMonitorSiteConfig): ResetMonitorSiteConfig {
  if (config.processingMode !== undefined && !["automatic", "collect_only", "automatic_incremental"].includes(config.processingMode)) {
    throw new Error("Invalid reset monitor processing mode");
  }
  if (!config.authors.length || config.authors.some(author => !/^[A-Za-z0-9_]{1,15}$/.test(author.handle)
    || !author.name.trim() || author.defaultProduct !== undefined && !author.defaultProduct.trim()
    || author.timePolicy !== undefined && !["explicit", "tibo"].includes(author.timePolicy))
    || new Set(config.authors.map(author => author.handle.toLowerCase())).size !== config.authors.length) {
    throw new Error("Invalid X monitor authors");
  }
  if (config.plans.some(plan => !plan.trim()) || new Set(config.plans.map(plan => plan.toLowerCase())).size !== config.plans.length) {
    throw new Error("Invalid reset monitor plans");
  }
  if (config.collection && !["all", "announcements_and_relevant_replies"].includes(config.collection.mode)) {
    throw new Error("Invalid reset monitor collection mode");
  }
  return config;
}
