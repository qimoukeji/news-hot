import { RESET_MONITORS } from "@aihot/site/reset-monitors";
import type { ResetMonitorSiteConfig } from "../definition.ts";

// Explicitly exercise the optional collection-only policy, independently of this site's mode.
for (const definition of Object.values(RESET_MONITORS) as ResetMonitorSiteConfig[]) definition.processingMode = "collect_only";
