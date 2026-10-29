import { parseArgs } from "node:util";
import { sql, closeDb } from "@aihot/backend/db";
import { RESET_MONITOR_BACKENDS } from "@aihot/site/reset-monitor-backends";
import { inMonitor } from "../backend/context.ts";
import { applyThreadRepair, previewThreadRepair } from "../backend/thread-repair.ts";
const { values } = parseArgs({ strict: true, options: {
  platform: { type: "string" }, receipts: { type: "string" }, targets: { type: "string" },
  apply: { type: "boolean" }, "worker-stopped": { type: "boolean" }, fingerprint: { type: "string" }, backup: { type: "string" },
} });
try {
  const definition = RESET_MONITOR_BACKENDS.find(definition => definition.monitorId === values.platform);
  if (!definition || !values.receipts || !values.targets) throw new Error("Select --platform, comma-separated --receipts and --targets");
  if (process.env.COLLECT_ENABLED === "true" || process.env.MODEL_CALLS_ENABLED === "true"
    || process.env.WEBHOOK_PUSH_ENABLED === "true" || process.env.FEISHU_CONTENT_PUSH_ENABLED === "true") throw new Error("Keep collection, models and real notifications disabled during repair");
  const options = { receiptIds: values.receipts.split(",").map(Number), targetPostIds: values.targets.split(",") };
  await inMonitor(definition, async () => {
    if (values.apply) {
      if (!values["worker-stopped"] || !values.fingerprint || !values.backup) throw new Error("--apply requires --worker-stopped, reviewed --fingerprint and complete --backup");
      console.log(JSON.stringify(await applyThreadRepair(options, values.fingerprint, values.backup), null, 2));
    } else {
      if (values["worker-stopped"] || values.fingerprint || values.backup) throw new Error("Apply arguments cannot be used in read-only preview");
      console.log(JSON.stringify(await sql.begin("isolation level repeatable read read only", tx => previewThreadRepair(options, tx)), null, 2));
    }
  });
} finally { await closeDb(); }
