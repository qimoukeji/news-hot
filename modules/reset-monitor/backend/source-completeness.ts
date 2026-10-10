import { sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { monitorId, auditAction, auditSubject } from "./context.ts";
import { bumpPublication } from "./manual-review.ts";

/** A link to an X Article supplies no evidence about its unsaved body. */
export function sourceContentIssue(text: string): string | null {
  const links = text.trim().split(/\s+/);
  return links.length > 0 && links.every(link => /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+(?:[?#].*)?$/i.test(link))
    ? "X Article 正文未保存，无法判断文章是否包含额度事件"
    : null;
}

/** Hold incomplete material without buying a model request or replacing its original result. */
export async function markIncompleteSource(postId: string, actor = "reset monitor") {
  return sql.begin(async tx => {
    const [post] = await tx`SELECT * FROM monitor_posts WHERE monitor_id=${monitorId()} AND id=${postId} FOR UPDATE`;
    if (!post) throw new Error(`monitor post ${postId} not found`);
    const reason = sourceContentIssue(post.text);
    if (!reason) throw new Error("Post has readable source text; incomplete-source hold is not applicable");
    if (post.recognition?.manualReview?.completed) return false;
    if (post.recognition?.needsReview && post.recognition?.sourceIssue === reason) return false;
    const [linked] = await tx`SELECT 1 FROM monitor_event_posts WHERE monitor_id=${monitorId()} AND post_id=${postId} LIMIT 1`;
    if (linked) throw new Error("Incomplete source already has event links; explicit review is required");
    const previous = post.recognition ?? {};
    const recognition = {
      ...previous,
      ...(post.recognition ? { originalRecognition: previous.originalRecognition ?? previous } : {}),
      relevant: true,
      needsReview: true,
      sourceIssue: reason,
      propositions: [],
      held: [],
      notify: [],
    };
    const [after] = await tx`UPDATE monitor_posts SET recognition=${tx.json(recognition)},
      raw=coalesce(raw,'{}'::jsonb)||${tx.json({ sourceIncomplete: reason })},
      activity=NULL,processed_at=coalesce(processed_at,now())
      WHERE monitor_id=${monitorId()} AND id=${postId} RETURNING *`;
    await audit(actor, auditAction("post.source_incomplete"), auditSubject("post", postId), reason, post, after, { db: tx });
    await bumpPublication(tx);
    return true;
  });
}
