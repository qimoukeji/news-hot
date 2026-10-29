import { monitor } from "../backend/context.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { modulePublication } from "@aihot/backend/publication/modules";
import { publicHandler } from "@aihot/api/routes/v1";
import { adminHandler } from "@aihot/api/routes/admin-auth";
import {
  sendJsonWithEtag,
  sendProblem,
  strictQuery,
  QueryError,
} from "@aihot/api/http/respond";
import { actorOf } from "@aihot/backend/admin/auth";
import * as admin from "../backend/admin.ts";
import { publicV2Path } from "../definition.ts";
import { parsePublicV2Query, PublicV2QueryError } from "../backend/public-v2-list.ts";

const read = (view: string, input: Record<string, unknown> = {}) =>
  modulePublication(monitor().moduleName, view, input);
function adminQuery(req: FastifyRequest, allowed: readonly string[]) {
  try { return strictQuery(req, allowed); }
  catch (error) {
    if (error instanceof QueryError) throw Object.assign(error, { statusCode: 400 });
    throw error;
  }
}
const param = (req: FastifyRequest) => (req.params as { id: string }).id;
const body = (req: FastifyRequest) => (req.body ?? {}) as never;
const found = (req: FastifyRequest, reply: FastifyReply, value: unknown) =>
  value ??
  sendProblem(req, reply, {
    status: 404,
    code: "not_found",
    detail: "monitor record not found",
  });

export function registerHttp(app: FastifyInstance) {
  app.get(monitor().adminApiPath + "/entries", adminHandler(async req => {
    const q = adminQuery(req, ["q", "page", "type", "status", "visibility", "filter", "kind", "collectionFilter", "from", "to"]);
    return admin.listMonitorEntries({ ...q, page: Number(q.page) || 1 });
  }));
  if (monitor().publicV2) app.get(publicV2Path(monitor()), publicHandler(async (req, reply) => {
    try {
      const query = parsePublicV2Query(strictQuery(req, ["from", "to", "timeZone", "limit", "cursor"]));
      const list = await read("eventsV2", { ...query });
      return sendJsonWithEtag(req, reply, list as object, {
        etagPrefix: `${monitor().monitorId}-actions-v2.3`, etagOf: { query, list },
        cacheControl: "public, max-age=60, s-maxage=60, must-revalidate",
      });
    } catch (error) {
      if (error instanceof PublicV2QueryError) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: error.message });
      throw error;
    }
  }));
  app.post(
    monitor().adminApiPath + "/events",
    adminHandler(async (req, reply, who) => {
      const event = await admin.createMonitorEvent(body(req), actorOf(who));
      return reply.code(201).send(event);
    }),
  );
  app.get(
    monitor().adminApiPath + "/posts",
    adminHandler(async (req) => {
      const q = adminQuery(req, ["q", "page", "filter", "collectionFilter", "association", "from", "to"]);
      return admin.listMonitorPosts({
        filter: q.filter, q: q.q, collectionFilter: q.collectionFilter, association: q.association, from: q.from, to: q.to,
        page: Number(q.page) || 1,
      });
    }),
  );
  app.post(monitor().adminApiPath + "/posts", adminHandler(async (req, reply, who) => {
    const post = await admin.createMonitorPost(body(req), actorOf(who));
    return reply.code(201).send(post);
  }));
  app.patch(monitor().adminApiPath + "/posts/:id", adminHandler(async (req, reply, who) =>
    found(req, reply, await admin.updateMonitorPost(param(req), body(req), actorOf(who)))));
  app.patch(
    monitor().adminApiPath + "/events/:id",
    adminHandler(async (req, reply, who) =>
      found(
        req,
        reply,
        await admin.updateMonitorEvent(param(req), body(req), actorOf(who)),
      ),
    ),
  );
  app.post(
    monitor().adminApiPath + "/events/:id/preview",
    adminHandler(async (req, reply) =>
      found(req, reply, await admin.previewMonitorEvent(param(req), body(req))),
    ),
  );
  app.post(
    monitor().adminApiPath + "/events/:id/withdrawn",
    adminHandler(async (req, reply, who) =>
      found(
        req,
        reply,
        await admin.setWithdrawn(param(req), body(req), actorOf(who)),
      ),
    ),
  );
  app.get(monitor().adminApiPath + "/events/:id/review", adminHandler(async (req, reply) =>
    found(req, reply, await admin.monitorEventDetail(param(req)))));
  app.post(monitor().adminApiPath + "/events/:id/review/preview", adminHandler(async (req, reply) =>
    found(req, reply, await admin.previewMonitorEventReview(param(req), body(req)))));
  app.post(monitor().adminApiPath + "/events/:id/review", adminHandler(async (req, reply, who) =>
    found(req, reply, await admin.submitMonitorEventReview(param(req), body(req), actorOf(who)))));
  app.get(
    monitor().adminApiPath + "/posts/:id",
    adminHandler(async (req, reply) =>
      found(req, reply, await admin.monitorPostDetail(param(req))),
    ),
  );
  app.post(
    monitor().adminApiPath + "/posts/:id/review/preview",
    adminHandler(async (req, reply) =>
      found(
        req,
        reply,
        await admin.previewMonitorReview(param(req), body(req)),
      ),
    ),
  );
  app.post(
    monitor().adminApiPath + "/posts/:id/review",
    adminHandler(async (req, reply, who) =>
      found(
        req,
        reply,
        await admin.submitMonitorReview(param(req), body(req), actorOf(who)),
      ),
    ),
  );
}
