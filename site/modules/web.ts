// What the site's modules add to the web pages (site/modules/index.ts).
import codexReset from "@aihot/codex-reset/web";
import claudeReset from "@aihot/claude-reset/web";
import grokReset from "@aihot/grok-reset/web";
import geminiReset from "@aihot/gemini-reset/web";
import type { WebModule } from "@aihot/web/modules";
import { subscriptionsWebModule } from "@aihot/reset-monitor/subscriptions-web";

export const WEB_MODULES: readonly WebModule[] = [codexReset, claudeReset, grokReset, geminiReset, subscriptionsWebModule];
