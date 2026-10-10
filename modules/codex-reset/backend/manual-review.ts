import * as shared from "@aihot/reset-monitor/backend/manual-review";
import { bindMonitor } from "@aihot/reset-monitor/backend/context";
import { backendDefinition } from "../backend-definition.ts";
export const bumpPublication = bindMonitor(backendDefinition, shared.bumpPublication);
export const monitorPostDetail = bindMonitor(backendDefinition, shared.monitorPostDetail);
export const previewMonitorReview = bindMonitor(backendDefinition, shared.previewMonitorReview);
export const submitMonitorReview = bindMonitor(backendDefinition, shared.submitMonitorReview);
export const moveReviewedLink = bindMonitor(backendDefinition, shared.moveReviewedLink);
