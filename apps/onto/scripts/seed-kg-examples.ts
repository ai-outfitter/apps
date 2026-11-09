/** Add-only local examples for the app-owned KG documents. Never runs in production. */
import {readFile,writeFile,copyFile,mkdir,rename} from "node:fs/promises";
import {join} from "node:path";
import {appWorker} from "@ai-outfitter/app-test/worker";
import {drizzle} from "drizzle-orm/d1";
import {withCompiledQuery} from "../src/lib/knowledge-graph-document";
import {standardData} from "../src/lib/standard-data";
import {setupStandardData} from "../src/server/standard-data";
import {refreshKnowledgeGraphQueries} from "../src/server/knowledge-graph-refresh";
import { wikiGraph } from "@ai-outfitter/onto/contracts";
import {defaultTypes} from "../src/lib/default-types";
import releaseExample from "../seeds/release-example-v1.json";

const summary="Synthetic KG example. No real delivery, approval or authority is asserted.";
const id=(n:number)=>`78000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const typeId=(name:string)=>{const row=defaultTypes.find(type=>type.name===name);if(!row)throw new Error(`Missing example type ${name}`);return row.id;};
const node=(n:number,type:string,slug:string,title:string,body:string)=>({id:id(n),typeId:typeId(type),slug,title,summary,body,properties:{},archived:false});
const edge=(n:number,type:string,fromId:string,toId:string)=>({id:id(n),typeId:typeId(type),fromId,toId,properties:{},archived:false});
/** All fictional identities remain distinct from tenant membership and actual decision holders. */
export function kgExamples(organizationId:string){
 const exampleRelease=node(1,"Release","synthetic-kg-release","Synthetic KG: Atlas launch",JSON.stringify({stage:"draft",subheadline:"Synthetic example for local KG inspection",gettingStarted:"Inspect the linked context",inScope:[{statement:"Inspect synthetic linked product context"}],outOfScope:[],headline:"Synthetic Atlas launch",customer:"Fictional workspace administrators",problem:"Disconnected product context",solution:"A connected, reviewable product graph"}));
 const offering=node(2,"Offering","synthetic-kg-offering","Synthetic KG: Atlas offering","Fictional offering for inspecting linked product context.");
 const competitor=node(3,"Organization","synthetic-kg-competitor","Synthetic KG: Example competitor","Fictional competitor for local graph inspection.");
 return wikiGraph.parse({types:defaultTypes,nodes:[{...node(4,"Organization","synthetic-kg-organization","Synthetic KG organization","Fictional organization for isolated examples."),id:organizationId},...releaseExample.nodes,exampleRelease,offering,competitor],edges:[...releaseExample.edges,
  edge(101,"offered_by",offering.id,organizationId),edge(102,"packages_product",offering.id,releaseExample.nodes[0].id),
  edge(103,"announces",exampleRelease.id,offering.id),edge(104,"delivered_as",exampleRelease.id,"77000000-0000-4000-8000-000000000008"),
 ]});
}

type LocalDatabase=Awaited<ReturnType<typeof appWorker>>["database"];
async function legacyProjections(db:LocalDatabase){
  const definitions=await db.prepare("SELECT id,body,properties FROM graph_nodes WHERE typeId=? AND archived=0").bind(typeId("KnowledgeGraph")).all<{id:string;body:string;properties:string}>();
  for(const row of definitions.results){
   let body;try{body=JSON.parse(row.body);}catch{continue;}
   if(!body.selection||!body.rootTypes?.length)continue;
   const properties=JSON.parse(row.properties);
   const next={root_type:body.rootTypes[0],pattern:JSON.stringify({relationships:body.selection.relationships,max_depth:body.selection.maxDepth}),...properties};
   if(JSON.stringify(next)!==JSON.stringify(properties))await db.prepare("UPDATE graph_nodes SET properties=? WHERE id=? AND properties=?").bind(JSON.stringify(next),row.id,row.properties).run();
  }
}
/** The compiled body for a legacy row that exactly matches its standard definition, or undefined. */
function legacyDefinition(row:Record<string,unknown>,standard:(typeof standardData.nodes)[number]|undefined){
 if(!standard || row.title!==standard.title || String(row.summary??"")!==String(standard.summary??"") || String(row.body??"").length>2000)return;
 try{JSON.parse(String(row.body));return;}catch{}
 const properties=JSON.parse(String(row.properties));
 if(!properties.root_type||!properties.pattern)return;
 const pattern=JSON.parse(properties.pattern);
 // A matching slug alone is never authority to adopt an imported selection.
 const expected=JSON.parse(standard.body);
 if(JSON.stringify([properties.root_type])!==JSON.stringify(expected.rootTypes)
   || JSON.stringify(pattern.relationships)!==JSON.stringify(expected.selection?.relationships)
   || pattern.max_depth!==expected.selection?.maxDepth)return;
 const body={name:row.title,purpose:row.body,rootTypes:[properties.root_type],selection:{relationships:pattern.relationships,maxDepth:pattern.max_depth,maxNodes:200}};
 const next=withCompiledQuery({...row,body:JSON.stringify(body)},defaultTypes);
 return JSON.parse(next.body).query?next:undefined;
}
/** Compile legacy selection properties without losing the old prose or source attribution. */
async function compileLegacyDefinitions(db:LocalDatabase,dataDirectory:string,scope:string){
 const rows=await db.prepare("SELECT * FROM graph_nodes WHERE typeId=? AND archived=0").bind(typeId("KnowledgeGraph")).all<Record<string,unknown>>();
 const standards=new Map(standardData.nodes.filter(node=>node.typeId===typeId("KnowledgeGraph")).map(node=>[node.slug,node]));
 for(const row of rows.results){
  const next=legacyDefinition(row,standards.get(String(row.slug)));
  if(!next)continue;
  const directory=join(dataDirectory,"app-snapshots",scope);await mkdir(directory,{recursive:true});
  await writeFile(join(directory,`kg-legacy-provenance-${row.id}-${Date.now()}.json`),JSON.stringify(row,null,2),{mode:0o600});
  await db.prepare("UPDATE graph_nodes SET body=?,createdBy=?,updatedBy=?,revision=revision+1,updatedAt=? WHERE id=? AND revision=? AND body=?").bind(next.body,"seed:wiki-standard-data","seed:wiki-standard-data",Date.now(),row.id,row.revision,row.body).run();
 }
}

const definitionContent=(body:string)=>{
 const {query:_query,hash:_hash,variables:_variables,...content}=JSON.parse(body);
 return JSON.stringify(content);
};
/** Adopt only byte-equivalent standard definitions, with original provenance backed up.
 * This is explicit local example setup, never general trust for imported authors. */
export async function adoptStandardDefinitions(db:LocalDatabase,dataDirectory:string,scope:string){
 const rows=await db.prepare("SELECT * FROM graph_nodes WHERE typeId=? AND archived=0").bind(typeId("KnowledgeGraph")).all<Record<string,unknown>>();
 const standards=new Map(standardData.nodes.filter(node=>node.typeId===typeId("KnowledgeGraph")&&!node.archived).map(node=>[node.slug,node]));
 const adopted=rows.results.filter(row=>{
  const standard=standards.get(String(row.slug));
  if(!standard || row.title!==standard.title || String(row.summary??"")!==String(standard.summary??"") || row.createdBy==="seed:wiki-standard-data")return false;
  try{return definitionContent(String(row.body))===definitionContent(standard.body);}catch{return false;}
 });
 if(!adopted.length)return;
 const directory=join(dataDirectory,"app-snapshots",scope);await mkdir(directory,{recursive:true});
 await writeFile(join(directory,`kg-standard-provenance-${Date.now()}.json`),JSON.stringify(adopted,null,2),{mode:0o600});
 await db.batch(adopted.map(row=>db.prepare("UPDATE graph_nodes SET createdBy=?,updatedBy=?,revision=revision+1,updatedAt=? WHERE id=? AND revision=? AND body=?").bind("seed:wiki-standard-data","seed:wiki-standard-data",Date.now(),row.id,row.revision,row.body)));
}

type Installation={template:string;packagePath:string;owner:{kind:string;organization?:{slug:string;sourceId:string}}};
export async function seedKGExamples(configPath:string,scope:string){
 if(process.env.NODE_ENV==="production")throw new Error("KG examples are local development only");
 const config=JSON.parse(await readFile(configPath,"utf8")) as {runtimeDirectory:string;dataDirectory:string;installations:Record<string,Installation>};
 const matches=Object.entries(config.installations).filter(([,row])=>row.template==="onto"&&row.owner.kind==="organization"&&row.owner.organization?.slug===scope);
 if(matches.length!==1||!config.runtimeDirectory)throw new Error("Choose one persistent local organization Wiki");
 const [installationId,installation]=matches[0];
 const worker=await appWorker("onto",installation.packagePath,installationId,{persistencePath:join(config.runtimeDirectory,"apps",installationId)});
 try{
  const identity={userId:"local-seed",installationId,owner:{kind:"user" as const,id:"local-seed"},role:"owner",canEdit:true};
  const db=worker.database;
  const adapter={query:async({sql,params}:{sql:string;params?:unknown[]})=>(await db.prepare(sql).bind(...(params??[])).all<Record<string,unknown>>()).results,batch:async(statements:{sql:string;params?:unknown[]}[])=>db.batch(statements.map(({sql,params})=>db.prepare(sql).bind(...(params??[]))))};
  // Standard setup preserves authored records. The example graph is separately opt-in.
  await setupStandardData(adapter,identity).catch(async error=>{throw new Error(`Standard setup: ${error instanceof Response?await error.text():String(error)}`);});
  const org=await db.prepare("SELECT id FROM graph_nodes WHERE slug=? AND typeId=? AND archived=0").bind(scope,typeId("Organization")).first<{id:string}>();
  if(!org)throw new Error("The organization needs its own Wiki root before example seeding");
  const examples=kgExamples(org.id);
  const nodes=[...new Map([...standardData.nodes,...examples.nodes].map(node=>[node.id,node])).values()];
  await setupStandardData(adapter,identity,{types:standardData.types,nodes,edges:[...standardData.edges,...examples.edges]}).catch(async error=>{throw new Error(`KG examples: ${error instanceof Response?await error.text():String(error)}`);});
  await compileLegacyDefinitions(db,config.dataDirectory,scope);
  await legacyProjections(db);
  await adoptStandardDefinitions(db,config.dataDirectory,scope);
  const refreshed=await refreshKnowledgeGraphQueries(drizzle(db));
  const currentKG=await db.prepare("SELECT id,slug,body,properties FROM graph_nodes WHERE typeId=? AND archived=0 AND createdBy=? AND updatedBy=?").bind(typeId("KnowledgeGraph"),"seed:wiki-standard-data","seed:wiki-standard-data").all<{id:string;slug:string;body:string;properties:string}>();
  const compiled=new Map(currentKG.results.map(row=>[row.slug,row]));
  const savedNodes=nodes.map(node=>{const row=compiled.get(node.slug??"");return row?{...node,id:row.id,body:row.body,properties:JSON.parse(row.properties)}:node;});
  const graph=wikiGraph.parse({types:standardData.types,nodes:savedNodes,edges:[...standardData.edges,...examples.edges]});
  const directory=join(config.dataDirectory,"app-snapshots",scope);await mkdir(directory,{recursive:true});
  const path=join(directory,"wiki-kg-examples.json");
  try{await copyFile(path,`${path}.before-${Date.now()}`);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  await writeFile(`${path}.tmp`,JSON.stringify({format:"outfitter-kg-examples-local-v1",graph},null,2)+"\n",{mode:0o600});await rename(`${path}.tmp`,path);
  console.log(JSON.stringify({scope,exampleNodes:releaseExample.nodes.length+3,refreshed,supplementSaved:true}));
 }finally{await worker.dispose();}
}
if(import.meta.main){const [config,scope]=process.argv.slice(2);if(!config||!scope)throw new Error("Pass installations.json and an organization slug");await seedKGExamples(config,scope);}
