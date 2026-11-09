// Explicit local seed update. Does not access a live app database or provider.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type WikiGraph, typeInput } from "@ai-outfitter/app-sdk/graph-contracts";
import { z } from "zod";
import { documentSchema } from "@ai-outfitter/app-sdk/agent-schema";
import { responseMeasurement, quarterlyMeasurement, responseDefinition, quarterlyDefinition } from "./control-measurements";
import { mergePilot, personalControlPilot, organizationControlPilot, personTypeId, pilotId } from "./control-pilots";

const args = process.argv.slice(2);
const option = (name:string) => { const index=args.indexOf(name); if(index<0 || !args[index+1]) throw Error(`Missing ${name}`); return args[index+1]; };
const directory=resolve(option("--data-dir"));
const personalOwner=z.uuid().parse(option("--personal-owner"));
const orgOwner=z.uuid().parse(option("--organization-owner"));
const friendName=option("--friend-name").trim();
if (!friendName || friendName.length>120) throw Error("Invalid friend name");
const personalPath=join(directory,"personal.local.json"), orgPath=join(directory,"wiki-snapshots","outfitter.json");
const [personal,org,types]=await Promise.all([
  readFile(personalPath,"utf8").then(JSON.parse), readFile(orgPath,"utf8").then(JSON.parse),
  readFile(fileURLToPath(new URL("../../onto/seeds/control-pilot-types-v1.json",import.meta.url)),"utf8").then(s=>z.array(typeInput.extend({id:z.uuid()})).parse(JSON.parse(s))),
]);
if(personal.format!=="outfitter-graph-entities-v1" || org.format!=="outfitter-wiki-graph-v1") throw Error("Unsupported private seed format");
const requirePerson=(graph:WikiGraph,id:string)=>{
  const person=graph.nodes.find(n=>n.id===id && n.typeId===personTypeId);
  if(!person)throw Error(`Explicit owner ${id} is not a Person in this destination`);
  return {id,name:person.title};
};
const owner=requirePerson(personal,personalOwner);
requirePerson(org.graph,orgOwner);
const organization=org.graph.nodes.filter((n:WikiGraph["nodes"][number])=>n.title==="Outfitter" && n.typeId==="71000000-0000-4000-8000-000000000001");
if(organization.length!==1)throw Error("Expected one Outfitter organization in its own seed");
const matches=personal.nodes.filter((n:WikiGraph["nodes"][number])=>n.title.toLowerCase()===friendName.toLowerCase() && n.typeId===personTypeId);
if(matches.length>1)throw Error("Ambiguous friend identity; reconcile duplicates first");
const friend=matches[0] ?? {id:pilotId(200),typeId:personTypeId,title:friendName,slug:"control-pilot-friend",body:"Person and friendship explicitly identified by the user for the personal control pilot. No additional biographical facts inferred.",properties:{}};
const personalAdd=personalControlPilot(owner,{id:friend.id,name:friend.title});
personalAdd.types=types;
if(!matches.length)personalAdd.nodes.unshift(friend);
const orgAdd=organizationControlPilot(orgOwner,organization[0].id);orgAdd.types=types;
const nextPersonal={...personal,...mergePilot(personal,personalAdd)};
const nextOrg={...org,graph:{...org.graph,...mergePilot(org.graph,orgAdd)}};
// Explicitly refresh only seeded measurement fields; other authored context stays intact.
if(args.includes("--refresh-measurements") || args.includes("--refresh-structured-controls")){
  const definition=types.find(t=>t.id===pilotId(2))!;
  for(const graph of [nextPersonal,nextOrg.graph]){
    const type=graph.types.find((t:WikiGraph["types"][number])=>t.id===pilotId(2));
    if(type)type.properties=[...type.properties.filter((p:{name:string})=>!definition.properties.some(d=>d.name===p.name)),...definition.properties];
    if (type && args.includes("--refresh-structured-controls")) type.jsonSchema = definition.jsonSchema;
    for(const node of graph.nodes){
      if(node.id===pilotId(203))node.properties={...node.properties,...quarterlyMeasurement};
      if(node.id===pilotId(303))node.properties={...node.properties,...responseMeasurement};
      if(args.includes("--refresh-structured-controls")) {
        if(node.id===pilotId(203))node.body=JSON.stringify(quarterlyDefinition);
        if(node.id===pilotId(303))node.body=JSON.stringify(responseDefinition);
      }
    }
  }
}
// Refuse a schema upgrade that would leave any existing control body invalid.
for(const graph of [nextPersonal,nextOrg.graph]){
  const schema=graph.types.find((t:WikiGraph["types"][number])=>t.id===pilotId(2))?.jsonSchema;
  if(schema) for(const node of graph.nodes.filter((n:WikiGraph["nodes"][number])=>n.typeId===pilotId(2)))
    documentSchema(schema).parse(JSON.parse(node.body));
}
// Both destinations are prepared before writes. Keep exact prior files for recovery.
const backup=join(directory,"control-pilot-backups",new Date().toISOString().replaceAll(":","-"));
await mkdir(backup,{recursive:true});
for(const [path,value,label] of [[personalPath,nextPersonal,"personal.local.json"],[orgPath,nextOrg,"outfitter.json"]] as const){
  const before=await readFile(path,"utf8"),after=JSON.stringify(value,null,2)+"\n";
  if(before===after)continue;
  await writeFile(join(backup,label),before,{mode:0o600});
  await writeFile(path+".control-pilot.tmp",after,{mode:0o600});
  await rename(path+".control-pilot.tmp",path);
}
console.log(JSON.stringify({personal:{friendship:pilotId(201),control:pilotId(203),commitment:pilotId(204)},organization:{control:pilotId(303),commitment:pilotId(304),exampleObligation:pilotId(306)},backup}));
