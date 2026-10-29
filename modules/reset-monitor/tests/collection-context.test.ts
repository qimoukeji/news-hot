import { stub, Reply } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import {after,beforeEach,test} from "node:test";
import {sql,closeDb} from "@aihot/backend/db";
import {config} from "@aihot/backend/config";
import {backendDefinition as codex} from "../../codex-reset/backend-definition.ts";
import {inMonitor} from "../backend/context.ts";
import {collectPosts} from "../backend/collection.ts";
import {loadActionInput,storeCollectedPost} from "../backend/action-store.ts";
import {buildThreadGroups} from "../backend/thread-groups.ts";
import type {Tweet} from "../backend/providers/collectors.ts";
const since="2026-10-28T00:00:00Z",startedAt=new Date("2026-10-28T09:00:00Z");
const author="Official";
const tweet=(id:string,hour:number,patch:Partial<Tweet>={}):Tweet=>({id_str:id,user:{screen_name:author,name:author},full_text:`Official source ${id}`,tweet_created_at:`2026-10-28T${String(hour).padStart(2,"0")}:00:00Z`,...patch});
let pages:Tweet[][]=[],parents:Tweet[]=[],lookupStatus=200;
const calls:URL[]=[];
const provider=await stub((_hit,request)=>{
  const url=new URL(request.url,"http://localhost");calls.push(url);
  if(url.pathname==="/twitter/search"){
    const index=Number(url.searchParams.get("cursor")??0),next=index+1<pages.length?String(index+1):null;
    return {tweets:pages[index]??[],next_cursor:next};
  }
  if(lookupStatus!==200)return new Reply(lookupStatus,{error:"Synthetic lookup refusal"});
  const id=url.pathname.split("/").at(-1);
  const parent=parents.find(post=>post.id_str===id);
  return parent??new Reply(404,{error:"Tweet not found"});
});
Object.assign(process.env,{SOCIALDATA_BASE_URL:provider.url,SOCIALDATA_API_KEY:"synthetic",CODEX_RESET_PROVIDER:"socialdata",COLLECT_ENABLED:"true"});
config.allowPrivateNetworkFetch=true;
const definition={...codex,authors:[{handle:author,name:author}],collection:{includeReplies:false,includeSelfReplies:true,resetOnly:false,keywords:[]}};
const run=()=>inMonitor(definition,()=>collectPosts({startedAt,roundId:"context-fixture"}));
const input=()=>inMonitor(definition,()=>loadActionInput());
const lookupCalls=()=>calls.filter(url=>url.pathname!=="/twitter/search");
beforeEach(async()=>{
  await sql`DELETE FROM monitor_event_actions`;await sql`DELETE FROM monitor_event_records`;await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`;await sql`DELETE FROM receipts`;await sql`DELETE FROM budgets`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('socialdata',1000,1000,1000)`;
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex','cursor:socialdata',${sql.json({checkpointVersion:2,scannedThrough:since})})`;
  pages=[];parents=[];lookupStatus=200;calls.length=0;process.env.COLLECT_ENABLED="true";
});
after(async()=>{await provider.close();await closeDb();});

test("cross-page quoted self-reply with no target username is saved and forms ABC with no paid lookup",async()=>{
  const a=tweet("101",1),b=tweet("102",2,{is_reply:true,in_reply_to_status_id_str:a.id_str,in_reply_to_screen_name:null});
  const c=tweet("103",3,{quoted_status:b}),d=tweet("104",4);
  pages=[[c,d],[a]];
  const result=await run(),saved=await input();
  assert.equal(result.stored,4);assert.equal(result.embedded,1);assert.equal(result.contextFetched,0);assert.equal(result.pages,2);assert.equal(lookupCalls().length,0);
  assert.deepEqual(saved.posts.map(post=>post.id),["101","102","103","104"]);
  assert.deepEqual(saved.posts.find(post=>post.id===b.id_str)!.reply_to,{postId:a.id_str,author:null});
  assert.deepEqual(buildThreadGroups(saved.posts).map(group=>group.targets.map(post=>post.id)),[["101","102","103"],["104"]]);
});

test("missing shared parent is looked up once and stored as context outside the collection window",async()=>{
  const parent=tweet("90",0,{tweet_created_at:"2026-10-27T23:00:00Z"});
  pages=[[tweet("101",1,{is_reply:true,in_reply_to_status_id_str:"90"}),tweet("102",2,{is_reply:true,in_reply_to_status_id_str:"90"})]];parents=[parent];
  const result=await run(),saved=await input();
  assert.equal(result.contextFetched,1);assert.equal(result.stored,2);assert.equal(lookupCalls().length,1);
  assert.equal(saved.posts.find(post=>post.id==="90")!.context_only,true);
  const groups=buildThreadGroups(saved.posts);assert.equal(groups.length,1);assert.deepEqual(groups[0].context.map(post=>post.id),["90"]);assert.equal(groups[0].issues.length,0);
  const [receipt]=await sql`SELECT status FROM receipts WHERE purpose='monitor.context'`;
  assert.equal(receipt.status,"completed");
});

test("saved parent is reused even when reply target account is missing",async()=>{
  await inMonitor(definition,()=>storeCollectedPost({id:"90",author,publishedAt:"2026-10-27T23:00:00Z",url:"https://x.com/Official/status/90",text:"We will reset usage",receiptId:null,contextOnly:true}));
  pages=[[tweet("101",1,{is_reply:true,in_reply_to_status_id_str:"90"})]];
  await run();assert.equal(lookupCalls().length,0);assert.equal((await input()).posts.length,2);
});

test("a definite unavailable parent is remembered without a fake post or repeated payment",async()=>{
  pages=[[tweet("101",1,{is_reply:true,in_reply_to_status_id_str:"90"}),tweet("102",2,{is_reply:true,in_reply_to_status_id_str:"90"})]];
  const first=await run();assert.equal(lookupCalls().length,1);assert.equal(first.issues,2);
  assert.equal((await input()).posts.length,2);
  const [missing]=await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='context:missing:socialdata:90'`;
  assert.equal(missing.value.reason,"not_returned");
  await run();assert.equal(lookupCalls().length,1,"the unavailable ID is not repurchased");
});

test("a lookup transport refusal fails the round instead of marking the parent missing",async()=>{
  pages=[[tweet("101",1,{is_reply:true,in_reply_to_status_id_str:"90"})]];lookupStatus=429;
  await assert.rejects(run(),/429/);
  const missing=await sql`SELECT key FROM monitor_state WHERE monitor_id='codex' AND key='context:missing:socialdata:90'`;
  assert.equal(missing.length,0);
  const [cursor]=await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='cursor:socialdata'`;
  assert.equal(cursor.value.scannedThrough,since);
});

test("returned reply categories are accepted without local reclassification while identity violations fail explicitly",async()=>{
  pages=[[tweet("101",1,{is_reply:true,in_reply_to_status_id_str:null,in_reply_to_screen_name:null})]];
  const result=await run();assert.equal(result.stored,1);assert.equal((await input()).posts[0].processing_status,"pending");
  pages=[[tweet("102",2,{user:{screen_name:"Unexpected",name:"Unexpected"}})]];
  await assert.rejects(inMonitor(definition,()=>collectPosts({startedAt,roundId:"wrong-author"})),/outside the requested author or window/);
});
