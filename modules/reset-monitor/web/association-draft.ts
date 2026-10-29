import { emptyScope, type ActionFact, type EventDraft, type ReviewCommands } from "./admin-types.ts";

export type AssociationAddition =
  | { key: string; kind: "source"; eventId: string; actionId: string; fact?: ActionFact }
  | { key: string; kind: "action"; eventId: string; fact: ActionFact }
  | { key: string; kind: "event"; event: EventDraft; fact: ActionFact };

function unique(values: string[], message: string) {
  if (new Set(values).size !== values.length) throw new Error(message);
}

/** Child dialogs stage local changes; only this command snapshot enters preview and save. */
export function buildAssociationCommands(additions: AssociationAddition[], removed: string[], postId: string): ReviewCommands {
  unique(additions.map(addition => addition.key), "关联草稿标识不能重复");
  const sourceActions = additions.filter(addition => addition.kind === "source").map(addition => addition.actionId);
  unique(sourceActions, "不能重复关联同一动作");
  unique(removed, "不能重复移除同一动作来源");
  if (sourceActions.some(id => removed.includes(id))) throw new Error("同一动作来源不能同时添加和移除");

  const commands: ReviewCommands = {
    events: { create: [], update: [] }, actions: { create: [], update: [] },
    sources: { add: [], remove: removed.map(actionId => ({ actionId, postId })) }, orders: [],
  };
  for (const addition of additions) {
    if (addition.kind === "source") {
      commands.sources.add.push({ actionId: addition.actionId, postId });
      if (addition.fact) commands.actions.update.push({ id: addition.actionId, ...structuredClone(addition.fact) });
      continue;
    }
    if (addition.kind === "event") {
      const eventKey = `event-${addition.key}`;
      commands.events.create.push({ localKey: eventKey, type: addition.event.type, title: { zh: addition.event.title.trim() },
        summary: addition.event.summary.trim() ? { zh: addition.event.summary } : null,
        ...(addition.event.scope.trim() ? { scope: { ...emptyScope(), note: { zh: addition.event.scope.trim() } } } : {}),
      });
      commands.actions.create.push({ localKey: addition.key, eventKey, ...structuredClone(addition.fact) });
    } else commands.actions.create.push({ localKey: addition.key, eventId: addition.eventId, ...structuredClone(addition.fact) });
    commands.sources.add.push({ actionKey: addition.key, postId });
  }
  return commands;
}
