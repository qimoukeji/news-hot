import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourcePostRow } from "../actions.ts";
import { buildThreadGroups } from "../backend/thread-groups.ts";
const post = (id:string,minute:number,patch:Partial<SourcePostRow>={}):SourcePostRow=>({id,author:"Official",published_at:`2026-10-28T00:${String(minute).padStart(2,"0")}:00Z`,url:`https://x.com/Official/status/${id}`,text:`Post ${id}`,quoted_post:null,reply_to:null,filtered_out:false,title:null,summary:null,source_receipt_id:null,model_receipt_id:null,processing_status:"pending",review_reason:null,created_at:"2026-10-28T01:00:00Z",updated_at:"2026-10-28T01:00:00Z",...patch});
function example(){const a=post("1",1),b=post("2",2,{reply_to:{postId:"1",author:null}}),c=post("3",3,{quoted_post:{id:"2",author:"Official",relation:"quote",text:b.text!,publishedAt:String(b.published_at),url:b.url}}),d=post("4",4);return [a,b,c,d];}

test("the real reply/quote shape forms ABC and independent D, regardless of response order",()=>{
  const posts=example(),groups=buildThreadGroups([posts[2],posts[3],posts[1],posts[0]]);
  assert.deepEqual(groups.map(group=>group.targets.map(post=>post.id)),[["1","2","3"],["4"]]);
  assert.ok(groups.every(group=>group.issues.length===0));
});
test("processed official ancestors bridge targets as read-only context",()=>{
  const [a,b,c,d]=example();a.processing_status="processed";d.processing_status="processed";
  const groups=buildThreadGroups([a,b,c,d]);
  assert.equal(groups.length,1);assert.deepEqual(groups[0].targets.map(post=>post.id),["2","3"]);assert.deepEqual(groups[0].context.map(post=>post.id),["1"]);
});
test("shared external quotations never merge independent official posts",()=>{
  const external=post("0",0,{author:"Reader",context_only:true,processing_status:"processed"});
  const quote={id:external.id,author:external.author,text:external.text!,publishedAt:String(external.published_at),relation:"quote" as const,url:external.url};
  const a=post("1",1,{quoted_post:quote}),b=post("2",2,{quoted_post:quote});
  const groups=buildThreadGroups([external,a,b]);assert.equal(groups.length,2);
  assert.ok(groups.every(group=>group.targets.length===1&&group.context[0].id==="0"));
});
test("missing ancestors, future references and author conflicts produce explicit review issues",()=>{
  const [a,b,c]=example();
  assert.match(buildThreadGroups([b])[0].issues.join(" "),/上下文不可用/);
  assert.match(buildThreadGroups([{...b,reply_to:{postId:a.id,author:"Other"}},a])[1].issues.join(" "),/冲突/);
  assert.match(buildThreadGroups([{...a,reply_to:{postId:c.id,author:"Official"}},c])[0].issues.join(" "),/时间或关系无效/);
});
test("equal-time cycles cannot be treated as complete context",()=>{
  const a=post("1",1,{reply_to:{postId:"2",author:null}}),b=post("2",1,{reply_to:{postId:"1",author:null}});
  const groups=buildThreadGroups([a,b]);assert.equal(groups.length,1);assert.match(groups[0].issues.join(" "),/循环/);
});
test("context-only and already-reviewed posts never become automatic targets",()=>{
  const a=post("1",1,{context_only:true}),b=post("2",2,{processing_status:"needs_attention"});
  assert.deepEqual(buildThreadGroups([a,b]),[]);
});

test("external quote ancestry is optional, but its direct body remains required context",()=>{
  const external=post("0",0,{author:"Reader",context_only:true,processing_status:"processed",reply_to:{postId:"missing",author:"Other"}});
  const child=post("1",1,{quoted_post:{id:"0",author:"Reader",relation:"quote",text:external.text!,publishedAt:String(external.published_at),url:external.url}});
  assert.equal(buildThreadGroups([external,child])[0].issues.length,0);
  assert.match(buildThreadGroups([{...external,text:null},child])[0].issues.join(" "),/缺少可读正文/);
});

test("a configured second official author remains a bridge when only present as context",()=>{
  const ancestor=post("0",0,{author:"SecondOfficial",context_only:true,processing_status:"processed"});
  const first=post("1",1,{reply_to:{postId:"0",author:"SecondOfficial"}}),second=post("2",2,{reply_to:{postId:"0",author:"SecondOfficial"}});
  assert.equal(buildThreadGroups([ancestor,first,second],["Official","SecondOfficial"]).length,1);
});

test("retired or unconfigured authors cannot become targets in the current monitor",()=>{
  const old=post("0",0,{author:"RetiredOfficial"}),current=post("1",1);
  assert.deepEqual(buildThreadGroups([old,current],["Official"]).flatMap(group=>group.targets.map(post=>post.id)),["1"]);
});
