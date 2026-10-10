import { initializeMonitor, initializeUsage, initialRangeFromArgs as parseRange } from "@aihot/reset-monitor/initialize";

export const INITIALIZE_USAGE = initializeUsage("@aihot/codex-reset");
export const initialRangeFromArgs = (args: string[], now = new Date()) => parseRange(args, now, INITIALIZE_USAGE);

if (import.meta.main) await initializeMonitor(INITIALIZE_USAGE, async () => {
  const { default: module } = await import("../server.ts");
  const { backendDefinition: definition } = await import("../backend-definition.ts");
  return { module, definition };
});
