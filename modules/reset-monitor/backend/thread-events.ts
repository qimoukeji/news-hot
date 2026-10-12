import type { Tx } from "@aihot/backend/db";
import { monitorId, isAuthor } from "./context.ts";
import type { ContextInput, Proposition } from "./recognize.ts";

/** Association uses saved official ancestry, never an unverified context quotation. */
export async function trustedThreadEvents(tx: Tx, context: ContextInput[], postAt: Date): Promise<Array<{ id: string; type: Proposition["kind"] }>> {
  const seen = new Set<string>();
  const verified: string[] = [];
  let frontier = context;
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    const inputs = frontier.filter((c) => !seen.has(c.id) && ["reply", "quote"].includes(c.relation)
      && isAuthor(c.author)
      && c.publishedAt && Number.isFinite(Date.parse(c.publishedAt)) && Date.parse(c.publishedAt) <= postAt.getTime());
    if (!inputs.length) break;
    inputs.forEach((c) => seen.add(c.id));
    const rows = await tx<{ id: string; author: string; text: string; published_at: Date; raw: { context?: ContextInput[] } | null }[]>`
      SELECT id, author, text, published_at, raw FROM monitor_posts WHERE monitor_id=${monitorId()} AND id=ANY(${inputs.map((c) => c.id)}::text[])`;
    frontier = [];
    for (const row of rows) {
      const input = inputs.find((c) => c.id === row.id)!;
      if (!isAuthor(row.author) || row.author.toLowerCase() !== input.author.replace(/^@/, "").toLowerCase() || row.text !== input.text
        || row.published_at.getTime() !== Date.parse(input.publishedAt!) || row.published_at > postAt) continue;
      verified.push(row.id);
      frontier.push(...(row.raw?.context ?? []).filter((c) => c.publishedAt && Date.parse(c.publishedAt) <= row.published_at.getTime()));
    }
  }
  if (!verified.length) return [];
  return tx<Array<{ id: string; type: Proposition["kind"] }>>`
    SELECT DISTINCT e.id, e.type FROM monitor_events e JOIN monitor_event_posts l ON l.monitor_id=e.monitor_id AND l.event_id=e.id
    WHERE e.monitor_id=${monitorId()} AND NOT e.withdrawn AND e.created_at<=${postAt}
      AND e.type IN ('bonus_credit','reset_credit') AND l.post_id=ANY(${verified}::text[])`;
}
