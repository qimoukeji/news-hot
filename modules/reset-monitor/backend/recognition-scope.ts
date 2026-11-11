import { quotedInPost } from "./evidence.ts";
import type { ActionRecognitionBody } from "./recognize.ts";

type Claim = ActionRecognitionBody["actions"][number];

/** Only the current source can establish a new audience; details stay in the summary. */
export function recognizedScope(claim: Claim, post: string): { scope: Claim["scope"]; issue: string | null } {
  const unknown = { type: "unknown" as const, note: null };
  if (!claim.scopeExcerpt) return { scope: unknown, issue: null };
  if (!quotedInPost(claim.scopeExcerpt, post)) return { scope: unknown, issue: "范围不在本帖中" };
  if (claim.scope.type === "selected_users" && !claim.scope.note)
    return { scope: unknown, issue: "特定用户缺少范围说明" };
  return { scope: claim.scope.type === "unknown" ? unknown : claim.scope, issue: null };
}
