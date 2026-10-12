import { createMonitorServer } from "@aihot/reset-monitor/server";
import { backendDefinition } from "./backend-definition.ts";
export default createMonitorServer(backendDefinition);
