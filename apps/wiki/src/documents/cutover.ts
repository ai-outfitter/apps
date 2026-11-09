import type {AgentDatabase} from "@ai-outfitter/app-sdk/agent-store";
import {canonicalJSON} from "@ai-outfitter/app-sdk/proposal-store";
import {sha256Hex,type AppIdentity} from "@ai-outfitter/app-sdk/server";
import {defaultWiki} from "@ai-outfitter/app-sdk/graph-client";
import type {WorkflowHost} from "@ai-outfitter/app-sdk/workflow-host";
import {z} from "zod";
import {legacyBaselineDigest} from "./legacy-baseline";

/** Only legacy tables participate; document writes never invalidate the cutover receipt. */
export async function legacyGraphDigest(db:AgentDatabase) {
 const tables=await db.query({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'graph_%' ORDER BY name"});
 const snapshot=[];
 for(const table of tables){
  const name=String(table.name);
  if(!/^graph_[a-z_]+$/.test(name))throw new Error("Invalid legacy table");
  const rows=await db.query({sql:`SELECT * FROM "${name}"`});
  snapshot.push([name,rows.map(canonicalJSON).sort()]);
 }
 return sha256Hex(canonicalJSON(snapshot));
}
/** A fresh legacy baseline contains static seed rows, not a member's graph. */
export async function requireGraphCutover(db:AgentDatabase,who:AppIdentity,host:WorkflowHost<"interactive">) {
 if(await legacyGraphDigest(db)===legacyBaselineDigest)return;
 const onto=await defaultWiki(host);
 const result=z.object({sourceInstallationIds:z.array(z.string())}).parse(await host.call("actions.call",{installationId:onto.installationId,action:"graph.cutover-status",input:{},readOnly:true}));
 if(!result.sourceInstallationIds.includes(who.installationId))throw new Response("Migrate this Wiki graph into Onto before converting its pages",{status:409});
}
