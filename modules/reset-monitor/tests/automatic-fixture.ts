import { RESET_MONITORS } from "@aihot/site/reset-monitors";
import type { ResetMonitorSiteConfig } from "../definition.ts";

// Legacy engine regressions explicitly exercise automatic processing against local stubs.
// Import before product definitions; each test file has its own isolated Node process.
for (const definition of Object.values(RESET_MONITORS) as ResetMonitorSiteConfig[]) definition.processingMode = "automatic";
