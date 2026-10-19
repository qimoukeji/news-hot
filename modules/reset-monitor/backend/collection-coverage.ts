import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { monitor, monitorId, type ResetMonitorBackendDefinition } from "./context.ts";
import { collectorName } from "../config.ts";

const Timestamp = z.iso.datetime();
export const CollectionCoverage = z.object({
  authors: z.array(z.object({ handle: z.string(), name: z.string(), collectedSince: Timestamp.nullable() })),
  scopeEffectiveAt: Timestamp.nullable(),
});
export type CollectionCoverage = z.infer<typeof CollectionCoverage>;
export const collectionCoverageKey = () => `collection:coverage:v1:${collectorName()}`;

/** Existing authors keep their window; a new or re-added author starts when first observed. */
export function reconcileCollectionCoverage(saved: unknown, definition: Pick<ResetMonitorBackendDefinition, "authors">,
  observedAt: string, baseline: string = observedAt): CollectionCoverage {
  Timestamp.parse(observedAt); Timestamp.parse(baseline);
  const previous = saved == null ? null : CollectionCoverage.parse(saved);
  return {
    authors: definition.authors.map(author => {
      const existing = previous?.authors.find(a => a.handle.toLowerCase() === author.handle.toLowerCase());
      return { handle: author.handle, name: author.name, collectedSince: previous ? existing ? existing.collectedSince : observedAt : baseline };
    }),
    scopeEffectiveAt: previous ? previous.scopeEffectiveAt : baseline,
  };
}

/** Save author boundaries before paying for a search. Collection policy cannot move a success cutoff. */
export async function prepareCollectionCoverage(observedAt: string, baseline: string): Promise<CollectionCoverage> {
  return sql.begin(async tx => {
    const initial = reconcileCollectionCoverage(null, monitor(), observedAt, baseline);
    await tx`INSERT INTO monitor_state (monitor_id,key,value) VALUES (${monitorId()},${collectionCoverageKey()},${tx.json(initial)}) ON CONFLICT (monitor_id,key) DO NOTHING`;
    const [row] = await tx<{ value: unknown }[]>`SELECT value FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${collectionCoverageKey()} FOR UPDATE`;
    const coverage = reconcileCollectionCoverage(row!.value, monitor(), observedAt, baseline);
    await tx`UPDATE monitor_state SET value=${tx.json(coverage)},updated_at=now() WHERE monitor_id=${monitorId()} AND key=${collectionCoverageKey()}`;
    return coverage;
  });
}

export function authorCollectionSince(coverage: CollectionCoverage, handle: string, since: number): number {
  const author = coverage.authors.find(a => a.handle.toLowerCase() === handle.toLowerCase());
  if (!author) throw new Error("Collection coverage is missing configured author");
  return Math.max(since, author.collectedSince ? Date.parse(author.collectedSince) : since);
}
