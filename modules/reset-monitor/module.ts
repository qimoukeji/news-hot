import { defineModule } from "@aihot/contracts/modules";
import type { ResetMonitorWebDefinition } from "./definition.ts";
import { publicV2Path } from "./definition.ts";

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createMonitorModule(definition: ResetMonitorWebDefinition) {
  return defineModule({
    name: definition.moduleName,
    pages: [
      { path: definition.pagePath.slice(1), file: "web/page.tsx", id: definition.moduleName },
      { path: `${definition.pagePath.slice(1)}/history/:date`, file: "web/page.tsx", id: `${definition.moduleName}-day` },
    ],
    adminPages: [
      { path: definition.adminPath.slice(1), file: "web/admin.tsx", id: `${definition.moduleName}-admin-events` },
      { path: `${definition.adminPath.slice(1)}/events/:id`, file: "web/event.tsx" },
    ],
    apiPaths: [new RegExp(`^(?:${[publicV2Path(definition), definition.adminApiPath, `/api/v2/agent${definition.agentPath}`].map(escapePattern).join("|")})(?:/|$)`)],
  });
}
