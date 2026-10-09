// Collection adapters share the post shape used by recognition and stored context.
import * as socialdata from "@aihot/backend/providers/socialdata";
import * as twitterapi from "./twitterapi.ts";
import { collectorName } from "../../config.ts";

export type Tweet = socialdata.SdTweet;
export type SearchOptions = Parameters<typeof socialdata.searchTweets>[1];
export type LookupOptions = Parameters<typeof socialdata.getTweet>[1];
export interface Collector {
  searchTweets(query: string, options: SearchOptions): Promise<socialdata.SearchResult>;
  getTweet(id: string, options: LookupOptions): Promise<Tweet | null>;
}
const collectors: Record<string, Collector> = { socialdata, twitterapi_io: twitterapi };
function current(): Collector {
  if (process.env.COLLECT_ENABLED !== "true") throw new Error("COLLECT_ENABLED is disabled");
  const name = collectorName();
  const collector = collectors[name];
  if (!collector) throw new Error(`Unknown CODEX_RESET_PROVIDER: ${name}`);
  return collector;
}
export const searchTweets = (query: string, options: SearchOptions) => current().searchTweets(query, options);
export const getTweet = (id: string, options: LookupOptions) => current().getTweet(id, options);
export const tweetText = socialdata.tweetText;
