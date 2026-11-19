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

const pageInfo=z.object({hasNextPage:z.boolean(),endCursor:z.string().nullable()});
async function evidence(host:Host,period:ReportPeriod){
 const field="changeBatches";
 const fields="id title state";
  const rows:z.infer<typeof record>[]=[];
  let cursor:string|null=null;
  for(let page=0;page<20;page++){
    const data=await query(host,"onto",`query DailyUpdates($after:String){${field}(first:100,after:$after){nodes{${fields} updatedAt} pageInfo{hasNextPage endCursor}}}`,{after:cursor});
    const result=z.object({nodes:z.array(record),pageInfo}).parse(data[field]);
    for(const row of result.nodes){
      const time=Date.parse(z.string().parse(row.updatedAt));
      if(!Number.isFinite(time)) throw new Error("Invalid source date");
      if(time>=period.start && time<period.end) rows.push(row);
    }
    if(!result.pageInfo.hasNextPage)return {rows,complete:true};
    if(!result.pageInfo.endCursor || result.pageInfo.endCursor===cursor)break;
    cursor=result.pageInfo.endCursor;
  }
  return {rows,complete:false};
}


export const dailyWorkflow="onto-daily-update";
export const dailyUpdate=(host:Host,actor:AppIdentity,raw:unknown)=>scheduledAppUpdate(host,actor,raw,"Onto",dailyWorkflow,period=>evidence(host,period));
