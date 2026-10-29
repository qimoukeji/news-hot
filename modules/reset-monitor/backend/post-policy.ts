import { tweetText, type Tweet } from "./providers/collectors.ts";
import type { ContextInput } from "./recognize.ts";
import { validateCollectionConfig, type ResetMonitorCollectionConfig } from "../definition.ts";

const mainPosts: ResetMonitorCollectionConfig = { includeReplies: false, includeSelfReplies: false, resetOnly: false, keywords: [] };

export function replyTarget(post: Tweet): { postId: string | null; author: string | null } | null {
  const postId = post.in_reply_to_status_id_str || null, author = post.in_reply_to_screen_name || null;
  return post.is_reply || postId || author ? { postId, author } : null;
}

export function embeddedQuote(post: Tweet): Array<ContextInput & { relation: "quote"; url: string; replyTo?: ReturnType<typeof replyTarget> }> {
  const quote = post.quoted_status;
  if (!quote) return [];
  return [{ id: quote.id_str, author: quote.user.screen_name, relation: "quote", text: tweetText(quote),
    publishedAt: new Date(quote.tweet_created_at).toISOString(), url: `https://x.com/i/status/${quote.id_str}`, replyTo: replyTarget(quote) }];
}

export function collectionQuery(handle: string, since: number, until: number, collection: ResetMonitorCollectionConfig = mainPosts): string {
  validateCollectionConfig(collection);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error("Invalid collection author");
  const author = handle.toLowerCase();
  const replies = collection.includeReplies === collection.includeSelfReplies
    ? collection.includeReplies ? [] : ["-filter:replies"]
    : [`(-filter:replies OR ${collection.includeSelfReplies ? "" : "-"}to:${author})`];
  return [`from:${author}`, "-filter:retweets", ...replies,
    ...(collection.resetOnly ? [`(${collection.keywords.map(keyword => `"${keyword}"`).join(" OR ")})`] : []),
    `since_time:${Math.floor(since / 1000)}`, `until_time:${Math.ceil(until / 1000)}`].join(" ");
}
