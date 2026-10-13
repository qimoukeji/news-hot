import assert from "node:assert/strict";
import { test } from "node:test";
import { authorCollectionSince, collectionSegments, reconcileCollectionCoverage } from "../backend/collection-coverage.ts";
import { buildCollectionFilter } from "../collection-filter.ts";
import { collectionQueries } from "../backend/initial-collection.ts";
import { inMonitor } from "../backend/context.ts";
import { backendDefinition } from "../../grok-reset/backend-definition.ts";

const baseline = "2026-10-10T00:00:00.000Z";
const first = "2026-10-11T00:00:00.000Z";
const retry = "2026-10-11T01:00:00.000Z";
const original = { ...backendDefinition, processingMode: "automatic" as const, authors: [{ handle: "bot", name: "Bot" }], collectionFilter: undefined };

test("upgrade installs original account coverage and display changes preserve its start", () => {
  const installed = reconcileCollectionCoverage(null, original, first, null);
  assert.equal(installed.authors[0]!.collectedSince, null);
  assert.equal(installed.scopeEffectiveAt, null);
  const renamed = reconcileCollectionCoverage(installed, { ...original, authors: [{ handle: "BOT", name: "New display" }] }, retry, baseline);
  assert.equal(renamed.authors[0]!.collectedSince, null);
  assert.equal(renamed.authors[0]!.name, "New display");
  assert.equal(renamed.scopeEffectiveAt, null);
  assert.equal(authorCollectionSince(renamed, "BOT", Date.parse(baseline) - 24 * 3600_000), Date.parse(baseline) - 24 * 3600_000);
});

test("new and readded accounts start at observation time and failure cannot move the start", () => {
  const installed = reconcileCollectionCoverage(null, original, first, baseline);
  const added = { ...original, authors: [...original.authors, { handle: "grok", name: "Grok" }] };
  const observed = reconcileCollectionCoverage(installed, added, first, baseline);
  assert.deepEqual(observed.authors.map(a => a.collectedSince), [baseline, first]);
  const retried = reconcileCollectionCoverage(observed, added, retry, baseline);
  assert.deepEqual(retried.authors.map(a => a.collectedSince), [baseline, first]);
  const removed = reconcileCollectionCoverage(retried, original, retry, baseline);
  const readded = reconcileCollectionCoverage(removed, added, retry, baseline);
  assert.deepEqual(readded.authors.map(a => a.collectedSince), [baseline, retry]);
});

test("scope changes preserve the old range and constrain the new scope's lookback", () => {
  const filtered = { ...original, collectionFilter: buildCollectionFilter({ mode: "announcements_and_relevant_replies", words: ["quota"], productWords: ["grok"] }) };
  const installed = reconcileCollectionCoverage(null, filtered, first, baseline);
  const expanded = reconcileCollectionCoverage(installed, original, first, baseline);
  assert.equal(expanded.scopeEffectiveAt, first);
  assert.equal(authorCollectionSince(expanded, "BOT", Date.parse(baseline) - 24 * 3600_000), Date.parse(baseline));
  inMonitor(original, () => {
    const segments = collectionSegments(expanded, Date.parse(baseline), Date.parse(retry));
    assert.deepEqual(segments.map(s => [s.since, s.until]), [[Date.parse(baseline), Date.parse(first)], [Date.parse(first), Date.parse(retry)]]);
    assert.ok(segments[0]!.filter);
    assert.equal(segments[1]!.filter, undefined);
  });
  const repeated = reconcileCollectionCoverage(expanded, original, retry, baseline);
  assert.equal(repeated.scopeEffectiveAt, first);
  // Diagnostic descriptions alone do not change what the provider or local filter collects.
  const described = reconcileCollectionCoverage(installed, { ...filtered, collectionFilter: { ...filtered.collectionFilter!, reason: "Updated description" } }, retry, baseline);
  assert.equal(described.scopeEffectiveAt, baseline);
});

test("changing an opaque legacy hook rejects instead of losing its unfinished window", () => {
  const filtered = { ...original, collectionFilter: { query: "quota", version: "opaque-v1", reason: "Opaque callback", accepts: () => true } };
  const installed = reconcileCollectionCoverage(null, filtered, first, baseline);
  assert.throws(() => reconcileCollectionCoverage(installed, original, retry, baseline), /cannot be reconstructed/);
});

test("scheduled queries use account starts while explicit initialization keeps its historical range", () => {
  const definition = { ...original, authors: [...original.authors, { handle: "grok", name: "Grok" }] };
  const installed = reconcileCollectionCoverage(null, original, first, baseline);
  const coverage = reconcileCollectionCoverage(installed, definition, first, baseline);
  inMonitor(definition, () => {
    const start = Date.parse(baseline); const end = Date.parse(retry);
    const queries = collectionQueries(start, end, false, handle => authorCollectionSince(coverage, handle, start));
    assert.match(queries[0]!, new RegExp(`since_time:${start / 1000}`));
    assert.match(queries[1]!, new RegExp(`since_time:${Date.parse(first) / 1000}`));
    assert.ok(collectionQueries(start, end).every(query => query.includes(`since_time:${start / 1000}`)));
    assert.equal(collectionQueries(start, Date.parse(first), false, handle => authorCollectionSince(coverage, handle, start)).length, 1);
  });
});
