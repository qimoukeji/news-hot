import { reduceEvent, type ActionInput, type EventRow, type SourcePostRow } from "../actions.ts";
import { postContext } from "./post-context.ts";

function sourceLink(value: string): string | null {
  try {
    const url = new URL(value.replace(/[),.;!?]+$/, ""));
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch { return null; }
}

/** Relations survive cancellation/withdrawal, so an unavailable target is not mistaken for a new event. */
export function relatedContextEvents(post: SourcePostRow, input: ActionInput, kind: EventRow["type"]): EventRow[] {
  const context = postContext(post, input.posts);
  const saved = new Map(input.posts.map(row => [row.id, row]));
  const ancestorIds = new Set(context.filter(row => {
    const source = saved.get(row.id);
    return source && source.text?.trim() && row.publishedAt !== null
      && source.author.replace(/^@/, "").toLowerCase() === row.author.replace(/^@/, "").toLowerCase()
      && new Date(source.published_at).getTime() === Date.parse(row.publishedAt);
  }).map(row => row.id));
  const relationTexts = [post.text ?? "", ...[...ancestorIds].map(id => saved.get(id)!.text!)];
  const links = new Set(relationTexts.flatMap(text => text.match(/https?:\/\/[^\s<>"']+/g) ?? [])
    .map(sourceLink).filter((link): link is string => link !== null));
  const before = new Date(post.published_at).getTime();
  if (!Number.isFinite(before)) return [];
  const relatedIds = new Set(input.posts.filter(source => source.id !== post.id && source.text?.trim()
    && new Date(source.published_at).getTime() <= before
    && (ancestorIds.has(source.id) || links.has(sourceLink(source.url) ?? ""))).map(source => source.id));
  return input.events.filter(event => event.type === kind
    && input.actions.some(action => action.event_id === event.id && action.sources.some(source => relatedIds.has(source.postId))))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Candidates require a source relationship, never matching authors or nearby times. */
export function contextEventCandidates(post: SourcePostRow, input: ActionInput, kind: EventRow["type"]): EventRow[] {
  const official = { ...input, actions: input.actions.filter(action => action.sources.length > 0) };
  return relatedContextEvents(post, input, kind).filter(event => {
    const state = reduceEvent(event, official);
    return !event.withdrawn && state !== null && state.status !== "cancelled";
  });
}

export function uniqueContextEvent(post: SourcePostRow, input: ActionInput, kind: EventRow["type"]): EventRow | null {
  const candidates = contextEventCandidates(post, input, kind);
  return candidates.length === 1 ? candidates[0]! : null;
}
