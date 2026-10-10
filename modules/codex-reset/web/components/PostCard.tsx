import { PostCard as SharedPostCard } from "../../../reset-monitor/web/components/PostCard.tsx";
import { MonitorProvider } from "../../../reset-monitor/web/context.tsx";
import type { ComponentProps } from "react";
import { definition } from "../../definition.ts";
export type { CardPost } from "../../../reset-monitor/web/components/PostCard.tsx";

export function PostCard(props: ComponentProps<typeof SharedPostCard>) {
  return <MonitorProvider profile={definition}><SharedPostCard {...props} /></MonitorProvider>;
}
