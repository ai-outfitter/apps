import type {APIRoute} from "astro";
import {actionAPI,defineAction} from "@ai-outfitter/app-sdk/actions";
import {graphProviderDescriptor} from "@ai-outfitter/app-sdk/graph-provider";
import {wikiDocumentsContract} from "@ai-outfitter/app-sdk/wiki-documents";
import {z} from "zod";
import {graphqlAction,mutateAction} from "@ai-outfitter/app-sdk/app-graphql";
import {context} from "../../../../../documents/context";
import {graphqlSchema,type Context} from "../../../../../documents/graphql";
const actions={
 "graph.describe":defineAction({description:"Describe the document Wiki contract.",access:"read",input:z.strictObject({}),output:graphProviderDescriptor,run:()=>({version:1 as const,contracts:[wikiDocumentsContract],capabilities:["documents.read","documents.write"],types:[{name:"WikiDocument",kind:"record" as const},{name:"WikiPage",kind:"record" as const}],queryAction:"graph.graphql" as const})}),
 "graph.graphql":graphqlAction<Context>(graphqlSchema),"graph.mutate":mutateAction<Context>(graphqlSchema),
};
export const ALL:APIRoute=({request,params,locals})=>{
 if(import.meta.env.OUTFITTER_APP_MODE!=="operational")return new Response("Read-only demo",{status:403});
 return actionAPI(request,params.operation ?? "",actions,()=>context(request,locals));
};
