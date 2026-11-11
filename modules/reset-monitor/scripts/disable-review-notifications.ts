import { parseArgs } from "node:util";
import { closeDb } from "@aihot/backend/db";
import { reconcileReviewNotificationSettings } from "../backend/review-notifications.ts";

const { values } = parseArgs({ strict: true, options: { "worker-stopped": { type: "boolean" } } });
if (!values["worker-stopped"] || process.env.SERVERCHAN_ENABLED === "true") {
  throw new Error("Stop all workers and keep SERVERCHAN_ENABLED=false before disabling review notifications");
}
try {
  await reconcileReviewNotificationSettings(false);
  console.log("Review notifications disabled; pending eligibility invalidated");
} finally {
  await closeDb();
}
