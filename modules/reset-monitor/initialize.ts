import { parseArgs } from "node:util";
import { z } from "zod";
import type { ServerModule } from "@aihot/backend/modules";
import type { ResetMonitorBackendDefinition } from "./backend/context.ts";

export const initializeUsage = (packageName: string) => `npm run initialize -w ${packageName} -- --since <ISO-with-timezone> --until <ISO-with-timezone> [--collect-only]`;

export function initialRangeFromArgs(args: string[], now = new Date(), usage = "--since <ISO-with-timezone> --until <ISO-with-timezone>"): { since: string; until: string } | null {
  return initializationOptionsFromArgs(args, now, usage)?.initialRange ?? null;
}

export function initializationOptionsFromArgs(args: string[], now = new Date(), usage = "--since <ISO-with-timezone> --until <ISO-with-timezone>") {
  const { values } = parseArgs({ args, options: { since: { type: "string" }, until: { type: "string" }, help: { type: "boolean" }, "collect-only": { type: "boolean" } }, strict: true, allowPositionals: false });
  if (values.help) return null;
  const instant = z.iso.datetime({ offset: true });
  if (!instant.safeParse(values.since).success || !instant.safeParse(values.until).success) {
    throw new Error(`Both --since and --until must be ISO times with a timezone. Usage: ${usage}`);
  }
  const since = values.since!; const until = values.until!;
  if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)) || Date.parse(since) >= Date.parse(until) || Date.parse(until) > now.getTime()) {
    throw new Error("Initialization requires since < until <= current time");
  }
  return { initialRange: { since, until }, collectOnly: values["collect-only"] === true };
}

/** Parse before loading the backend, so help and invalid ranges never open a database or provider. */
export async function initializeMonitor(usage: string, load: () => Promise<{ module: ServerModule; definition: ResetMonitorBackendDefinition }>) {
  let close: (() => Promise<void>) | undefined;
  let stop: (() => void) | undefined;
  try {
    const options = initializationOptionsFromArgs(process.argv.slice(2), new Date(), usage);
    if (!options) console.log(usage);
    else {
      const { config } = await import("@aihot/backend/config");
      if (process.env.COLLECT_ENABLED !== "true" || !options.collectOnly && !config.modelCallsEnabled) throw new Error("Initialization requires COLLECT_ENABLED=true and, unless --collect-only, MODEL_CALLS_ENABLED=true");
      const { closeDb } = await import("@aihot/backend/db");
      close = closeDb;
      const { shutdownSignal } = await import("@aihot/backend/lib/shutdown");
      stop = () => shutdownSignal.abort(new Error("Initialization stopped"));
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      const { installModules } = await import("@aihot/backend/modules");
      const { module, definition } = await load();
      installModules([module]);
      const { monitorTick } = await import("./backend/scan.ts");
      const { inMonitor } = await import("./backend/context.ts");
      const result = await inMonitor(definition, () => monitorTick(options));
      if ("skipped" in result) throw new Error("Another monitor round is running; initialization was not performed");
      console.log(JSON.stringify({ initialRange: options.initialRange, ...result }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (stop) { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    await close?.();
  }
}
