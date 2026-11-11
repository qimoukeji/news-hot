import { validateCollectionConfig, type ResetMonitorSiteConfig } from "@aihot/reset-monitor/definition";

/** Public, credential-free configuration. Restart API and worker after changes. */
export const RESET_MONITORS = {
  codex: {
    collection: { includeReplies: false, includeSelfReplies: true, resetOnly: false, keywords: ["reset", "resets", "resetting", "banked", "credit", "credits", "重置", "额度", "額度"] },
    publicV2: { platform: "codex" },
    authors: [{ handle: "thsottiaux", name: "Tibo" }],
  },
  claude: {
    collection: { includeReplies: false, includeSelfReplies: true, resetOnly: false, keywords: ["reset", "resets", "resetting", "banked", "credit", "credits", "重置", "额度", "額度"] },
    publicV2: { platform: "claude-code" },
    authors: [{ handle: "ClaudeDevs", name: "ClaudeDevs" }],
  },
  grok: {
    collection: { includeReplies: false, includeSelfReplies: true, resetOnly: false, keywords: ["reset", "resets", "resetting", "banked", "credit", "credits", "重置", "额度", "額度"], maxPagesPerRun: 5 },
    publicV2: { platform: "grok" },
    authors: [{ handle: "bot", name: "Grok Bot" }, { handle: "grok", name: "Grok" }],
  },
} satisfies Record<string, ResetMonitorSiteConfig>;

export function validateResetMonitorConfig(config: ResetMonitorSiteConfig): ResetMonitorSiteConfig {
  if (!config.authors.length || config.authors.some(author => !/^[A-Za-z0-9_]{1,15}$/.test(author.handle)
    || !author.name.trim())
    || new Set(config.authors.map(author => author.handle.toLowerCase())).size !== config.authors.length) {
    throw new Error("Invalid X monitor authors");
  }
  validateCollectionConfig(config.collection);
  return config;
}
