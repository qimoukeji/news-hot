import { defineServerModule } from "@aihot/backend/modules";
import { queueEnabled } from "@aihot/backend/jobs/queue";
import type { ResetMonitorBackendDefinition } from "./backend/context.ts";
import { assertScopeCutoverComplete, initializeWebhookBaselines, sweepConfirmationResults } from "./backend/webhook-events.ts";
import { webhookDeliveryQueue, sweepWebhookDeliveries } from "./backend/webhooks.ts";
import { registerSubscriptionsHttp } from "./api/subscriptions.ts";
import { REVIEW_NOTIFICATION_JOB, subscriptionsModule } from "./subscriptions-module.ts";
import { reconcileReviewNotificationSettings, sendReviewNotifications } from "./backend/review-notifications.ts";
import { reviewNotificationRuns } from "./backend/review-notification-runs.ts";

/** Shared management and delivery are installed once for all configured monitors. */
export function createSubscriptionsServer(definitions: readonly ResetMonitorBackendDefinition[]) {
  return defineServerModule({
    name:subscriptionsModule.name,
    http:app => {
      app.addHook("onReady", async () => { await assertScopeCutoverComplete(); });
      registerSubscriptionsHttp(app,definitions);
    },
    admin:{runs:() => reviewNotificationRuns(definitions)},
    on:{workerStarting:async () => {
      await assertScopeCutoverComplete();
      await reconcileReviewNotificationSettings(queueEnabled(`cron.${REVIEW_NOTIFICATION_JOB}`) ? undefined : false);
    }},
    queues:[webhookDeliveryQueue],
    schedules:[{name:REVIEW_NOTIFICATION_JOB,cron:"* * * * *",retryLimit:0,run:() => sendReviewNotifications(definitions)}, {name:"reset-confirmations.check",cron:"* * * * *",retryLimit:0,run:() => sweepConfirmationResults(definitions)}, {name:"reset-subscriptions.sweep",cron:"* * * * *",retryLimit:0,run:async () => {
      await initializeWebhookBaselines(definitions);
      return sweepWebhookDeliveries();
    }}],
  });
}
