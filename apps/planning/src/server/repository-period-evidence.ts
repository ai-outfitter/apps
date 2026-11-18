import { z } from "zod";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { repositories, pullRequests } from "./project-repositories";
import { summarizeCommits, type RepositoryChanges } from "./repo-changes";
import type { ProjectRepository } from "../project-readiness";
import { reportPeriodForDate, type ReportPeriod } from "./report-period";

type Host = WorkflowHost<"interactive" | "schedule">;
type Project = { id: string; revision: number; githubRepository: string };
const pull = z.object({number:z.number().int().positive(),title:z.string(),url:z.string(),mergedAt:z.iso.datetime({offset:true}),author:z.string().nullable()});
const commit = z.object({sha:z.string().regex(/^[a-f0-9]{40}$/),headline:z.string(),committedAt:z.iso.datetime({offset:true}),url:z.string(),author:z.string().nullable(),pullRequests:z.array(pull)});
const commitPage = z.object({ref:z.string(),commits:z.array(commit).max(100),more:z.boolean()});
const pullPage = z.object({nodes:z.array(z.object({number:z.number().int().positive(),title:z.string(),url:z.string(),updatedAt:z.iso.datetime({offset:true}),mergedAt:z.iso.datetime({offset:true}).nullable()})).max(100),pageInfo:z.object({endCursor:z.string().nullable(),hasNextPage:z.boolean()})});
export type RepositoryPeriodSource = Omit<RepositoryChanges,"commitCount"|"pullRequests"> & {
  commitCount:number|null; pullRequests:(Omit<RepositoryChanges["pullRequests"][number],"commits"> & {commits:number|null})[];
  method:"commits.list"|"pulls.list"|"unavailable"; scope:"configured-path-and-ref"|"repository-wide";
  complete:boolean; unknowns:string[]; configuration:{nodeId:string;edgeId?:string;source:"wiki-source_in"|"legacy-project-field"};
};
export type RepositoryPeriodEvidence = {period:ReportPeriod;project:{installationId:string;id:string;revision:number};complete:boolean;errors:string[];repositories:RepositoryPeriodSource[];coverage:string};
const within=(time:string,period:ReportPeriod)=>Date.parse(time)>=period.start&&Date.parse(time)<period.end;
const metadata=(repo:ProjectRepository)=>({nodeId:repo.nodeId,...(repo.edgeId?{edgeId:repo.edgeId}:{}),source:repo.nodeId.startsWith("legacy:")?"legacy-project-field" as const:"wiki-source_in" as const});
const empty=(repo:ProjectRepository,error:string):RepositoryPeriodSource=>({repository:repo.repository,url:repo.url,path:repo.path,ref:repo.ref,pullRequests:[],directCommits:[],commitCount:null,more:false,error,method:"unavailable",scope:"configured-path-and-ref",complete:false,unknowns:[error],configuration:metadata(repo)});
async function message(error:unknown){return error instanceof Response?(await error.text().catch(()=>"")).slice(0,200)||`Repository read refused (${error.status})`:error instanceof Error?error.message.slice(0,200):"Repository source unavailable";}

