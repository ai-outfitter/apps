import type {WorkflowHost} from "./workflow-host";
import {discoverGraphProviders} from "./graph-provider";
import {graphGraphqlResult} from "./graph-protocol";

export const wikiDocumentsContract={id:"outfitter.wiki-documents",version:1} as const;
type Host=Pick<WorkflowHost<"interactive">,"call">;
/** Discover the caller's owner-scoped document Wiki independently of graph storage. */
export async function documentWiki(host:Host) {
 const providers=(await discoverGraphProviders(host)).filter(provider=>provider.contracts.some(contract=>contract.id===wikiDocumentsContract.id&&contract.version===wikiDocumentsContract.version));
 if(providers.length!==1)throw new Response("One compatible document Wiki is required",{status:409});
 return providers[0];
}
export async function readWikiDocument(host:Host,id:string,revision?:number) {
 const wiki=await documentWiki(host);
 const result=graphGraphqlResult.parse(await host.call("actions.call",{installationId:wiki.installationId,action:"graph.graphql",readOnly:true,input:{query:"query WikiDocument($id:ID!,$revision:Int){document(id:$id,revision:$revision){id title summary body generatedBody revision publishedRevision}}",variables:{id,...(revision?{revision}:{})}}}));
 if(result.errors?.length||result.extensions?.truncated)throw new Response("Document read was incomplete",{status:502});
 return result.data?.document;
}
