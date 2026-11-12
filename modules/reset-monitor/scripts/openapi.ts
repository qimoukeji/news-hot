import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { eventListSchema, overviewSchema } from "../public-v2.ts";
import { RESET_MONITORS } from "@aihot/site/reset-monitors";
import { SITE } from "@aihot/site";

const response = (name: string) => ({
  description: "Successful response",
  content: {
    "application/json": { schema: { $ref: `#/components/schemas/${name}` } },
  },
});
export function monitorOpenApi() {
  const paths: Record<string, unknown> = {
    "/api/v2/overview": {
      get: {
        summary: "Quota monitor overview",
        description: "resetTime and predictedResetTime are UTC ISO timestamps or null. When hasAnnouncement is true, announcedResetTime is the active announcement's saved BusinessTime; otherwise it is null. Inferred confirmations use the saved instant, deadline or range end as an instant. Expired predictions retain their original timestamp.",
        responses: { "200": response("Overview") },
      },
    },
  };
  for (const id of Object.keys(RESET_MONITORS))
    paths[`/api/v2/${id}-resets`] = {
      get: {
        summary: `${id} events with accepted actions and all source links`,
        description:
              "Activity history includes announcements, confirmations, progress and amendments, with their available source links. Event and action time are required saved values: instant {at}, range {from,through}, or deadline {at}. Business timestamps use UTC; publishedAt separately records source publication or source-free action creation. Individual quota status remains subject to the account display.",
        parameters: [
          {
            name: "from",
            in: "query",
            schema: { type: "string", format: "date" },
            description:
              "Inclusive local start date; default start of selected month.",
          },
          {
            name: "to",
            in: "query",
            schema: { type: "string", format: "date" },
            description:
              "Inclusive local end date; at most six calendar months.",
          },
          {
            name: "timeZone",
            in: "query",
            schema: { type: "string", default: "UTC" },
            description: "IANA time zone; the site uses Asia/Shanghai.",
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100 },
            description: "Omit to return all events in range.",
          },
          {
            name: "cursor",
            in: "query",
            schema: { type: "string" },
            description:
              "Opaque cursor bound to platform, dates, time zone and limit.",
          },
        ],
        responses: {
          "200": response("EventList"),
          "304": { description: "Unchanged ETag" },
          "400": { description: "Invalid query" },
          "503": { description: "Publication unavailable" },
        },
      },
    };
  for (const id of Object.keys(RESET_MONITORS))
    paths[`/api/v2/agent/${id}-resets`] = {
      get: {
        summary: `${id} quota events for agents`,
        responses: {
          "200": {
            description:
              "Read-only answer derived from the same v2 events and actions",
            content: { "text/markdown": { schema: { type: "string" } } },
          },
        },
      },
    };
  const jsonSchema = (schema: z.ZodType) => {
    const { $schema: _, ...value } = z.toJSONSchema(schema);
    return value;
  };
  return {
    openapi: "3.1.0",
    info: { title: `${SITE.name} quota monitor API`, version: "2" },
    paths,
    components: {
      schemas: {
        EventList: jsonSchema(eventListSchema),
        Overview: jsonSchema(overviewSchema),
      },
    },
  };
}
if (import.meta.main)
  await writeFile(
    new URL("../../../site/public/openapi-v2.json", import.meta.url),
    JSON.stringify(monitorOpenApi(), null, 2) + "\n",
  );