async function readCommits(host:Host,repo:ProjectRepository,connectionId:string,period:ReportPeriod):Promise<RepositoryPeriodSource>{
 const found=z.object({id:z.number().int().positive()}).parse(await host.call("repository.request",{connectionId,method:"GET",path:`/repos/${repo.repository}`}));
 const page=commitPage.parse(await host.call("connector.execute",{connectionId,resource:String(found.id),operation:"commits.list",input:{since:new Date(period.start).toISOString(),until:new Date(period.end).toISOString(),limit:100,...(repo.ref?{ref:repo.ref}:{}),...(repo.path?{path:repo.path}:{})}}));
 // The provider's until boundary may be inclusive. Filter raw timestamps BEFORE
 // summarizeCommits drops association details and applies its retained-item bound.
 const windowCommits=page.commits.filter(item=>within(item.committedAt,period));
 // Merge time is independent of a commit's user-controlled committed timestamp.
 // Retain every provider-returned confirmed window merge, including a boundary
 // commit excluded from the exact window commit count.
 const associations=page.commits.map(item=>({...item,pullRequests:item.pullRequests.filter(pr=>within(pr.mergedAt,period))})).filter(item=>item.pullRequests.length);
 const merged=summarizeCommits(repo,{...page,commits:associations});
 const direct=windowCommits.filter(item=>!item.pullRequests.length);
 const directSummary=summarizeCommits(repo,{...page,commits:direct});
 const pullRequests=merged.pullRequests.map(pr=>({...pr,commits:windowCommits.filter(item=>item.pullRequests.some(association=>association.number===pr.number)).length}));
 const summarized={...merged,pullRequests,directCommits:directSummary.directCommits,commitCount:windowCommits.length};
 const pulls=new Set(associations.flatMap(item=>item.pullRequests.map(pr=>pr.number)));
 const omitted=pulls.size>pullRequests.length||direct.length>summarized.directCommits.length;
 const unclassified=windowCommits.filter(item=>item.pullRequests.length&&!item.pullRequests.some(pr=>within(pr.mergedAt,period))).length;
 const unknowns=page.more?["Repository history has more commits than this bounded read."]:[];
 if(omitted)unknowns.push("Some observed commits or merged pull requests exceed the retained summary bound.");
 if(unclassified)unknowns.push(`${unclassified} window commits have only outside-period PR associations; they are neither direct commits nor confirmed merges in this report period.`);
 return {...summarized,method:"commits.list",scope:"configured-path-and-ref",complete:!page.more&&!omitted&&!unclassified,unknowns,configuration:metadata(repo)};
}
/** Existing member-authorized PR metadata read, without claiming path/ref or commit-history proof. */
async function readPulls(context:Parameters<typeof repositories>[0],repo:ProjectRepository,period:ReportPeriod):Promise<RepositoryPeriodSource>{
 const seen=new Set<string>(),found=new Map<number,RepositoryPeriodSource["pullRequests"][number]>();
 let after:string|undefined,more=true;
 for(let pageNumber=0;pageNumber<5&&more;pageNumber++){
  const page=pullPage.parse(await pullRequests(context,repo,100,after));
  for(const pr of page.nodes)if(pr.mergedAt&&within(pr.mergedAt,period))found.set(pr.number,{number:pr.number,title:pr.title,url:pr.url,mergedAt:pr.mergedAt,author:null,commits:null});
  // The existing pulls.list contract sorts by updatedAt descending; a PR's
  // merge cannot follow its final updatedAt. Older pages cannot add window merges.
  const oldest=page.nodes.at(-1);
  more=page.pageInfo.hasNextPage&&!(oldest&&Date.parse(oldest.updatedAt)<period.start);
  if(!more)break;
  const next=page.pageInfo.endCursor;
  if(!next||seen.has(next))throw new Error("Repository pull-request cursor did not advance");
  seen.add(next);after=next;
 }
 const scoped=Boolean(repo.path||repo.ref);
 const unknowns=["Direct commits and default-branch reachability were not read; this source proves merged PR metadata only."];
 if(scoped)unknowns.push("The member PR list is repository-wide; configured path/ref attribution was not established.");
 if(more)unknowns.push("The bounded pull-request history may omit merged work in the period.");
 return {repository:repo.repository,url:repo.url,path:repo.path,ref:repo.ref,pullRequests:[...found.values()].sort((a,b)=>b.mergedAt.localeCompare(a.mergedAt)),directCommits:[],commitCount:null,more,error:null,method:"pulls.list",scope:"repository-wide",complete:!more&&!scoped,unknowns,configuration:metadata(repo)};
}
async function readConfigured(host:Host,context:Parameters<typeof repositories>[0],repo:ProjectRepository,period:ReportPeriod,connectionId:string|undefined,canReadPulls:boolean):Promise<RepositoryPeriodSource>{
 if(connectionId){
  try{return await readCommits(host,repo,connectionId,period);}
  catch(error){
   if(!canReadPulls)throw error;
   const source=await readPulls(context,repo,period);
   source.unknowns.push(`Commit history was unavailable: ${await message(error)}`);
   return source;
  }
 }
 return canReadPulls?readPulls(context,repo,period):empty(repo,"No authorized GitHub connection exposes repository history for this owner.");
}
/** Exact report-window repository observations. Source errors never become successful empty activity. */
export async function captureRepositoryPeriodEvidence(host:Host,actor:AppIdentity,project:Project,period:ReportPeriod,
 readRepositories:typeof repositories=repositories):Promise<RepositoryPeriodEvidence>{
 const result:RepositoryPeriodEvidence={period,project:{installationId:actor.installationId,id:project.id,revision:project.revision},complete:false,errors:[],repositories:[],coverage:"Authorized repository observations only. A merge is not deployment, release or proof of individual contribution; no saved digest repository snapshot is available."};
 try{
  const expected=reportPeriodForDate(period.date,period.timezone);
  if(expected.start!==period.start||expected.end!==period.end)throw new Error("Repository evidence requires the exact local calendar ReportPeriod");
  const context={identity:actor,host:()=>host as WorkflowHost<"interactive">};
  // This existing selector preserves source_in path/ref, multiple repositories
  // and the legacy githubRepository field, and propagates graph read failures.
  const configured=await readRepositories(context,project.id,project.githubRepository);
  if(!configured.length){result.complete=true;result.coverage+=" No GitHub repository is configured; this is not evidence that no work occurred.";return result;}
  const snapshot=z.object({connections:z.array(z.object({id:z.string(),provider:z.string(),owner:z.string(),operations:z.array(z.string())}))}).parse(await host.call("snapshot",{}));
  const commits=snapshot.connections.find(item=>item.provider==="github"&&item.owner===(actor.owner.kind==="organization"?"organization":"user")&&item.operations.includes("commits.list"));
  const canReadPulls=snapshot.connections.some(item=>item.provider==="github"&&(item.owner==="user"||actor.owner.kind==="organization"&&item.owner==="organization")&&item.operations.includes("pulls.list"));
  for(const repo of configured){
   try{
    const source=await readConfigured(host,context,repo,period,commits?.id,canReadPulls);
    result.repositories.push(source);
    if(!source.complete)result.errors.push(`${repo.repository}: ${source.error??source.unknowns.join(" ")}`);
   }catch(error){const source=empty(repo,await message(error));result.repositories.push(source);result.errors.push(`${repo.repository}: ${source.error}`);}
  }
  result.complete=result.errors.length===0;
 }catch(error){result.errors.push(`Repository evidence unavailable: ${await message(error)}`);}
 return result;
}
