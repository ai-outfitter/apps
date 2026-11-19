import { z } from "zod";
import { scheduledAppUpdate } from "@ai-outfitter/app-sdk/daily-update";
import type { ReportPeriod } from "@ai-outfitter/app-sdk/daily-period";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
type Host=WorkflowHost<"schedule">;
const record=z.record(z.string(),z.json());
async function query(host:Host, template:string, query:string, variables:Record<string,string|null>) {
  const result = await host.call("actions.call", {template,action:"graph.graphql",readOnly:true,input:{query,variables,maxBytes:131072}});
  const response = z.object({data:z.record(z.string(),z.unknown()), errors:z.array(z.unknown()).optional(), extensions:z.object({truncated:z.boolean().optional()}).optional()}).parse(result);
  if(response.errors?.length || response.extensions?.truncated) throw new Error("Incomplete source read");
  return response.data;
}

async function evidence(host:Host,period:ReportPeriod){
    const data=await query(host,"software-foundry","query DailyUpdates($since:DateTime!,$until:DateTime!){changes(since:$since,until:$until){changes{repository title url mergedAt kind} complete}}",{since:new Date(period.start).toISOString(),until:new Date(period.end-1).toISOString()});
    const result=z.object({changes:z.array(record),complete:z.boolean()}).parse(data.changes);
    return {rows:result.changes,complete:result.complete};

}

export const dailyWorkflow="software-foundry-daily-update";
export const dailyUpdate=(host:Host,actor:AppIdentity,raw:unknown)=>scheduledAppUpdate(host,actor,raw,"Software Foundry",dailyWorkflow,period=>evidence(host,period));
