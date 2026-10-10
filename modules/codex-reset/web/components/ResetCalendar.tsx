import { ResetCalendar as SharedResetCalendar } from "../../../reset-monitor/web/components/ResetCalendar.tsx";
import { MonitorProvider } from "../../../reset-monitor/web/context.tsx";
import type { ComponentProps } from "react";
import { definition } from "../../definition.ts";

export function ResetCalendar(props: ComponentProps<typeof SharedResetCalendar>) {
  return <MonitorProvider profile={definition}><SharedResetCalendar {...props} /></MonitorProvider>;
}
