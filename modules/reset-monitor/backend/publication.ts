import { monitor as currentMonitor, monitorId, purpose as requestPurpose, auditAction, auditSubject } from "./context.ts";
import type { ResetMonitorPageData, ResetMonitorSitePage, ResetMonitorDay } from "../contracts.ts";
import { resetPage } from "./read.ts";

export function siteResetMonitorPage(page: ResetMonitorPageData, date?: string): ResetMonitorSitePage {
  const selectedDate = date ?? page.today;
  const ids = new Set(page.calendar.filter((m) => m.date === selectedDate).map((m) => m.eventId));
  const { activities: _activities, ...rest } = page;
  const activeBonuses = page.events.filter((e) => e.type === "bonus_credit" && e.presentation && ["available", "announced", "in_progress"].includes(e.presentation.status));
  return { ...rest, selectedDate, events: page.events.filter((e) => ids.has(e.id)), ...(activeBonuses.length ? { activeBonuses } : {}) };
}

export async function loadSiteResetMonitorPage(date?: string, now = Date.now()) {
  return siteResetMonitorPage(await resetPage(now), date);
}

export async function loadSiteResetMonitorDay(date: string): Promise<ResetMonitorDay> {
  const page = await loadSiteResetMonitorPage(date);
  return { date, version: page.version, events: page.events };
}
