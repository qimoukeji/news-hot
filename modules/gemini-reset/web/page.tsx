import { createPublicLoader, publicHeaders } from "@aihot/reset-monitor/web/loaders.server";
import { createPublicPage } from "@aihot/reset-monitor/web/page";
import { definition } from "../definition.ts";

const route = createPublicPage(definition);
export const loader = createPublicLoader(definition);
export const headers = publicHeaders;
export const { handle, meta } = route;
export default route.default;
