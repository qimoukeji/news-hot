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

const read = (view: string, input: Record<string, unknown> = {}) =>
  modulePublication("codex-reset", view, input);
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
  app.get(
    "/api/site/codex-reset",
    siteHandler(async (req, reply) =>
      sendJsonWithEtag(req, reply, await read("page"), {
        etagPrefix: "codex-page",
        cacheControl: "public, max-age=30, s-maxage=30",
      }),
    ),
  );
  app.get(
    "/api/site/codex-reset/version",
    siteHandler(async (req, reply) =>
      sendJsonWithEtag(req, reply, await read("version"), {
        etagPrefix: "codex-version",
        cacheControl: "public, max-age=0, s-maxage=15",
      }),
    ),
  );
  app.get(
    "/api/site/codex-reset/days/:date",
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
        etagPrefix: "codex-day",
        cacheControl: "no-store",
      });
    }),
  );
  for (const [path, view] of [
    ["/api/v1/codex-resets", "snapshot"],
    ["/api/v1/codex-resets/recent", "recent"],
  ]) {
    app.get(
      path!,
      publicHandler(async (req, reply) => {
        strictQuery(req, []);
        if (view === "snapshot")
          reply.header(
            "Link",
            `<${siteUrl("/api/v1/codex-resets/recent")}>; rel="alternate"; type="application/json"`,
          );
        return sendJsonWithEtag(req, reply, await read(view!), {
          etagPrefix: `codex-${view}`,
          cacheControl: "public, max-age=60, s-maxage=60, must-revalidate",
        });
      }),
    );
  }
  app.get(
    "/api/admin/monitor/events",
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
    "/api/admin/monitor/events/options",
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
    "/api/admin/monitor/posts",
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
    "/api/admin/monitor/events/:id",
    adminHandler(async (req, reply, who) =>
      found(
        req,
        reply,
        await admin.updateMonitorEvent(param(req), body(req), actorOf(who)),
      ),
    ),
  );
  app.post(
    "/api/admin/monitor/events/:id/receipt-review",
    adminHandler(async (req, reply, who) =>
      found(
        req,
        reply,
        await admin.reviewReceipt(param(req), body(req), actorOf(who)),
      ),
    ),
  );
  app.post(
    "/api/admin/monitor/events/:id/withdrawn",
    adminHandler(async (req, reply, who) =>
      found(
        req,
        reply,
        await admin.setWithdrawn(param(req), body(req), actorOf(who)),
      ),
    ),
  );
  app.post(
    "/api/admin/monitor/relink",
    adminHandler(async (req, _reply, who) =>
      admin.relinkPost(body(req), actorOf(who)),
    ),
  );
  app.get(
    "/api/admin/monitor/posts/:id",
    adminHandler(async (req, reply) =>
      found(req, reply, await admin.monitorPostDetail(param(req))),
    ),
  );
  app.post(
    "/api/admin/monitor/posts/:id/review/preview",
    adminHandler(async (req, reply) =>
      found(
        req,
        reply,
        await admin.previewMonitorReview(param(req), body(req)),
      ),
    ),
  );
  app.post(
    "/api/admin/monitor/posts/:id/review",
    adminHandler(async (req, reply, who) =>
      found(
        req,
        reply,
        await admin.submitMonitorReview(param(req), body(req), actorOf(who)),
      ),
    ),
  );
}
