import * as shared from "@aihot/reset-monitor/backend/providers/twitterapi";
import { bindMonitor } from "@aihot/reset-monitor/backend/context";
import { backendDefinition } from "../../backend-definition.ts";
export const normalizeTweet = bindMonitor(backendDefinition, shared.normalizeTweet);
export const ensureTwitterApiBudget = bindMonitor(backendDefinition, shared.ensureTwitterApiBudget);
export const searchTweets = bindMonitor(backendDefinition, shared.searchTweets);
export const getTweet = bindMonitor(backendDefinition, shared.getTweet);
