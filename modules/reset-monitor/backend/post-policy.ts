import { tweetText, type Tweet } from "./providers/collectors.ts";
import type { ContextInput } from "./recognize.ts";

/** Classify the outer post only: quoted replies do not make a quote post a reply. */
export function isMainPost(post: Tweet): boolean {
  return !post.is_reply && !post.in_reply_to_status_id_str && !post.in_reply_to_screen_name && !post.is_retweet && !post.retweeted_status;
}

export function embeddedQuote(post: Tweet): Array<ContextInput & { url: string }> {
  const quote = post.quoted_status;
  if (!quote) return [];
  return [{ id: quote.id_str, author: quote.user.screen_name, relation: "quote", text: tweetText(quote),
    publishedAt: new Date(quote.tweet_created_at).toISOString(), url: `https://x.com/i/status/${quote.id_str}` }];
}

export function collectionQuery(handle: string, since: number, until: number): string {
  return `from:${handle.toLowerCase()} -filter:replies since_time:${Math.floor(since / 1000)} until_time:${Math.ceil(until / 1000)}`;
}
