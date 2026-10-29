import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { postContext, needsReplyContext } from "../backend/post-context.ts";
import { fixture } from "./action-fixture.ts";

test("only saved parents with matching identities and past publications become reply context", () => {
  const parent = fixture().posts[0]!;
  const post = { ...parent, id: "reply", text: "All done", published_at: "2026-10-11T00:00:00Z", reply_to: { postId: parent.id, author: parent.author.toUpperCase() } };
  const context = postContext(post, [parent]);
  assert.equal(context.length, 1); assert.equal(context[0]!.relation, "reply");
  assert.equal(context[0]!.text, parent.text); assert.equal(needsReplyContext(post, context), false);
  assert.deepEqual(postContext(post, []), []);
  assert.deepEqual(postContext({ ...post, reply_to: { postId: post.id, author: post.author } }, [post]), []);
  assert.deepEqual(postContext(post, [{ ...parent, author: "different" }]), []);
  assert.deepEqual(postContext(post, [{ ...parent, published_at: "2026-10-12T00:00:00Z" }]), []);
  assert.deepEqual(postContext(post, [{ ...parent, text: " " }]), []);
});

test("unknown parent fields stay unknown and unsaved quotations remain separate context", () => {
  const parent = fixture().posts[0]!;
  parent.reply_to = { postId: "grandparent", author: "other" };
  const post = { ...parent, id: "reply", published_at: "2026-10-11T00:00:00Z", reply_to: { postId: parent.id, author: null },
    quoted_post: { id: "quoted", author: "quoted-author", relation: "quote" as const, text: "Quoted source", publishedAt: null, url: "https://example.test/quote" } };
  assert.deepEqual(postContext(post, [parent]).map(row => row.relation), ["quote", "reply"]);
  assert.equal(postContext({ ...post, quoted_post: null, reply_to: { postId: null, author: null } }, [parent]).length, 0);
});

test("saved reply and quote ancestors are traversed without repeating a cycle", () => {
  const first = fixture().posts[0]!;
  first.published_at = "2026-10-09T00:00:00Z";
  const second = { ...first, id: "middle", published_at: "2026-10-10T00:00:00Z", reply_to: { postId: first.id, author: first.author } };
  const post = { ...second, id: "latest", published_at: "2026-10-11T00:00:00Z", reply_to: null,
    quoted_post: { id: second.id, author: second.author, relation: "quote" as const, text: second.text!,
      publishedAt: new Date(second.published_at).toISOString(), url: second.url } };
  first.reply_to = { postId: post.id, author: post.author };
  assert.deepEqual(postContext(post, [first, second, post]).map(row => [row.id, row.relation]), [[second.id, "quote"], [first.id, "reply"]]);
});

test("quotes with mismatched authors, dates or future ancestors cannot identify context", () => {
  const parent = fixture().posts[0]!;
  const post = { ...parent, id: "latest", published_at: "2026-10-11T00:00:00Z",
    quoted_post: { id: parent.id, author: parent.author, relation: "quote" as const, text: parent.text!,
      publishedAt: new Date(parent.published_at).toISOString(), url: parent.url } };
  assert.equal(postContext(post, [parent]).length, 1);
  assert.deepEqual(postContext(post, [{ ...parent, author: "other" }]), []);
  assert.deepEqual(postContext(post, [{ ...parent, published_at: "2026-10-10T11:00:00Z" }]), []);
  assert.deepEqual(postContext({ ...post, quoted_post: { ...post.quoted_post, publishedAt: "2026-10-12T00:00:00Z" } }, []), []);
  assert.deepEqual(postContext({ ...post, quoted_post: { ...post.quoted_post, id: post.id } }, [post]), []);
});

test("missing context triggers review only for bare replies, not standalone clear facts or main posts", () => {
  const post = { ...fixture().posts[0]!, text: "OK fine", reply_to: { postId: "missing", author: null } };
  assert.equal(needsReplyContext(post, []), true);
  assert.equal(needsReplyContext({ ...post, text: "We reset usage." }, []), false);
  assert.equal(needsReplyContext({ ...post, reply_to: null }, []), false);
});
