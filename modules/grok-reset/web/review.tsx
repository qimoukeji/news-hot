import { createReviewLoader } from "@aihot/reset-monitor/web/loaders.server";
import { createReviewPage } from "@aihot/reset-monitor/web/review";
import { definition } from "../definition.ts";
const route = createReviewPage(definition);
export const loader = createReviewLoader(definition);
export default route.default;
