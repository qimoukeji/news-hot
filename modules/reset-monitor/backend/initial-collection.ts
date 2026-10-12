import { z } from "zod";
import { randomUUID } from "node:crypto";
import { monitor } from "./context.ts";
import { collectorName } from "../config.ts";

// Provider accounts and credentials deliberately do not belong to this identity.
export const initialCollectionKey = () => `initial:${collectorName()}`;
export const InitialCollection = z.object({
  version: z.literal(1),
  queries: z.array(z.string()).nonempty(),
  filterVersion: z.string().nullable(),
  queryIndex: z.number().int().nonnegative(),
  cursor: z.string().min(1).nullable(),
  visitedCursors: z.array(z.string().min(1)),
  pageWindow: z.uuid(),
  processingWindow: z.uuid().optional(),
}).refine(s => s.queryIndex <= s.queries.length
  && (s.queryIndex < s.queries.length || s.cursor === null && s.visitedCursors.length === 0)
  && (s.cursor === null ? s.visitedCursors.length === 0 : s.visitedCursors.at(-1) === s.cursor)
  && new Set(s.visitedCursors).size === s.visitedCursors.length, "Invalid initialization page progress");
export type InitialCollection = z.infer<typeof InitialCollection>;

export function collectionQueries(since: number, until: number, supplemental = false): string[] {
  const selected = supplemental ? monitor().collectionFilter?.supplementalQueries ?? [] : monitor().collectionFilter?.query ?? "";
  const filters = typeof selected === "string" ? [selected] : selected;
  return monitor().authors.flatMap(({ handle }) => filters.map(filter =>
    `from:${handle.toLowerCase()}${filter ? ` ${filter}` : ""} since_time:${Math.floor(since / 1000)} until_time:${Math.floor(until / 1000)}`));
}

export function initialCollection(queries: string[], saved: unknown, supplementalQueries: string[] = []): InitialCollection {
  const filterVersion = monitor().collectionFilter?.version ?? null;
  const completeQueries = [...queries, ...supplementalQueries];
  if (saved == null) return { version: 1, queries: completeQueries, filterVersion, queryIndex: 0, cursor: null, visitedCursors: [], pageWindow: randomUUID(), processingWindow: randomUUID() };
  const progress = InitialCollection.parse(saved);
  // The real first run used narrower queries. Append only the explicitly declared missing scope,
  // preserving the unfinished original query and cursor; later changes remain a hard error.
  if (![queries, completeQueries].some(expected => JSON.stringify(progress.queries) === JSON.stringify(expected)) || progress.filterVersion !== filterVersion) {
    throw new Error("Initialization has saved progress for a different range, authors or collection filter; repeat the original range and configuration");
  }
  return { ...progress, queries: completeQueries, processingWindow: progress.processingWindow ?? randomUUID() };
}

export function advanceInitialCollection(progress: InitialCollection, nextCursor: string | null): InitialCollection {
  nextCursor = nextCursor || null;
  if (nextCursor && progress.visitedCursors.includes(nextCursor)) {
    throw new Error("Collection returned a repeated page cursor; coverage remains incomplete");
  }
  return { ...progress, queryIndex: progress.queryIndex + (nextCursor ? 0 : 1), cursor: nextCursor,
    visitedCursors: nextCursor ? [...progress.visitedCursors, nextCursor] : [], pageWindow: randomUUID() };
}
