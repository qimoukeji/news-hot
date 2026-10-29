import { z } from "zod";
import { credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { assertAccepted, assertRequestCanSend, canResumeDefiniteFailure, paidRequest, ProviderNotSentError, rejectReceivedResponse } from "@aihot/backend/providers/receipts";
import type { Tweet, SearchOptions, LookupOptions, LookupResult } from "./collectors.ts";
import { pacedTwitterApiRequest } from "./twitterapi-pacing.ts";

const Post = z.object({
  id: z.string().regex(/^\d+$/), text: z.string(), createdAt: z.string().refine(s => Number.isFinite(Date.parse(s))),
  author: z.object({ userName: z.string().min(1), name: z.string(), profilePicture: z.string().optional() }),
  isReply: z.boolean().optional(),
  isRetweet: z.boolean().optional(),
  inReplyToId: z.string().nullish(), inReplyToUsername: z.string().nullish(),
  entities: z.object({ urls: z.array(z.object({ url: z.string(), expanded_url: z.string() })).optional() }).optional(),
  quoted_tweet: z.unknown().optional(), retweeted_tweet: z.unknown().optional(),
  likeCount: z.number().optional(), retweetCount: z.number().optional(), replyCount: z.number().optional(),
  quoteCount: z.number().optional(), viewCount: z.number().optional(),
});
const Page = z.object({ tweets: z.array(z.unknown()), has_next_page: z.boolean().optional(), next_cursor: z.string().nullish() });

function nestedTweet(raw: unknown, depth: number): Tweet | null {
  if (!raw) return null;
  // The API can return a quoted-post placeholder with no available content or author.
  // Keep it in the raw receipt, but do not invent readable context from empty fields.
  if (typeof raw === "object") {
    const t = raw as Record<string, unknown>;
    if (t.createdAt === "" && t.text === "" && t.author && typeof t.author === "object" && Object.keys(t.author).length === 0) return null;
  }
  return normalizeTweet(raw, depth + 1);
}

export function normalizeTweet(raw: unknown, depth = 0): Tweet {
  if (depth > 8) throw new Error("TwitterAPI.io nested post limit exceeded");
  const t = Post.parse(raw);
  return {
    id_str: t.id, full_text: t.text, tweet_created_at: t.createdAt,
    user: { name: t.author.name, screen_name: t.author.userName, profile_image_url_https: t.author.profilePicture },
    is_reply: t.isReply ?? !!(t.inReplyToId || t.inReplyToUsername),
    is_retweet: t.isRetweet ?? !!t.retweeted_tweet,
    in_reply_to_status_id_str: t.inReplyToId, in_reply_to_screen_name: t.inReplyToUsername,
    entities: t.entities,
    quoted_status: nestedTweet(t.quoted_tweet, depth),
    retweeted_status: t.retweeted_tweet ? normalizeTweet(t.retweeted_tweet, depth + 1) : null,
    favorite_count: t.likeCount, retweet_count: t.retweetCount, reply_count: t.replyCount,
    quote_count: t.quoteCount, views_count: t.viewCount,
  };
}

// Apply the existing X collector's default request caps; administrator changes are retained.
export async function ensureTwitterApiBudget() {
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day)
    SELECT 'twitterapi_io', per_minute, per_hour, per_day FROM budgets WHERE service = 'socialdata'
    ON CONFLICT (service) DO NOTHING`;
  const [budget] = await sql`SELECT 1 FROM budgets WHERE service = 'twitterapi_io'`;
  if (!budget) throw new Error("Configure a twitterapi_io budget before collection");
}

async function request(path: string, opts: { purpose: string; subject: string; identity: unknown; summary: Record<string, unknown>; resume?: boolean }) {
  if (process.env.COLLECT_ENABLED !== "true") throw new ProviderNotSentError("COLLECT_ENABLED is disabled");
  const key = credential("collectors", "TWITTERAPI_IO_API_KEY");
  if (!key) throw new Error("TWITTERAPI_IO_API_KEY is not configured");
  const base = (credential("collectors", "TWITTERAPI_IO_BASE_URL") ?? "https://api.twitterapi.io").replace(/\/$/, "");
  await ensureTwitterApiBudget();
  const req = { service: "twitterapi_io", purpose: opts.purpose, subject: opts.subject,
    identity: { base, input: opts.identity }, requestSummary: opts.summary };
  const retryFailed = opts.resume === true && await canResumeDefiniteFailure(req);
  const receipt = await paidRequest({ ...req, retryFailed }, () => pacedTwitterApiRequest(async () => {
    await assertRequestCanSend("twitterapi_io");
    if (process.env.COLLECT_ENABLED !== "true") throw new ProviderNotSentError("COLLECT_ENABLED is disabled");
    const res = await guardedFetch(`${base}${path}`, { route: "egress", headers: { "X-API-Key": key, accept: "application/json" }, timeoutMs: 60_000, maxBytes: 12 * 1024 * 1024 });
    const text = res.text();
    assertAccepted("twitterapi_io", res.status, text.replaceAll(key, "[redacted]"));
    // Keep the received raw answer first; validation failures must never repurchase it.
    const response = JSON.parse(text);
    return { response, usage: { tweets: Array.isArray(response?.tweets) ? response.tweets.length : 0 }, cost: null };
  }));
  return receipt;
}

const Envelope = z.object({ status: z.string().optional(), code: z.number().optional() });
function assertSuccessful(response: unknown) {
  const envelope = Envelope.parse(response);
  if (envelope.status !== undefined && envelope.status !== "success" || envelope.code !== undefined && envelope.code !== 0) {
    throw new Error("TwitterAPI.io returned an unsuccessful response");
  }
}

export async function searchTweets(query: string, opts: SearchOptions) {
  const queryType = opts.type ?? "Latest";
  const params = new URLSearchParams({ query, queryType });
  if (opts.cursor) params.set("cursor", opts.cursor);
  const receipt = await request(`/twitter/tweet/advanced_search?${params}`, { ...opts,
    identity: { query, queryType, cursor: opts.cursor ?? null, window: opts.window }, summary: { query, queryType, cursor: opts.cursor ?? null } });
  try {
    assertSuccessful(receipt.response);
    const page = Page.parse(receipt.response);
    if (page.has_next_page && !page.next_cursor) throw new Error("TwitterAPI.io returned a page without its next cursor");
    return { tweets: page.tweets.map(t => normalizeTweet(t)), nextCursor: page.has_next_page === false ? null : page.next_cursor || null, receiptId: receipt.receiptId, reused: receipt.reused };
  } catch (error) {
    await rejectReceivedResponse(receipt.receiptId, String(error));
    throw error;
  }
}

/** Responses can omit unavailable IDs or return an empty-ID placeholder. Match by ID, never order. */
export async function lookupTweets(ids: readonly string[], opts: LookupOptions): Promise<LookupResult> {
  const sorted = [...new Set(ids)].sort();
  if (sorted.some(id => !/^\d+$/.test(id))) throw new Error("Invalid context post ID");
  const result: LookupResult = { tweets: [], missingIds: [], receiptIds: [], receiptById: {}, reused: true };
  for (let offset = 0; offset < sorted.length; offset += 50) {
    const batch = sorted.slice(offset, offset + 50), wanted = new Set(batch);
    const params = new URLSearchParams({ tweet_ids: batch.join(",") });
    const receipt = await request(`/twitter/tweets?${params}`, { ...opts,
      identity: { tweet_ids: batch }, summary: { tweet_ids: batch } });
    try {
      assertSuccessful(receipt.response);
      const page = Page.parse(receipt.response), found = new Map<string, Tweet>();
      for (const raw of page.tweets) {
        if (raw && typeof raw === "object" && "id" in raw && raw.id === "") continue;
        const tweet = normalizeTweet(raw);
        if (!wanted.has(tweet.id_str)) throw new Error("TwitterAPI.io returned an unrequested context post ID");
        if (found.has(tweet.id_str)) throw new Error("TwitterAPI.io returned a repeated context post ID");
        found.set(tweet.id_str, tweet);
      }
      for (const id of batch) {
        const tweet = found.get(id);
        if (tweet) result.tweets.push(tweet);
        else result.missingIds.push(id);
      }
    } catch (error) { await rejectReceivedResponse(receipt.receiptId, String(error)); throw error; }
    result.receiptIds.push(receipt.receiptId);
    for (const id of batch) result.receiptById[id] = receipt.receiptId;
    result.reused &&= receipt.reused;
  }
  return result;
}
