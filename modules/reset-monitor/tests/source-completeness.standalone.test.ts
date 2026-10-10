import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceContentIssue } from "../backend/source-completeness.ts";

test("unsaved X Article links remain unknown; a readable post is still recognized", () => {
  for (const source of ["http://x.com/i/article/2077886850262503424", "https://twitter.com/i/article/123?ref=profile"]) {
    assert.match(sourceContentIssue(source)!, /正文未保存/);
  }
  for (const source of ["", "We've reset weekly limits. https://x.com/i/article/123", "https://example.com/announcement", "https://x.com/i/status/123"]) {
    assert.equal(sourceContentIssue(source), null);
  }
});
