import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { closeDb } from "@aihot/backend/db";
import { clearOfflineMonitor, importOfflineBundle, finishOfflineImport, offlinePlan, type OfflinePhase } from "../backend/offline-import.ts";

const { values } = parseArgs({ options: { phase: { type: "string", default: "import" }, bundle: { type: "string" }, apply: { type: "boolean" }, fingerprint: { type: "string" }, target: { type: "string" }, backup: { type: "string" }, "worker-stopped": { type: "boolean" } }, strict: true });
try {
  if (!["clear", "import", "finish"].includes(values.phase!)) throw new Error("--phase must be clear, import or finish");
  const phase = values.phase as OfflinePhase;
  const bundle = values.bundle ? JSON.parse(await readFile(values.bundle, "utf8")) : undefined;
  if (phase === "import" && !bundle || phase !== "import" && bundle) throw new Error("--bundle is required only for the import phase");
  if (!values.apply) {
    if (values.target || values.fingerprint || values.backup || values["worker-stopped"]) throw new Error("Apply arguments cannot be used in read-only preview");
    console.log(JSON.stringify(await offlinePlan(phase, bundle), null, 2));
  } else {
    if (!values["worker-stopped"] || !values.target || !values.fingerprint) throw new Error("--apply requires --worker-stopped and reviewed --target and --fingerprint");
    const options = { target: values.target, fingerprint: values.fingerprint, workerStopped: true };
    if (phase === "clear") {
      if (!values.backup) throw new Error("Clearing requires a complete --backup validated by a restore rehearsal");
      console.log(JSON.stringify(await clearOfflineMonitor({ ...options, backup: values.backup }), null, 2));
    } else {
      if (values.backup) throw new Error("--backup applies only to clearing");
      console.log(JSON.stringify(phase === "import" ? await importOfflineBundle(bundle, options) : await finishOfflineImport(options), null, 2));
    }
  }
} finally { await closeDb(); }
