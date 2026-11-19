import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { readAppUpdate, writeAppUpdate } from "@ai-outfitter/app-sdk/daily-update";
import type { ReportPeriod } from "./report-period";
import type { ReportChain } from "./report-chain";

export async function collectAppUpdates(host:Pick<WorkflowHost<"interactive">,"call">,actor:AppIdentity,period:ReportPeriod,projects:ReportChain["projects"],runId:string){
 return Promise.all(["Workshop","Software Foundry","Planning","Onto"].map(async app=>{
   try {
     if(app==="Planning")await writeAppUpdate(host,actor,app,period,runId,async()=>({
       rows:projects.map(p=>({project:p.summary.name,summary:p.summary.summary,document:p.report?.slug,revision:p.report?.revision})),
       complete:projects.every(p=>p.status==="complete")
     }));
     const saved=await readAppUpdate(host,app,period);
     if(saved)return saved;
   }catch{/* Each missing source stays visible in the organization overview. */}
   return {app,status:"incomplete" as const,summary:"Daily update unavailable.",report:null};
 }));
}
