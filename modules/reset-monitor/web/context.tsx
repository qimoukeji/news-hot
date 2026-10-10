import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { ResetMonitorWebDefinition } from "../definition.ts";
import type { ResetMonitorSitePage } from "../contracts.ts";

export interface ResetMonitorWebProfile extends ResetMonitorWebDefinition {
  timingHelp?: ComponentType<{ data: ResetMonitorSitePage }>;
}

const MonitorContext = createContext<ResetMonitorWebProfile | null>(null);

export function MonitorProvider({ profile, children }: { profile: ResetMonitorWebProfile; children: ReactNode }) {
  return <MonitorContext.Provider value={profile}>{children}</MonitorContext.Provider>;
}

export function useMonitor() {
  const profile = useContext(MonitorContext);
  if (!profile) throw new Error("Reset monitor components require a MonitorProvider");
  return profile;
}
