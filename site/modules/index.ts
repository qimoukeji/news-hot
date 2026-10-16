// The modules this site runs (modules/<name>/, see docs/architecture.md). A module has a line in each list
// it has an entry for: here for its addresses (module.ts), in server.ts for its backend, in web.ts for its
// pages' parts. Each list keeps the order its entries appear in on the site.
import codexReset from "@aihot/codex-reset/module";
import claudeReset from "@aihot/claude-reset/module";
import grokReset from "@aihot/grok-reset/module";
import type { ModuleDeclaration } from "@aihot/contracts/modules";
import { overviewModule } from "@aihot/reset-monitor/overview-module";

export const MODULES: readonly ModuleDeclaration[] = [codexReset, claudeReset, grokReset, overviewModule];
