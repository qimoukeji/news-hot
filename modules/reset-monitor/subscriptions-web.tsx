import { defineWebModule } from "@aihot/web/modules";

export const subscriptionsWebModule = defineWebModule({
  name: "reset-monitor",
  admin: { content: [{ to: "/admin/reset-subscriptions", label: "事件订阅" }] },
});
