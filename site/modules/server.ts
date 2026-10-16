// The backend of the site's modules, installed by the api and the worker when they start (site/modules/index.ts).
import codexReset from "@aihot/codex-reset/server";
import claudeReset from "@aihot/claude-reset/server";
import grokReset from "@aihot/grok-reset/server";
import type { ServerModule } from "@aihot/backend/modules";
import { createOverviewServer } from "@aihot/reset-monitor/overview-server";
import { RESET_MONITOR_BACKENDS } from "../reset-monitor-backends.ts";

export const SERVER_MODULES: readonly ServerModule[] = [codexReset, claudeReset, grokReset, createOverviewServer(RESET_MONITOR_BACKENDS)];
