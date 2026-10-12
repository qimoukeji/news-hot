import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition } from "../../grok-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { advanceInitialCollection, initialCollection, InitialCollection } from "../backend/initial-collection.ts";
import { initializationOptionsFromArgs } from "../initialize.ts";
import { buildCollectionFilter } from "../collection-filter.ts";

test("an empty final provider cursor completes initialization paging and remains resumable", () => {
  inMonitor(backendDefinition, () => {
    const queries = ["from:bot since_time:1 until_time:2"];
    const done = advanceInitialCollection(initialCollection(queries, null), "");
    assert.equal(done.queryIndex, queries.length);
    assert.equal(done.cursor, null);
    assert.deepEqual(InitialCollection.parse(done), done);
    assert.deepEqual(initialCollection(queries, done), done);
  });
});

test("explicit supplemental scope preserves a saved original cursor and binds the processing identity", () => {
  inMonitor(backendDefinition, () => {
    const queries = ["from:bot since_time:1 until_time:2", "from:grok since_time:1 until_time:2"];
    const saved = advanceInitialCollection(initialCollection(queries, null), "saved-cursor");
    const supplemental = ["from:bot reward since_time:1 until_time:2"];
    const extended = initialCollection(queries, saved, supplemental);
    assert.deepEqual(extended.queries, [...queries, ...supplemental]);
    for (const key of ["queryIndex", "cursor", "pageWindow", "processingWindow"] as const) assert.equal(extended[key], saved[key]);
    assert.deepEqual(initialCollection(queries, extended, supplemental), extended);
    assert.throws(() => initialCollection(queries, extended, ["different scope"]), /different range/);
  });
});

test("a completed old query set still requires supplemental collection before completion", () => {
  inMonitor(backendDefinition, () => {
    const queries = ["from:bot since_time:1 until_time:2"];
    const done = advanceInitialCollection(initialCollection(queries, null), null);
    const next = initialCollection(queries, done, ["from:bot reward since_time:1 until_time:2"]);
    assert.equal(next.queryIndex, 1);
    assert.equal(next.queries.length, 2);
    assert.equal(next.cursor, null);
    assert.deepEqual(InitialCollection.parse(next), next);
  });
});

test("collect-only CLI keeps explicit finite range validation", () => {
  const args = ["--since", "2026-10-08T00:00:00Z", "--until", "2026-10-09T00:00:00Z"];
  const now = new Date("2026-10-10T00:00:00Z");
  assert.equal(initializationOptionsFromArgs([...args, "--collect-only"], now)?.collectOnly, true);
  assert.equal(initializationOptionsFromArgs(args, now)?.collectOnly, false);
  assert.throws(() => initializationOptionsFromArgs(["--collect-only"], now), /Both --since/);
});

test("fixed query versions also bind acceptance rules, with a one-time legacy signature upgrade", () => {
  const config = { mode: "announcements_and_relevant_replies" as const, words: ["quota"], productWords: ["grok"],
    queryGroups: { query: ["filter:replies quota"], version: "fixed-v3", reason: "Synthetic filter" } };
  const definition = { ...backendDefinition, collectionFilter: buildCollectionFilter(config) };
  const queries = ["from:bot filter:replies quota since_time:1 until_time:2"];
  const saved = inMonitor(definition, () => initialCollection(queries, null));
  const changed = { ...definition, collectionFilter: buildCollectionFilter({ ...config, words: ["quota", "bonus"] }) };
  assert.throws(() => inMonitor(changed, () => initialCollection(queries, saved)), /different range/);
  const { filterSignature: _signature, ...legacy } = saved;
  const adopted = inMonitor(definition, () => initialCollection(queries, legacy));
  assert.equal(adopted.filterSignature, saved.filterSignature);
  assert.equal(adopted.pageWindow, saved.pageWindow);
  assert.throws(() => inMonitor(changed, () => initialCollection(queries, adopted)), /different range/);
  const supplemented = { ...definition, collectionFilter: buildCollectionFilter({ ...config,
    queryGroups: { ...config.queryGroups, supplementalQueries: ["filter:replies bonus"] } }) };
  const expanded = inMonitor(supplemented, () => initialCollection(queries, adopted, ["from:bot filter:replies bonus since_time:1 until_time:2"]));
  assert.equal(expanded.pageWindow, saved.pageWindow);
  assert.equal(expanded.filterSignature, saved.filterSignature);
  assert.equal(expanded.queries.length, 2);
});
