import { defineModule } from "@aihot/contracts/modules";

export const subscriptionsModule = defineModule({
  name: "reset-monitor",
  adminPages: [{ path: "admin/reset-subscriptions", file: "web/subscriptions.tsx" }],
  apiPaths: [/^\/api\/admin\/reset-subscriptions(?:\/.*)?$/],
});
