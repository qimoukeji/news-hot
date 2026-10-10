// The backend of the site's modules, installed by the api and the worker when they start (site/modules/index.ts).
import codexReset from "@aihot/codex-reset/server";
import claudeReset from "@aihot/claude-reset/server";
import type { ServerModule } from "@aihot/backend/modules";

export const SERVER_MODULES: readonly ServerModule[] = [codexReset, claudeReset];
