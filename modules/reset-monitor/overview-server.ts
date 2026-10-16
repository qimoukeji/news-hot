import { defineServerModule } from "@aihot/backend/modules";
import { modulePublication } from "@aihot/backend/publication/modules";
import { publicHandler } from "@aihot/api/routes/v1";
import { sendJsonWithEtag, strictQuery } from "@aihot/api/http/respond";
import type { ResetMonitorBackendDefinition } from "./backend/context.ts";
import { overviewSchema, type PlatformOverview, type Overview } from "./public-v2.ts";
import { overviewModule } from "./overview-module.ts";

/** Site composition owns the installed monitor list; the shared engine does not import its peers. */
export function createOverviewServer(definitions: readonly ResetMonitorBackendDefinition[]) {
  return defineServerModule({
    name: overviewModule.name,
    publications: {
      overview: async () => {
        const now = Date.now();
        const platforms = await Promise.all(definitions.filter(definition => definition.publicV2).map(definition =>
          modulePublication<PlatformOverview>(definition.moduleName, "overviewV2", { now })));
        return overviewSchema.parse({ schemaVersion: 2, generatedAt: new Date(now).toISOString(), platforms });
      },
    },
    http: app => {
      app.get("/api/v2/overview", publicHandler(async (req, reply) => {
        strictQuery(req, []);
        const result = await modulePublication<Overview>(overviewModule.name, "overview");
        const { generatedAt: _generated, ...content } = result;
        return sendJsonWithEtag(req, reply, result, {
          etagPrefix: "reset-overview-v2", etagOf: content,
          cacheControl: "public, max-age=60, s-maxage=60, must-revalidate",
        });
      }));
    },
  });
}
