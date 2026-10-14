import { monitor } from "../backend/context.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { modulePublication } from "@aihot/backend/publication/modules";
import { siteUrl } from "@aihot/backend/publication/links";
import { publicHandler } from "@aihot/api/routes/v1";
import { siteHandler } from "@aihot/api/routes/site";
import { adminHandler } from "@aihot/api/routes/admin-auth";
import {
  sendJsonWithEtag,
  sendProblem,
  strictQuery,
} from "@aihot/api/http/respond";
import { actorOf } from "@aihot/backend/admin/auth";
import * as admin from "../backend/admin.ts";
import { publicV2Path } from "../definition.ts";
import type { ResetSnapshot } from "../public-v2.ts";

const read = (view: string, input: Record<string, unknown> = {}) =>
  modulePublication(monitor().moduleName, view, input);
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
  if (monitor().publicV2) app.get(publicV2Path(monitor()), publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const snapshot = await read("snapshotV2") as ResetSnapshot;
    const { generatedAt: _generatedAt, ...content } = snapshot;
    return sendJsonWithEtag(req, reply, snapshot, {
      etagPrefix: `${monitor().monitorId}-v2`, etagOf: content,
      cacheControl: "public, max-age=60, s-maxage=60, must-revalidate",
    });
  }));
  app.get(
    monitor().siteApiPath,
    siteHandler(async (req, reply) =>
      sendJsonWithEtag(req, reply, await read("page"), {
        etagPrefix: `${monitor().monitorId}-page`,
        cacheControl: "public, max-age=30, s-maxage=30",
      }),
    ),
  );
  app.get(
    monitor().siteApiPath + "/version",
    siteHandler(async (req, reply) =>
      sendJsonWithEtag(req, reply, await read("version"), {
        etagPrefix: `${monitor().monitorId}-version`,
        cacheControl: "public, max-age=0, s-maxage=15",
      }),
    ),
  );
  app.get(
    monitor().siteApiPath + "/days/:date",
    siteHandler(async (req, reply) => {
      const { date } = req.params as { date: string };
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date
      )
        return sendProblem(req, reply, {
          status: 404,
          code: "not_found",
          detail: "date not found",
        });
      return sendJsonWithEtag(req, reply, await read("day", { date }), {
        etagPrefix: `${monitor().monitorId}-day`,
        cacheControl: "no-store",
      });
    }),
  );
  for (const [path, view] of [
    [monitor().publicApiPath, "snapshot"],
    [monitor().publicApiPath + "/recent", "recent"],
  ]) {
    app.get(
      path!,
      publicHandler(async (req, reply) => {
        strictQuery(req, []);
        if (view === "snapshot")
          reply.header(
            "Link",
            `<${siteUrl(monitor().publicApiPath + "/recent")}>; rel="alternate"; type="application/json"`,
          );
        return sendJsonWithEtag(req, reply, await read(view!), {
          etagPrefix: `${monitor().monitorId}-${view}`,
          cacheControl: "public, max-age=60, s-maxage=60, must-revalidate",
        });
      }),
    );
  }
  app.get(
    monitor().adminApiPath + "/events",
    adminHandler(async (req) => {
      const q = req.query as { withdrawn?: string; page?: string; filter?: "all" | "receipt_review" };
      return admin.listMonitorEvents({
        withdrawn: q.withdrawn === "1",
        filter: q.filter,
        page: Number(q.page) || 1,
      });
    }),
  );
  app.get(
    monitor().adminApiPath + "/events/options",
    adminHandler(async (req) => {
      const q = req.query as { q?: string; page?: string };
      return admin.listMonitorEvents({
        q: q.q,
        page: Number(q.page) || 1,
        options: true,
      });
    }),
  );
  app.get(
    monitor().adminApiPath + "/posts",
    adminHandler(async (req) => {
      const q = req.query as {
        filter?: "relevant" | "unrelated" | "review" | "pending" | "all";
        page?: string;
      };
      return admin.listMonitorPosts({
        filter: q.filter,
        page: Number(q.page) || 1,
      });
    }),
  );
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
    monitor().adminApiPath + "/events/:id/receipt-review",
    adminHandler(async (req, reply, who) =>
      found(
        req,
        reply,
        await admin.reviewReceipt(param(req), body(req), actorOf(who)),
      ),
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
  app.post(
    monitor().adminApiPath + "/relink",
    adminHandler(async (req, _reply, who) =>
      admin.relinkPost(body(req), actorOf(who)),
    ),
  );
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
