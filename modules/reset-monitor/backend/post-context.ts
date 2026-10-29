import type { SourcePostRow } from "../actions.ts";
import type { ContextInput } from "./recognize.ts";

const authorKey = (author: string) => author.replace(/^@/, "").toLowerCase();
const timestamp = (value: Date | string) => new Date(value).getTime();

/** Follow only saved reply/quote edges; every ancestor must predate its child. */
export function postContext(post: SourcePostRow, posts: SourcePostRow[]): ContextInput[] {
  const context: ContextInput[] = [], saved = new Map(posts.map(row => [row.id, row]));
  const visited = new Set([post.id]), pending = [post];
  for (let index = 0; index < pending.length; index++) {
    const child = pending[index]!, before = timestamp(child.published_at);
    if (!Number.isFinite(before)) continue;
    const quote = child.quoted_post;
    if (quote && !visited.has(quote.id) && quote.text.trim()) {
      const parent = saved.get(quote.id), quotedAt = quote.publishedAt === null ? null : timestamp(quote.publishedAt);
      const savedAt = parent ? timestamp(parent.published_at) : null;
      const valid = (quotedAt === null || Number.isFinite(quotedAt) && quotedAt <= before)
        && (!parent || authorKey(parent.author) === authorKey(quote.author)
          && savedAt !== null && Number.isFinite(savedAt) && savedAt <= before
          && (quotedAt === null || quotedAt === savedAt));
      if (valid) {
        visited.add(quote.id);
        const text = parent?.text?.trim() ? parent.text : quote.text;
        context.push({ id: quote.id, author: parent?.author ?? quote.author, relation: "quote", text,
          publishedAt: savedAt === null ? quote.publishedAt : new Date(savedAt).toISOString() });
        if (parent?.text?.trim()) pending.push(parent);
        else if (quote.replyTo && quote.publishedAt) pending.push({ ...child, id: quote.id, author: quote.author,
          text: quote.text, published_at: quote.publishedAt, quoted_post: null, reply_to: quote.replyTo });
      }
    }
    const target = child.reply_to, parent = target?.postId ? saved.get(target.postId) : undefined;
    if (parent?.text?.trim() && !visited.has(parent.id)
      && (!target!.author || authorKey(target!.author) === authorKey(parent.author))
      && Number.isFinite(timestamp(parent.published_at)) && timestamp(parent.published_at) <= before) {
      visited.add(parent.id);
      context.push({ id: parent.id, author: parent.author, relation: "reply", text: parent.text, publishedAt: new Date(parent.published_at).toISOString() });
      pending.push(parent);
    }
  }
  return context;
}

/** Bare answers cannot identify a quota event without their saved parent or quotation. */
export function needsReplyContext(post: SourcePostRow, context: ContextInput[]): boolean {
  return post.reply_to !== null && context.length === 0
    && /^(?:@\w+\s+)*(?:yes|yep|yeah|indeed|ok(?:ay)?(?:[, ]+fine)?|of course|will do|all done|done|100%|是的|好的|完成了|已完成)[.!！。\s]*$/i.test(post.text?.trim() ?? "");
}
