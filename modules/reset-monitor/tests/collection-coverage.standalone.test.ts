import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { authorCollectionSince, reconcileCollectionCoverage } from "../backend/collection-coverage.ts";

const first = "2026-10-19T01:00:00Z", observed = "2026-10-19T03:00:00Z";
const definition = { authors: [{ handle: "Official", name: "Official" }] };

test("an existing author keeps the unfinished window when collection is tightened", () => {
  const saved = reconcileCollectionCoverage(null, definition, first);
  const current = reconcileCollectionCoverage(saved, definition, observed);
  assert.equal(current.authors[0]!.collectedSince, first);
  assert.equal(authorCollectionSince(current, "official", Date.parse(first)), Date.parse(first));
});

test("new and re-added authors start at first observation and failed runs cannot move it", () => {
  const saved = reconcileCollectionCoverage(null, definition, first);
  const added = { authors: [...definition.authors, { handle: "Second", name: "Second" }] };
  const current = reconcileCollectionCoverage(saved, added, observed);
  assert.equal(current.authors[1]!.collectedSince, observed);
  const retry = reconcileCollectionCoverage(current, added, "2026-10-19T04:00:00Z");
  assert.equal(retry.authors[1]!.collectedSince, observed);
  const removed = reconcileCollectionCoverage(retry, definition, "2026-10-19T05:00:00Z");
  assert.equal(reconcileCollectionCoverage(removed, added, "2026-10-19T06:00:00Z").authors[1]!.collectedSince, "2026-10-19T06:00:00Z");
});
