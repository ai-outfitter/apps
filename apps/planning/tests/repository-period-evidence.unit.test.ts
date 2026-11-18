import assert from "node:assert/strict";
import test from "node:test";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { reportPeriodForDate } from "../src/server/report-period";
import { captureRepositoryPeriodEvidence } from "../src/server/repository-period-evidence";
import type { ProjectRepository } from "../src/project-readiness";
const period=reportPeriodForDate("2026-11-08","America/Chicago");
const actor:AppIdentity={userId:"member",installationId:"planning",owner:{kind:"organization",id:"org"},organizationId:"org",role:"owner",canEdit:true};
const project={id:"project",revision:3,githubRepository:"https://github.com/example/legacy"};
const repo:ProjectRepository={nodeId:"repo",edgeId:"edge",title:"Code",repository:"example/repo",url:"https://github.com/example/repo",path:"apps/planning",ref:"main"};
const time=(offset:number)=>new Date(period.start+offset).toISOString();
const pull=(number:number,mergedAt:string)=>({number,title:`PR ${number}`,url:`https://github.com/example/repo/pull/${number}`,mergedAt,author:"person"});
const commit=(n:number,committedAt:string,pulls:ReturnType<typeof pull>[]=[])=>( {sha:n.toString(16).padStart(40,"0"),headline:`Commit ${n}`,url:`https://github.com/example/repo/commit/${n}`,committedAt,author:"person",pullRequests:pulls} );
function fixture(options:{personal?:boolean;missing?:boolean;more?:boolean;fail?:boolean;commits?:ReturnType<typeof commit>[];pullPages?:unknown[]}={}){
 const calls:{operation:string;input:any}[]=[];let page=0;
 const host={async call(operation:string,input:any){
  calls.push({operation,input});
  if(operation==="snapshot")return {connections:options.missing?[]:options.personal?[{id:"github:user",provider:"github",owner:"user",operations:["pulls.list"]}]:[{id:"org-github",provider:"github",owner:"organization",operations:["commits.list"]}]};
  if(options.fail)throw new Response("Repository credentials revoked",{status:403});
  if(operation==="repository.request"){
   if(input.path==="/graphql")return {data:{repository:{pullRequests:options.pullPages?.[page++]??{nodes:[],pageInfo:{endCursor:null,hasNextPage:false}}}}};
   return {id:123};
  }
  if(operation==="connector.execute")return {ref:"main",commits:options.commits??[commit(1,time(1000),[pull(1,time(2000))])],more:options.more??false};
  throw Error(`Unexpected ${operation}`);
 }} as unknown as WorkflowHost<"interactive">;
 return {host,calls};
}
const selected=async()=>[repo,{...repo,nodeId:"legacy:example/legacy",edgeId:undefined,repository:"example/legacy",url:project.githubRepository,path:null,ref:null}];
test("exact window filtering preserves multi-repository path/ref and legacy configuration through existing commit reads",async()=>{
 const f=fixture({commits:[commit(1,time(1000),[pull(1,time(2000))]),commit(2,time(3000)),commit(3,new Date(period.end).toISOString(),[pull(3,time(2000))]),commit(4,time(4000),[pull(4,new Date(period.end).toISOString())])]});
 const captured=await captureRepositoryPeriodEvidence(f.host,actor,project,period,selected);
 assert.equal(captured.complete,false);assert.equal(captured.repositories.length,2);
 const source=captured.repositories[0];assert.equal(source.commitCount,3);assert.deepEqual(source.pullRequests.map(pr=>pr.number),[1,3]);assert.match(source.unknowns.join(" "),/outside-period/);assert.deepEqual(source.directCommits.map(item=>item.headline),["Commit 2"]);
 assert.equal(source.configuration.edgeId,"edge");assert.equal(captured.repositories[1].configuration.source,"legacy-project-field");
 const execute=f.calls.filter(call=>call.operation==="connector.execute");assert.deepEqual(execute[0].input.input,{since:new Date(period.start).toISOString(),until:new Date(period.end).toISOString(),limit:100,ref:"main",path:"apps/planning"});
 assert.equal(execute[1].input.input.path,undefined);
});
test("member-authorized merged PR metadata reuses existing read path and never claims commit or path/ref proof",async()=>{
 const list=(n:number,mergedAt:string|null,updatedAt=time(9000))=>({number:n,title:`PR ${n}`,url:`https://github.com/example/repo/pull/${n}`,updatedAt,mergedAt,state:mergedAt?"MERGED":"OPEN",createdAt:time(0),closedAt:mergedAt});
 const f=fixture({personal:true,pullPages:[{nodes:[list(1,time(1000)),list(2,new Date(period.end).toISOString()),list(3,null)],pageInfo:{hasNextPage:true,endCursor:"next"}},{nodes:[list(4,time(2000)),list(5,new Date(period.start-1000).toISOString(),new Date(period.start-1000).toISOString())],pageInfo:{hasNextPage:true,endCursor:"older"}}]});
 const personal={...actor,owner:{kind:"user" as const,id:"member"},organizationId:undefined};
 const captured=await captureRepositoryPeriodEvidence(f.host,personal,project,period,async()=>[{...repo,path:null,ref:null}]);
 assert.equal(captured.complete,true);assert.deepEqual(captured.repositories[0].pullRequests.map(pr=>pr.number),[4,1]);
 assert.equal(captured.repositories[0].commitCount,null);assert.equal(captured.repositories[0].scope,"repository-wide");assert.match(captured.repositories[0].unknowns.join(" "),/default-branch/);
 assert.equal(f.calls.filter(call=>call.operation==="repository.request").length,2);
 const scoped=await captureRepositoryPeriodEvidence(fixture({personal:true}).host,personal,project,period,async()=>[repo]);
 assert.equal(scoped.complete,false);assert.match(scoped.errors.join(" "),/path\/ref/);
});
test("missing credentials, graph failures and provider failures are unknown, while healthy empty configuration is explicit",async()=>{
 for(const options of [{missing:true},{fail:true}]){
  const captured=await captureRepositoryPeriodEvidence(fixture(options).host,actor,project,period,async()=>[repo]);
  assert.equal(captured.complete,false);assert.equal(captured.repositories[0].commitCount,null);assert.ok(captured.errors.length);
 }
 const f=fixture();const graphFailed=await captureRepositoryPeriodEvidence(f.host,actor,project,period,async()=>{throw new Response("Graph unavailable",{status:503});});
 assert.equal(graphFailed.complete,false);assert.ok(graphFailed.errors.length);assert.deepEqual(f.calls,[]);
 const empty=await captureRepositoryPeriodEvidence(f.host,actor,project,period,async()=>[]);
 assert.equal(empty.complete,true);assert.match(empty.coverage,/not evidence that no work/);assert.deepEqual(f.calls,[]);
});
test("pagination and retained summary bounds remain incomplete, and invalid calendar windows make no provider calls",async()=>{
 for(const options of [{more:true},{commits:Array.from({length:31},(_,i)=>commit(i+1,time(1000))) }]){
  const captured=await captureRepositoryPeriodEvidence(fixture(options).host,actor,project,period,async()=>[repo]);
  assert.equal(captured.complete,false);assert.ok(captured.errors.length);
 }
 const f=fixture(),invalid=await captureRepositoryPeriodEvidence(f.host,actor,project,{...period,end:period.end+1},selected);
 assert.equal(invalid.complete,false);assert.deepEqual(f.calls,[]);
});


