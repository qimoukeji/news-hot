import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { adminHandler } from "@aihot/api/routes/admin-auth";
import { sendProblem } from "@aihot/api/http/respond";
import { actorOf } from "@aihot/backend/admin/auth";
import type { ResetMonitorBackendDefinition } from "../backend/context.ts";
import * as webhooks from "../backend/webhooks.ts";

const params = (req: FastifyRequest) => z.object({id:z.uuid(),deliveryId:z.uuid().optional()}).parse(req.params);
function found(req: FastifyRequest, reply: FastifyReply, value: unknown) {
  return value ?? sendProblem(req,reply,{status:404,code:"not_found",detail:"订阅或投递记录不存在"});
}
export function registerSubscriptionsHttp(app: FastifyInstance, definitions: readonly ResetMonitorBackendDefinition[]) {
  const path = "/api/admin/reset-subscriptions";
  app.get(path,adminHandler(async () => webhooks.listSubscriptions()));
  app.post(path,adminHandler(async (req,reply,who) => {
    reply.header("Cache-Control","no-store");
    return webhooks.createSubscription(req.body,actorOf(who),definitions);
  }));
  app.patch(path+"/:id",adminHandler(async (req,reply,who) =>
    found(req,reply,await webhooks.updateSubscription(params(req).id,req.body,actorOf(who),definitions))));
  app.post(path+"/:id/rotate-secret",adminHandler(async (req,reply,who) => {
    const input = webhooks.webhookReasonSchema.parse(req.body);
    reply.header("Cache-Control","no-store");
    return found(req,reply,await webhooks.rotateSubscriptionSecret(params(req).id,input.reason,actorOf(who)));
  }));
  app.get(path+"/:id/deliveries",adminHandler(async (req,reply) =>
    found(req,reply,await webhooks.listWebhookDeliveries(params(req).id))));
  app.post(path+"/:id/deliveries/:deliveryId/retry",adminHandler(async (req,reply,who) => {
    const p = params(req), input = webhooks.webhookReasonSchema.parse(req.body);
    return found(req,reply,await webhooks.retryWebhookDelivery(p.id,p.deliveryId!,input.reason,actorOf(who)));
  }));
}
