import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionQuery, embeddedQuote, isMainPost } from "../backend/post-policy.ts";
import type { Tweet } from "../backend/providers/collectors.ts";

const post: Tweet = { id_str:"100",full_text:"A standalone announcement",tweet_created_at:"2026-10-19T01:00:00Z",user:{ screen_name:"Official",name:"Official" } };

test("ordinary posts and quotes are accepted, replies and pure reposts are excluded", () => {
  assert.ok(isMainPost(post));
  for (const extra of [{ is_reply:true },{ in_reply_to_status_id_str:"99" },{ in_reply_to_screen_name:"Official" },{ retweeted_status:post }]) {
    assert.equal(isMainPost({ ...post,...extra }),false);
  }
  const quote = { ...post,id_str:"101",quoted_status:{ ...post,in_reply_to_status_id_str:"98" } };
  assert.ok(isMainPost(quote),"only the outer post decides whether a quote is a reply");
  assert.equal(embeddedQuote(quote)[0]!.id,"100");
});

test("search excludes replies without adding content keywords or excluding quote posts", () => {
  assert.equal(collectionQuery("Official",1001,2999),"from:official -filter:replies since_time:1 until_time:3");
});
