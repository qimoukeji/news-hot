import { monitor as currentMonitor } from "../context.ts";
// Collection adapters share the post shape used by recognition and stored context.
import * as socialdata from "@aihot/backend/providers/socialdata";
import * as twitterapi from "./twitterapi.ts";
import { collectorName } from "../../config.ts";

export type Tweet = socialdata.SdTweet;
export type SearchOptions = Parameters<typeof socialdata.searchTweets>[1];
export interface Collector {
  searchTweets(query: string, options: SearchOptions): Promise<socialdata.SearchResult>;
}
const collectors: Record<string, Collector> = { socialdata, twitterapi_io: twitterapi };
function current(): Collector {
  if (process.env.COLLECT_ENABLED !== "true") throw new Error("COLLECT_ENABLED is disabled");
  const name = collectorName();
  const collector = collectors[name];
  if (!collector) throw new Error(`Unknown ${currentMonitor().providerEnv}: ${name}`);
  return collector;
}
export const searchTweets = (query: string, options: SearchOptions) => current().searchTweets(query, options);
export const tweetText = socialdata.tweetText;
