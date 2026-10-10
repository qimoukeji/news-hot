import { defineModule } from "@aihot/contracts/modules";
import type { ResetMonitorWebDefinition } from "./definition.ts";

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createMonitorModule(definition: ResetMonitorWebDefinition) {
  return defineModule({
    name: definition.moduleName,
    pages: [
      { path: definition.pagePath.slice(1), file: "web/page.tsx", id: definition.moduleName },
      { path: `${definition.pagePath.slice(1)}/history/:date`, file: "web/page.tsx", id: `${definition.moduleName}-day` },
    ],
    adminPages: [
      { path: definition.adminPath.slice(1), file: "web/admin.tsx" },
      { path: `${definition.adminPath.slice(1)}/posts/:id/review`, file: "web/review.tsx" },
    ],
    apiPaths: [new RegExp(`^(?:${[definition.siteApiPath, definition.publicApiPath, definition.adminApiPath, `/api/v1/agent${definition.agentPath}`].map(escapePattern).join("|")})(?:/|$)`)],
  });
}