test("the real repository selector accepts a complete empty graph query but preserves graph failures",async()=>{
 const calls:string[]=[];let failed=false;
 const host={async call(operation:string,input:any){
  calls.push(operation);
  if(operation==="entities.types")return input.template==="onto"?[]:["graph-type","graph-node","graph-edge"].map(type=>({type,installationId:"wiki",writable:true}));
  assert.equal(operation,"actions.call");assert.equal(input.action,"graph.query");
  if(failed)throw new Response("Graph query unavailable",{status:503});
  // Recipe for report-host fixtures: one complete answer per submitted query;
  // empty node/type arrays mean a healthy read with no linked project anchor.
  return {version:1,installationId:"wiki",nodes:[],edges:[],types:[],complete:true,
   queries:Object.fromEntries(input.input.queries.map((query:any)=>[query.name,{entity:query.entity,total:0,matches:[],related:[],omitted:[],unresolved:[],missingTypes:[],complete:true,cursor:null}]))};
 }} as unknown as WorkflowHost<"interactive">;
 const empty=await captureRepositoryPeriodEvidence(host,actor,{...project,githubRepository:""},period);
 assert.equal(empty.complete,true);assert.deepEqual(empty.repositories,[]);assert.ok(!calls.includes("snapshot"));
 failed=true;
 const unknown=await captureRepositoryPeriodEvidence(host,actor,{...project,githubRepository:""},period);
 assert.equal(unknown.complete,false);assert.match(unknown.errors.join(" "),/Graph query unavailable/);
});


test("a merge timestamp in the report period survives an associated commit at the exclusive end boundary",async()=>{
 const f=fixture({commits:[commit(7,new Date(period.end).toISOString(),[pull(7,time(1000))])]});
 const captured=await captureRepositoryPeriodEvidence(f.host,actor,project,period,async()=>[repo]);
 assert.equal(captured.complete,true);assert.equal(captured.repositories[0].commitCount,0);
 assert.deepEqual(captured.repositories[0].pullRequests.map(pr=>[pr.number,pr.commits]),[[7,0]]);
 assert.deepEqual(captured.repositories[0].directCommits,[]);
});
