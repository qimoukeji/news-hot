import { listMonitorEntries } from "../backend/admin.ts";

/** Read event fixtures through the same list projection as the admin UI. */
export async function listEvents(options: Parameters<typeof listMonitorEntries>[0] = {}) {
  const { rows, ...pagination } = await listMonitorEntries({ ...options, kind: "events" });
  return { ...pagination, events: rows.flatMap(row => row.kind === "event" ? [row.event] : []) };
}
