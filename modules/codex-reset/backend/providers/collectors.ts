import * as shared from "@aihot/reset-monitor/backend/providers/collectors";
import { bindMonitor } from "@aihot/reset-monitor/backend/context";
import { backendDefinition } from "../../backend-definition.ts";
export const searchTweets = bindMonitor(backendDefinition, shared.searchTweets);
export const tweetText = bindMonitor(backendDefinition, shared.tweetText);
export type { Tweet, SearchOptions, Collector } from "@aihot/reset-monitor/backend/providers/collectors";
