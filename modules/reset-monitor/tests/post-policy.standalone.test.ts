import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionQuery, embeddedQuote, replyTarget } from "../backend/post-policy.ts";
import type { Tweet } from "../backend/providers/collectors.ts";
import { normalizeTweet } from "../backend/providers/twitterapi.ts";

const post: Tweet = { id_str:"100",full_text:"A standalone announcement",tweet_created_at:"2026-10-19T01:00:00Z",user:{ screen_name:"Official",name:"Official" } };

test("queries delegate reply types and keywords to the provider", () => {
  assert.equal(collectionQuery("Official",1001,2999),"from:official -filter:retweets -filter:replies since_time:1 until_time:3");
  const collection = { includeReplies: true, includeSelfReplies: true, resetOnly: true, keywords: ["reset", "banked reset", "重置"] };
  assert.equal(collectionQuery("Official",1001,2999,collection),'from:official -filter:retweets ("reset" OR "banked reset" OR "重置") since_time:1 until_time:3');
  assert.equal(collectionQuery("Official",1001,2999,{...collection,includeReplies:false}),'from:official -filter:retweets (-filter:replies OR to:official) ("reset" OR "banked reset" OR "重置") since_time:1 until_time:3');
  assert.equal(collectionQuery("Official",1001,2999,{...collection,includeSelfReplies:false}),'from:official -filter:retweets (-filter:replies OR -to:official) ("reset" OR "banked reset" OR "重置") since_time:1 until_time:3');
  for(const keyword of ['reset" OR from:Other','from:Other','(reset)','reset\\','-reset',' reset','reset\ncredit'])
    assert.throws(()=>collectionQuery("Official",1,2,{...collection,keywords:[keyword]}),/Invalid reset monitor collection/);
  assert.throws(()=>collectionQuery("Official OR Other",1,2,collection),/Invalid collection author/);
  assert.throws(()=>collectionQuery("Official",1,2,{...collection,keywords:[]}),/Invalid reset monitor collection/);
});

test("a quoted self-reply keeps its own parent relationship even without the target account", () => {
  const quote = normalizeTweet({id:"102",text:"Done",createdAt:post.tweet_created_at,author:{name:"Official",userName:"Official"},
    quoted_tweet:{id:"101",text:"By midnight",createdAt:post.tweet_created_at,author:{name:"Official",userName:"Official"},isReply:true,inReplyToId:"100",inReplyToUsername:null}});
  const embedded=embeddedQuote(quote)[0]!;
  assert.equal(embedded.id,"101");assert.deepEqual(embedded.replyTo,{postId:"100",author:null});
  assert.equal(replyTarget(quote),null);
});

test("reply metadata is preserved without inventing missing authors or parents", () => {
  assert.equal(replyTarget(post),null);
  assert.deepEqual(replyTarget({...post,is_reply:true}),{postId:null,author:null});
  assert.deepEqual(replyTarget({...post,in_reply_to_status_id_str:"99"}),{postId:"99",author:null});
  assert.deepEqual(replyTarget({...post,in_reply_to_screen_name:"Other"}),{postId:null,author:"Other"});
  assert.deepEqual(replyTarget({...post,in_reply_to_status_id_str:"99",in_reply_to_screen_name:"Official"}),{postId:"99",author:"Official"});
});
