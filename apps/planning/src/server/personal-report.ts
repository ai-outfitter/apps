import { organizationRollup, projectRollup } from "./report-summary";
import { z } from "zod";
import type {AppIdentity} from "@ai-outfitter/app-sdk/server";
import type {WorkflowHost} from "@ai-outfitter/app-sdk/workflow-host";
import {saveReportNote} from "./digest-wiki";
import type {ReportChain} from "./report-chain";
import {capturePersonalGoalContext} from "./personal-goal-context";
import {sortByOrder} from "./priority-order";
const reference=z.object({installationId:z.string().optional(),app:z.string().optional(),scope:z.unknown().optional(),documentId:z.string(),revision:z.number(),slug:z.string()});
const organizationReport=z.object({owner:z.object({kind:z.literal("organization"),id:z.string()}),planningInstallationId:z.string(),reference,period:z.object({date:z.string(),timezone:z.string(),start:z.number(),end:z.number()}),status:z.enum(["complete","incomplete"]),inputDigest:z.string(),summary:z.string().optional(),dependencies:z.array(z.unknown())});
const dailyReportSource=z.object({ownerKind:z.enum(["organization","user"]),ownerId:z.string(),planningInstallationId:z.string(),organizationSlug:z.string().nullable(),report:z.unknown()});
/** Personal authority reads organization outcomes; organization workers never write the personal Wiki. */
export async function savePersonalOverview(host:WorkflowHost<"interactive">,actor:AppIdentity,local:ReportChain,runId:string,now:number,order:{organizations:string[];projects:string[]}={organizations:[],projects:[]}):Promise<ReportChain>{
 if(actor.owner.kind!=="user")throw new Response("Personal overview requires a personal installation",{status:403});
 let organizations:Record<string,unknown>[]=[],status=local.status,reason:string|null=null;
 try{
  let after:string|undefined;
  const seen=new Set<string>();
  const rows:z.infer<typeof dailyReportSource>[]=[];
  do {
   const raw=z.object({data:z.object({dailyReports:z.array(dailyReportSource)}),next:z.string().optional(),extensions:z.object({truncated:z.boolean().optional()}).optional()}).parse(await host.call("platform.document",{app:"planning",document:"DailyReports",kind:"query",variables:{date:local.period.date,timezone:local.period.timezone,limit:100,...(after?{cursor:after}:{})}}));
   if(raw.extensions?.truncated)throw new Error("Source reports were truncated");
   rows.push(...raw.data.dailyReports);
   after=raw.next;
   if(after){if(seen.has(after)||seen.size>=100)throw new Error("Daily report cursor did not terminate");seen.add(after);}
  } while(after);
  organizations=rows.filter(row=>row.ownerKind==="organization").map(row=>{
   const parsed=organizationReport.safeParse(row.report);
   if(!parsed.success || parsed.data.owner.id!==row.ownerId || parsed.data.planningInstallationId!==row.planningInstallationId || parsed.data.period.start!==local.period.start || parsed.data.period.end!==local.period.end || parsed.data.period.timezone!==local.period.timezone){status="incomplete";return {organizationSlug:row.organizationSlug,planningInstallationId:row.planningInstallationId,status:"incomplete",reason:"The matching organization report is missing or invalid; no no-change inference was made."};}
   if(parsed.data.status!=="complete")status="incomplete";
   return {organizationSlug:row.organizationSlug,...parsed.data,dependencies:sortByOrder(parsed.data.dependencies,order.projects,item=>`${row.organizationSlug}:${z.object({projectId:z.string()}).parse(item).projectId}`)};
  });
 }catch{status="incomplete";reason="Organization report discovery failed or was incomplete; retry after source outcomes are available.";}
 const goalContext=await capturePersonalGoalContext(host,actor,now);
 if(!goalContext.complete){status="incomplete";reason=[reason,...goalContext.errors].filter(Boolean).join(" ");}
 organizations=sortByOrder(organizations,order.organizations,row=>String(row.organizationSlug));
 const personalProjects=sortByOrder(local.projects,order.projects,row=>`personal:${row.projectId}`);
 const overview=await saveReportNote(host,actor,{level:"personal",subject:actor.owner.id,title:`Personal daily overview — ${local.period.date}`,period:local.period,runId,capturedAt:now,status,content:{summary:`${organizationRollup(organizations)}${personalProjects.length ? ` ${projectRollup(personalProjects)}` : ""}`,outcome:status==="complete"?"source-reports-captured":"source-reports-incomplete",personalProjects,organizations,goalContext,reason,coverage:"Current member-authorized installed Planning organization sources plus personal Planning projects. Organizations without Planning, external connectors and conversation history are outside this capture.",completeness:{sourceReads:status,history:"limited"}}});
 return {...local,overview,status};
}
