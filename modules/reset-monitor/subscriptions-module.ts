import { defineModule } from "@aihot/contracts/modules";

export const REVIEW_NOTIFICATION_JOB = "reset-review.notify";

export const subscriptionsModule = defineModule({
  name: "reset-monitor",
  adminPages: [{ path: "admin/reset-subscriptions", file: "web/subscriptions.tsx" }],
  apiPaths: [/^\/api\/admin\/reset-subscriptions(?:\/.*)?$/],
});
