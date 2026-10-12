// What the site's modules add to the web pages (site/modules/index.ts).
import codexReset from "@aihot/codex-reset/web";
import claudeReset from "@aihot/claude-reset/web";
import grokReset from "@aihot/grok-reset/web";
import type { WebModule } from "@aihot/web/modules";

export const WEB_MODULES: readonly WebModule[] = [codexReset, claudeReset, grokReset];
