import { createAdminLoader } from "@aihot/reset-monitor/web/loaders.server";
import { createAdminPage } from "@aihot/reset-monitor/web/admin";
import { definition } from "../definition.ts";
const route = createAdminPage(definition);
export const loader = createAdminLoader(definition);
export const { meta } = route;
export default route.default;
