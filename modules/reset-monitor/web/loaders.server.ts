import { edgeTtl, loadOr404 } from "@aihot/web/lib/api.server";
import { adminGet } from "@aihot/web/lib/admin.server";
import { beijingDate } from "@aihot/contracts/time";
import type { AdminEntries, AdminPosts, AdminEventDetail } from "./admin-types.ts";
import type { EventList, Overview, PlatformOverview } from "../public-v2.ts";
import { publicV2Path, type ResetMonitorWebDefinition } from "../definition.ts";

export type ResetMonitorPageData = { overview: PlatformOverview; events: EventList["list"]; selectedDate: string | null; month: string; today: string };

export function createPublicLoader(profile: ResetMonitorWebDefinition) {
  return async ({ request, params }: { request: Request; params: { date?: string } }): Promise<ResetMonitorPageData> => {
    const url = new URL(request.url);
    const today = beijingDate(new Date().toISOString());
    const selectedDate = params.date ?? null;
    const month = selectedDate?.slice(0, 7) ?? url.searchParams.get("month") ?? today.slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || selectedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate) || !Number.isFinite(Date.parse(selectedDate)) || new Date(selectedDate).toISOString().slice(0, 10) !== selectedDate)) {
      throw new Response("日期无效", { status: 404 });
    }
    const [year, number] = month.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
    const query = new URLSearchParams({ from: `${month}-01`, to: last, timeZone: "Asia/Shanghai" });
    const [all, list] = await Promise.all([
      loadOr404<Overview>("/api/v2/overview", { signal: request.signal }),
      loadOr404<EventList>(`${publicV2Path(profile)}?${query}`, { signal: request.signal }),
    ]);
    const overview = all.platforms.find(platform => platform.platform === profile.publicV2?.platform);
    if (!overview) throw new Response("监控不存在", { status: 404 });
    return { overview, events: list.list, selectedDate, month, today };
  };
}

export const publicHeaders = () => edgeTtl(30);

export type ResetMonitorAdminData = AdminEntries;

export function createAdminLoader(profile: ResetMonitorWebDefinition) {
  return async ({ request }: { request: Request }): Promise<ResetMonitorAdminData> => {
    const url = new URL(request.url);
    const query = new URLSearchParams({ page: url.searchParams.get("page") ?? "1" });
    const posts = url.searchParams.get("kind") === "posts";
    for (const name of ["from", "to"]) if (url.searchParams.get(name)) query.set(name, url.searchParams.get(name)!);
    if (posts) {
      for (const name of ["association", "collectionFilter"]) if (url.searchParams.get(name)) query.set(name, url.searchParams.get(name)!);
      const result = await adminGet<AdminPosts>(request, `${profile.adminApiPath}/posts?${query}`);
      return { ...result, rows: result.rows.map(post => ({ kind: "post", post, latestAt: post.publishedAt })) };
    }
    query.set("kind", "events");
    return adminGet<AdminEntries>(request, `${profile.adminApiPath}/entries?${query}`);
  };
}

export function createEventLoader(profile: ResetMonitorWebDefinition) {
  return ({ request, params }: { request: Request; params: { id?: string } }): Promise<AdminEventDetail> =>
    adminGet<AdminEventDetail>(request, `${profile.adminApiPath}/events/${encodeURIComponent(params.id ?? "")}/review`);
}
