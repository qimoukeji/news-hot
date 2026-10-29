import { z } from "zod";
import { eventListSchema, platformSchema, timestampSchema } from "./public-v2.ts";

export const webhookPayloadSchema = z.strictObject({
  schemaVersion: z.literal(2), id: z.uuid(), occurredAt: timestampSchema, platform: platformSchema,
  eventId: z.string().min(1), revision: z.number().int().positive(),
  action: z.enum(["created", "updated", "withdrawn", "restored"]),
  event: eventListSchema.shape.list.element.nullable(),
}).refine(value => value.action === "withdrawn" ? value.event === null : value.event?.id === value.eventId,
  "Only withdrawals have no event, and event IDs must match");
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
export type WebhookPlatform = z.infer<typeof platformSchema>;
export const webhookPlatforms = platformSchema.options;

export interface WebhookSubscription {
  id: string; name: string; url: string; platforms: WebhookPlatform[]; enabled: boolean;
  enabledAt: string | null; generation: number; createdAt: string; updatedAt: string;
}
export interface WebhookDelivery {
  id: string; subscriptionId: string; notificationId: string; platform: WebhookPlatform; eventId: string;
  action: WebhookPayload["action"]; revision: number;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  attempts: number; nextAttemptAt: string | null; lastStatus: number | null; lastError: string | null;
  createdAt: string; sentAt: string | null;
}
export interface WebhookAdminData {
  subscriptions: WebhookSubscription[]; pushEnabled: boolean;
}
export interface WebhookSubscriptionInput {
  name: string; url: string; platforms: WebhookPlatform[]; enabled?: boolean; reason: string;
}
