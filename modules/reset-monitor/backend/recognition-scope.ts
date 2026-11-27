import { fixedScopeNote } from "./scope-labels.ts";
import { quotedInPost } from "./evidence.ts";
import type { ActionRecognitionBody } from "./recognize.ts";

type Claim = ActionRecognitionBody["actions"][number];

/** Only the current source can establish a new audience; details stay in the summary. */
export function recognizedScope(claim: Claim, post: string): { scope: Claim["scope"]; issue: string | null } {
  const unknown = { type: "unknown" as const, note: fixedScopeNote("unknown") };
  if (claim.scope.type === "unknown") return { scope: unknown, issue: null };
  if (!claim.scopeExcerpt) return { scope: unknown, issue: claim.scope.type === "selected_users" ? "缺少范围原文依据" : null };
  if (!quotedInPost(claim.scopeExcerpt, post)) return { scope: unknown, issue: "范围不在本帖中" };
  if (claim.scope.type === "selected_users" && claim.scope.multipleAudiences === true)
    return { scope: { type: "selected_users", note: fixedScopeNote("paid_users") }, issue: null };
  if (claim.scope.type === "selected_users" && !claim.scope.note)
    return { scope: unknown, issue: "特定用户缺少范围说明" };
  return { scope: { type: claim.scope.type, note: claim.scope.note }, issue: null };
}
