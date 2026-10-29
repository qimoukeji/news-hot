import type { ActionInput, ActionRow } from "../actions.ts";
import { properName } from "../backend/public-v2.ts";
export const at = "2026-10-10T10:00:00.000Z";
export function fixture(type: ActionInput["events"][number]["type"] = "direct_reset"): ActionInput {
  return {
    events: [{ id: "event-1", type, title: null, summary: null, scope: null, withdrawn: false, created_at: at, updated_at: at }],
    posts: [{ id: "post-1", author: "thsottiaux", published_at: at, url: "https://x.com/thsottiaux/status/post-1", text: "Synthetic original source", quoted_post: null, reply_to: null, filtered_out: false, title: properName("Source"), summary: null, source_receipt_id: null, model_receipt_id: null, processing_status: "processed", review_reason: null, created_at: at, updated_at: at }],
    actions: [{ id: "action-1", event_id: "event-1", sequence: 1, action: "confirm", invalidates_event: false, title: properName("Confirmed"), summary: properName("Quota restored"), time: null, sources: [{ postId: "post-1" }], created_at: at, updated_at: at }],
  };
}
export function addAction(input: ActionInput, id: string, action: ActionRow["action"], publishedAt: string, patch: Partial<ActionRow> = {}) {
  const postId = `${id}-source`;
  input.posts.push({ ...input.posts[0]!, id: postId, published_at: publishedAt, url: `https://example.test/${postId}` });
  input.actions.push({ ...input.actions[0]!, id, sequence: Math.max(...input.actions.map(action => action.sequence)) + 1, action, time: null, sources: [{ postId }], ...patch });
}
