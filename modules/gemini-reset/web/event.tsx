import { createEventLoader } from "@aihot/reset-monitor/web/loaders.server";
import { createEventPage } from "@aihot/reset-monitor/web/admin";
import { definition } from "../definition.ts";

const route = createEventPage(definition);
export const loader = createEventLoader(definition);
export const { meta } = route;
export default route.default;
