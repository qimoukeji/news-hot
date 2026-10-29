import { defineServerModule } from "@aihot/backend/modules";
import type { ResetMonitorBackendDefinition } from "./backend/context.ts";
import { initializeWebhookBaselines, sweepConfirmationResults } from "./backend/webhook-events.ts";
import { webhookDeliveryQueue, sweepWebhookDeliveries } from "./backend/webhooks.ts";
import { registerSubscriptionsHttp } from "./api/subscriptions.ts";
import { subscriptionsModule } from "./subscriptions-module.ts";

/** Shared management and delivery are installed once for all configured monitors. */
export function createSubscriptionsServer(definitions: readonly ResetMonitorBackendDefinition[]) {
  return defineServerModule({
    name:subscriptionsModule.name,
    http:app => registerSubscriptionsHttp(app,definitions),
    queues:[webhookDeliveryQueue],
    schedules:[{name:"reset-confirmations.check",cron:"* * * * *",retryLimit:0,run:() => sweepConfirmationResults(definitions)}, {name:"reset-subscriptions.sweep",cron:"* * * * *",retryLimit:0,run:async () => {
      await initializeWebhookBaselines(definitions);
      return sweepWebhookDeliveries();
    }}],
  });
}
