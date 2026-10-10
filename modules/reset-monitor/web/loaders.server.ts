import { edgeTtl, loadOr404 } from "@aihot/web/lib/api.server";
import { adminGet } from "@aihot/web/lib/admin.server";
import type { AdminMonitorEvents, AdminMonitorPosts, AdminMonitorPostDetail, ResetMonitorDay, ResetMonitorSitePage } from "../contracts.ts";
import type { ResetMonitorWebDefinition } from "../definition.ts";

export type ResetMonitorPageData = ResetMonitorSitePage & { serverNow: number };

export function createPublicLoader(profile: ResetMonitorWebDefinition) {
  return async ({ request, params }: { request: Request; params: { date?: string } }): Promise<ResetMonitorPageData> => {
    const [data, day] = await Promise.all([
      loadOr404<ResetMonitorSitePage>(profile.siteApiPath, { signal: request.signal }),
      params.date ? loadOr404<ResetMonitorDay>(`${profile.siteApiPath}/days/${encodeURIComponent(params.date)}`, { signal: request.signal }) : null,
    ]);
    return { ...data, ...(day ? { selectedDate: day.date, events: day.events } : {}), serverNow: Date.now() };
  };
}

export const publicHeaders = () => edgeTtl(30);

export function createAdminLoader(profile: ResetMonitorWebDefinition) {
  return async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const tab = url.searchParams.get("tab") ?? "events";
    if (tab === "posts") {
      const posts = await adminGet<AdminMonitorPosts>(request, `${profile.adminApiPath}/posts?filter=${url.searchParams.get("filter") ?? "relevant"}&page=${url.searchParams.get("page") ?? 1}`);
      return { tab, posts, events: null };
    }
    const events = await adminGet<AdminMonitorEvents>(request, `${profile.adminApiPath}/events?page=${url.searchParams.get("page") ?? 1}&filter=${encodeURIComponent(url.searchParams.get("filter") ?? "all")}${url.searchParams.get("withdrawn") ? "&withdrawn=1" : ""}`);
    return { tab, posts: null, events };
  };
}

export type ResetMonitorAdminData = Awaited<ReturnType<ReturnType<typeof createAdminLoader>>>;

export function createReviewLoader(profile: ResetMonitorWebDefinition) {
  return ({ request, params }: { request: Request; params: { id?: string } }) =>
    adminGet<AdminMonitorPostDetail>(request, `${profile.adminApiPath}/posts/${encodeURIComponent(params.id ?? "")}`);
}
