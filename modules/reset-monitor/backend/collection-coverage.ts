import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { monitor, monitorId, type ResetMonitorBackendDefinition } from "./context.ts";
import { buildCollectionFilter } from "../collection-filter.ts";
import { collectorName } from "../config.ts";

const Timestamp = z.iso.datetime();
const Words = z.array(z.string()).readonly();
const Configuration = z.object({
  mode: z.enum(["all", "announcements_and_relevant_replies"]),
  words: Words.optional(), phrases: Words.optional(), productWords: Words.optional(), benefitWords: Words.optional(),
  chinese: Words.optional(), selfPhrases: Words.optional(),
  queryGroups: z.object({ query: Words, supplementalQueries: Words.optional(), version: z.string(), reason: z.string() }).optional(),
});
const Filter = z.object({ version: z.string(), queries: z.array(z.string()), supplementalQueries: z.array(z.string()),
  signature: z.string().optional(), configuration: Configuration.optional() });
export const CollectionCoverage = z.object({
  version: z.literal(1),
  snapshot: z.object({
    authors: z.array(z.string()),
    filter: Filter.nullable(),
  }),
  authors: z.array(z.object({ handle: z.string(), name: z.string(), collectedSince: Timestamp.nullable() })),
  scopeEffectiveAt: Timestamp.nullable(),
  retiredScopes: z.array(z.object({ since: Timestamp.nullable(), until: Timestamp, filter: Filter.nullable() })).default([]),
});
export type CollectionCoverage = z.infer<typeof CollectionCoverage>;
export const collectionCoverageKey = () => `collection:coverage:v1:${collectorName()}`;

/** A configuration change applies forwards only; display changes do not reset coverage. */
export function reconcileCollectionCoverage(saved: unknown, definition: Pick<ResetMonitorBackendDefinition, "authors" | "collectionFilter" | "processingMode">,
  observedAt: string, baseline: string | null, explicitInitialization = false): CollectionCoverage {
  Timestamp.parse(observedAt); Timestamp.nullable().parse(baseline);
  const filter = definition.collectionFilter;
  const snapshot = {
    authors: definition.authors.map(a => a.handle.toLowerCase()),
    filter: filter ? { version: filter.version, queries: typeof filter.query === "string" ? [filter.query] : [...filter.query],
      supplementalQueries: [...(filter.supplementalQueries ?? [])], ...(filter.configuration ? { configuration: filter.configuration } : {}),
      ...(filter.signature ? { signature: filter.signature } : {}) } : null,
  };
  const previous = saved == null ? null : CollectionCoverage.parse(saved);
  const identity = (value: typeof snapshot.filter) => value?.signature ?? JSON.stringify(value);
  const changed = !!previous && identity(previous.snapshot.filter) !== identity(snapshot.filter);
  if (changed && definition.processingMode !== "collect_only" && !explicitInitialization && previous.snapshot.filter && !previous.snapshot.filter.configuration) {
    throw new Error("Previous collection filter cannot be reconstructed; restore its original configuration and finish coverage before changing scope");
  }
  return {
    version: 1, snapshot,
    authors: definition.authors.map(author => {
      const existing = previous?.authors.find(a => a.handle.toLowerCase() === author.handle.toLowerCase());
      return { handle: author.handle, name: author.name, collectedSince: previous ? existing ? existing.collectedSince : observedAt : baseline };
    }),
    scopeEffectiveAt: explicitInitialization ? baseline : previous ? changed ? observedAt : previous.scopeEffectiveAt : baseline,
    retiredScopes: explicitInitialization || definition.processingMode === "collect_only" ? [] : [...(previous?.retiredScopes ?? []), ...(changed ? [{ since: previous!.scopeEffectiveAt, until: observedAt, filter: previous!.snapshot.filter }] : [])],
  };
}

export async function loadCollectionCoverage(db: Db = sql): Promise<CollectionCoverage | null> {
  const [row] = await db<{ value: unknown }[]>`SELECT value FROM monitor_state WHERE monitor_id = ${monitorId()} AND key = ${collectionCoverageKey()}`;
  return row ? CollectionCoverage.parse(row.value) : null;
}

/** Commit the observed configuration before any provider request, including rounds that later fail. */
export async function prepareCollectionCoverage(observedAt: string, baseline: string | null, scannedThrough?: string, explicitInitialization = false): Promise<CollectionCoverage> {
  return sql.begin(async tx => {
    // Install a baseline row first so FOR UPDATE also serializes the first observation.
    const initial = reconcileCollectionCoverage(null, monitor(), observedAt, baseline);
    await tx`INSERT INTO monitor_state (monitor_id,key,value) VALUES (${monitorId()},${collectionCoverageKey()},${tx.json(initial)}) ON CONFLICT (monitor_id,key) DO NOTHING`;
    const [row] = await tx<{ value: unknown }[]>`SELECT value FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${collectionCoverageKey()} FOR UPDATE`;
    const coverage = reconcileCollectionCoverage(row!.value, monitor(), observedAt, baseline, explicitInitialization);
    if (scannedThrough) {
      const safeBefore = Math.min(Date.parse(scannedThrough), Date.parse(observedAt) - 24 * 3600_000);
      coverage.retiredScopes = coverage.retiredScopes.filter(scope => Date.parse(scope.until) > safeBefore);
    }
    await tx`UPDATE monitor_state SET value=${tx.json(coverage)},updated_at=now() WHERE monitor_id=${monitorId()} AND key=${collectionCoverageKey()}`;
    return coverage;
  });
}

export function authorCollectionSince(coverage: CollectionCoverage, handle: string, since: number): number {
  const author = coverage.authors.find(a => a.handle.toLowerCase() === handle.toLowerCase());
  if (!author) throw new Error(`Collection coverage is missing configured author ${handle}`);
  return Math.max(since, author.collectedSince ? Date.parse(author.collectedSince) : since);
}

export function collectionSegments(coverage: CollectionCoverage, since: number, until: number,
  currentFilter = monitor().collectionFilter): Array<{ since: number; until: number; filter: ResetMonitorBackendDefinition["collectionFilter"] }> {
  const out: ReturnType<typeof collectionSegments> = [];
  for (const scope of coverage.retiredScopes) {
    const start = Math.max(since, scope.since ? Date.parse(scope.since) : since);
    const end = Math.min(until, Date.parse(scope.until));
    if (start >= end) continue;
    if (scope.filter && !scope.filter.configuration) throw new Error("Previous collection filter cannot be reconstructed");
    const filter = scope.filter ? buildCollectionFilter(scope.filter.configuration) : undefined;
    if (scope.filter && (!filter || filter.version !== scope.filter.version
      || JSON.stringify(typeof filter.query === "string" ? [filter.query] : filter.query) !== JSON.stringify(scope.filter.queries)
      || JSON.stringify(filter.supplementalQueries ?? []) !== JSON.stringify(scope.filter.supplementalQueries)
      || scope.filter.signature && scope.filter.signature !== filter.signature)) {
      throw new Error("Previous collection filter no longer matches its saved scope");
    }
    out.push({ since: start, until: end, filter });
  }
  const start = Math.max(since, coverage.scopeEffectiveAt ? Date.parse(coverage.scopeEffectiveAt) : since);
  if (start < until) out.push({ since: start, until, filter: currentFilter });
  return out;
}
