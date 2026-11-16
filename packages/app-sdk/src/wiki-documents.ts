import {z} from "zod";
import type {WorkflowHost} from "./workflow-host";
import {graphGraphqlResult} from "./graph-protocol";

/** The package that holds an owner's documents. The host finds its one installation, so no discovery call is made. */
export const wikiPackage="wiki-map";
/** What the Wiki answers when asked to describe itself. */
export const wikiDocumentsContract={id:"outfitter.wiki-documents",version:1} as const;
type Host=Pick<WorkflowHost<"interactive">,"call">;
/** One request to the owner's document Wiki. An incomplete answer is an error, never a partial read. */
export async function wikiDocuments(host:Host,action:"graph.graphql"|"graph.mutate",query:string,variables:Record<string,unknown>,maxBytes=262144) {
 const result=graphGraphqlResult.parse(await host.call("actions.call",{template:wikiPackage,action,...(action==="graph.graphql"?{readOnly:true}:{}),input:{query,variables:JSON.parse(JSON.stringify(variables)),maxBytes}}));
 if(result.errors?.length||result.extensions?.truncated||!result.data)throw new Response("Wiki read or write was incomplete",{status:502});
 return result.data;
}
const saved=z.object({id:z.string(),installationId:z.string(),revision:z.number(),generatedBody:z.string(),archived:z.boolean()});
export type SavedWikiDocument=z.infer<typeof saved>;
/** The documents saved under these page slugs, in one request. A slug with no page, or no document, reads as null. */
export async function readWikiPages(host:Host,slugs:string[]):Promise<(SavedWikiDocument|null)[]> {
 if(!slugs.length)return [];
 const data=await wikiDocuments(host,"graph.graphql",
  `query SavedPages(${slugs.map((_,index)=>`$s${index}:String!`).join(",")}){${slugs.map((_,index)=>`p${index}:page(slug:$s${index}){document{id installationId revision generatedBody archived}}`).join(" ")}}`,
  Object.fromEntries(slugs.map((slug,index)=>[`s${index}`,slug])));
 return slugs.map((_,index)=>{
  if(!(`p${index}` in data))throw new Response("Wiki read omitted a page",{status:502});
  const page=data[`p${index}`] as {document?:unknown}|null;
  return page?.document?saved.parse(page.document):null;
 });
}
export const readWikiPage=async(host:Host,slug:string)=>(await readWikiPages(host,[slug]))[0];
