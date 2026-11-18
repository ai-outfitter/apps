import { projectRollup } from "./report-summary";
import { z } from "zod";
import { and,asc,eq,sql } from "drizzle-orm";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { PlanningDatabase } from "./planning";
import { issues,workSubmissions,intakes,type Project } from "./schema";
import { intakeQuestions } from "./intake-conversation";
import type { IntakeRow } from "./intake";
import { projectDocuments } from "./project-page";
import { requestedReportPeriod,type ReportPeriod } from "./report-period";
import { captureRepositoryPeriodEvidence } from "./repository-period-evidence";
import { saveReportNote,type ReportRef } from "./digest-wiki";
type Host=Pick<WorkflowHost<"interactive">,"call">;
const within=(time:number,period:ReportPeriod)=>time>=period.start && time<period.end;

/** Capture observed records in an actual calendar window; current tables cannot reconstruct overwritten events. */
export async function captureProjectReport(db:PlanningDatabase,actor:AppIdentity,project:Project,period:ReportPeriod){
 const [rows,submissions,requests]=await Promise.all([
  db.select().from(issues).where(and(eq(issues.installationId,actor.installationId),eq(issues.projectId,project.id))).orderBy(asc(issues.id)),
  db.select().from(workSubmissions).where(and(eq(workSubmissions.installationId,actor.installationId),eq(workSubmissions.projectId,project.id))).orderBy(asc(workSubmissions.id)),
  db.select().from(intakes).where(and(eq(intakes.installationId,actor.installationId),sql`coalesce(json_extract(${intakes.body},'$.projectId'),json_extract(${intakes.body},'$.input.projectId'))=${project.id}`)).orderBy(asc(intakes.id)).limit(101),
 ]);
 const observed=rows.filter(row=>within(row.createdAt,period)||within(row.updatedAt,period));
 const changedDocuments=within(project.updatedAt,period)?projectDocuments.filter(([field])=>!!project[field]).map(([,label])=>label):[];
 const delivery=submissions.filter(row=>within(row.createdAt,period)).map(row=>({id:row.id,createdAt:row.createdAt,currentlyAccepted:row.accepted!==null}));
 const completed=observed.filter(row=>row.status==="done" && within(row.updatedAt,period));
 const sourceAfterWindow=rows.filter(row=>row.createdAt<period.end && row.updatedAt>=period.end).map(row=>row.id);
 return {
  project:{id:project.id,name:project.name,revision:project.revision},
  decisions:requests.slice(0,100).map(row=>intakeQuestions({id:row.id,revision:row.revision,body:JSON.parse(row.body)} as IntakeRow)),
  decisionsTruncated:requests.length>100,
  summary:observed.length||changedDocuments.length||delivery.length?`${completed.length ? `Observed completed: ${completed.slice(0,3).map(row=>row.title).join("; ")}. ` : ""}${observed.filter(row=>row.status!=="done").length} other issue updates; ${delivery.length} work submissions. ${changedDocuments.length ? "Project documentation was updated. " : ""}Launch metrics remain unverified without analytics evidence.`:"No changes are observable in current Planning records for this window. Overwritten transitions and deleted records cannot be reconstructed.",
  outcome:observed.length||changedDocuments.length||delivery.length?"observed-changes":"no-observed-changes",
  completeness:{reads:"complete",history:"limited",gaps:["Planning stores current project/issue rows; overwritten transitions and deleted records cannot be reconstructed.","Document timestamps identify project edits, not per-document edits; acceptance has no independent timestamp."],updatedAfterWindow:sourceAfterWindow},
  sources:[{kind:"planning.project",id:project.id,revision:project.revision},{kind:"planning.issues",count:rows.length},{kind:"planning.work-submissions",count:submissions.length}],
  changes:{counts:{issues:observed.length,projectDocuments:changedDocuments.length,delivery:delivery.length},omittedIssues:Math.max(0,observed.length-20),issues:observed.slice(0,20).map(row=>({id:row.id,title:row.title,category:row.category,currentStatus:row.status,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,createdInWindow:within(row.createdAt,period),updatedInWindow:within(row.updatedAt,period)})),projectDocuments:changedDocuments,delivery},
  coverage:"Planning records only; external repositories, connectors and conversation threads were not read.",
 };
}
export type ReportChain={period:ReportPeriod;projects:{projectId:string;report:ReportRef|null;status:"complete"|"incomplete";summary:Record<string,z.infer<ReturnType<typeof z.json>>>}[];overview:ReportRef|null;status:"complete"|"incomplete"};
/** Dependency order is explicit: capture/save each project, then save the owner overview from those exact revisions. */
export async function runReportChain(db:PlanningDatabase,host:Host,actor:AppIdentity,targets:Project[],runId:string,{now=Date.now(),timezone="America/Chicago",date,includeOverview=true}:{now?:number;timezone?:string;date?:string;includeOverview?:boolean}={}):Promise<ReportChain>{
 const period=requestedReportPeriod(now,timezone,date);
 const children:ReportChain["projects"]=[];
 for(const target of targets){
  let content:Record<string,unknown>,status:"complete"|"incomplete"="complete";
  try{content=await captureProjectReport(db,actor,target,period);}catch{
   status="incomplete";content={summary:"Source capture failed. This is an incomplete report, not evidence that nothing changed.",project:{id:target.id,name:target.name},outcome:"unavailable",completeness:{reads:"failed",history:"unknown"},sources:["planning.project","planning.issues","planning.work-submissions"],reason:"Planning source reads failed; this is not a no-change report."};
  }
  const repositoryEvidence=await captureRepositoryPeriodEvidence(host as WorkflowHost<"interactive">,actor,target,period);
  content.repositoryEvidence=repositoryEvidence;
  content.coverage="Current Planning records and authorized repository observations for the exact calendar window. Conversation transcripts and deployment verification were not read.";
  if(!repositoryEvidence.complete)status="incomplete";
  const merged=repositoryEvidence.repositories.reduce((count,repo)=>count+repo.pullRequests.length,0);
  if(merged)content.summary=`${content.summary} ${merged} merged pull request observations were captured; a merge is not proof of deployment.`;
  let report:ReportRef|null=null;
  try{report=await saveReportNote(host,actor,{level:"project",subject:target.id,title:`${target.name} — ${period.date}`,period,content,status,runId,capturedAt:now});}catch{status="incomplete";}
  children.push({projectId:target.id,report,status,summary:z.record(z.string(),z.json()).parse({name:target.name,outcome:content.outcome,counts:(content.changes as {counts?:unknown}|undefined)?.counts??null,history:(content.completeness as {history?:unknown}|undefined)?.history??"unknown",summary:content.summary??null,decisions:content.decisions??[],decisionsTruncated:content.decisionsTruncated??false,
   completedIssues:((content.changes as {issues?:{id:string;title:string;currentStatus:string;updatedAt:number;updatedInWindow:boolean}[]}|undefined)?.issues??[]).filter(issue=>issue.currentStatus==="done"&&issue.updatedInWindow).map(issue=>({id:issue.id,title:issue.title,observedAt:issue.updatedAt})),
   omittedIssueObservations:(content.changes as {omittedIssues?:number}|undefined)?.omittedIssues??0,repositoryEvidence})});
 }
 const status=children.some(child=>child.status==="incomplete")?"incomplete":"complete";
 if(!includeOverview)return {period,projects:children,overview:null,status};
 const level=actor.owner.kind==="organization"?"organization":"personal";
 let overview:ReportRef|null=null;
 try{overview=await saveReportNote(host,actor,{level,subject:actor.owner.id,title:`${level==="organization"?"Organization":"Personal"} daily overview — ${period.date}`,period,runId,capturedAt:now,status,content:{summary:projectRollup(children),outcome:status==="complete"?"project-reports-captured":"project-reports-incomplete",completeness:{projectReads:status,history:"limited"},dependencies:children,coverage:level==="personal"?"Personal Planning projects only; organization reports require a separate authorized cross-scope read.":"This organization's active Planning projects only."}});}catch{return {period,projects:children,overview:null,status:"incomplete"};}
 return {period,projects:children,overview,status};
}
