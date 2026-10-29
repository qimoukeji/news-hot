import { loadActionInput } from "./action-store.ts";
import { projectPublicV2, publicV2EventTitle } from "./public-v2.ts";
import { monitor } from "./context.ts";
import { relatedContextEvents } from "./context-association.ts";
import { reduceEvent, type ActionInput, type SourcePostRow } from "../actions.ts";
import type { ContextInput, OpenEventInput } from "./recognize.ts";
import type { EditorialText } from "../actions.ts";

const readable = (text: EditorialText | null) => text?.en?.trim() || text?.zh?.trim() || Object.values(text ?? {}).find(value => value?.trim()) || null;

export async function openEvents(before: Date, context: ContextInput[], savedInput?: ActionInput, source?: SourcePostRow): Promise<OpenEventInput[]> {
  const input = savedInput ?? await loadActionInput();
  const officialInput = { ...input, actions: input.actions.filter(action => action.sources.length > 0) };
  const snapshot = projectPublicV2(officialInput, monitor(), before.getTime());
  const contextual = new Set(input.actions.filter(action => action.sources.some(source => context.some(post => post.id === source.postId))).map(action => action.event_id));
  if (source) for (const kind of monitor().eventKinds) for (const event of relatedContextEvents(source, input, kind)) contextual.add(event.id);
  const officialEvents = snapshot.events.map(event => {
    const row = input.events.find(row => row.id === event.id)!;
    const official = reduceEvent(row, officialInput)!;
    return { ...event, status: official.status, time: official.time,
      title: publicV2EventTitle(monitor().product, row, official.actions.at(-1)?.action, official.status) };
  });
  return officialEvents.filter(event => Date.parse(event.publishedAt) <= before.getTime()
    && (contextual.has(event.id) || event.type !== "direct_reset" || event.status !== "completed" || Date.parse(event.time.split("/")[0]!) >= before.getTime() - 48 * 3600_000))
    .sort((a, b) => Number(contextual.has(b.id)) - Number(contextual.has(a.id)) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id))
    .slice(0, 24).map(event => {
      const eventActions = officialInput.actions.filter(action => action.event_id === event.id).sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
      const sourceIds = [...new Set(eventActions.flatMap(action => action.sources.map(source => source.postId)))];
      const first = input.posts.filter(post => sourceIds.includes(post.id)).sort((a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime())[0];
      return { id: event.id, kind: event.type, status: event.status,
        publishedAt: event.publishedAt, author: first?.author, title: event.title.en, summary: event.summary?.en ?? null,
        time: event.time, scope: event.scope.note?.en ?? null, sourcePostIds: sourceIds,
        actions: eventActions.map(action => ({ id: action.id, action: action.action, invalidatesEvent: action.invalidates_event, sequence: action.sequence,
          title: readable(action.title) ?? "", summary: readable(action.summary) })) };
    });
}
