import type { Project } from "../lib/project";
import { bomRows,bomTotals,AssemblySchema,type Item,type Assembly } from "../lib/assembly";
import type { BuildRequest } from "../lib/workspace";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { boxPlan } from "../model/cad-plan";
import { appBase, projectPath, projectSlug, slugId } from "../lib/sections";
async function start(signal:AbortSignal){
const root=document.querySelector<HTMLElement>(".workspace");
if(!root)return;
const section=root.dataset.section;
const $=<T extends HTMLElement=HTMLElement>(id:string)=>root.querySelector<T>(`#${id}`)!;
const element=(tag:string,text:string)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const notice=(s:string)=>$("workspace-notice").textContent=s;
let singlePart=false;
let project:Project,assembly:Assembly,selected:Item|undefined,build:BuildRequest|undefined;
const viewerModule=section==="assembly"?await import("./assembly-viewer"):undefined;
if(signal.aborted)return;
const viewer=viewerModule?.createAssemblyViewer($<HTMLCanvasElement>("assembly-viewer"),s=>$("assembly-status").textContent=s);
signal.addEventListener("abort",()=>viewer?.dispose(),{once:true});
const request=async(path:string,method="GET",body?:unknown)=>{const r=await fetch(path,{signal,method,headers:body?{"Content-Type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(await r.text());return r.json();};
function select(item:Item){selected=item;viewer?.select(item.id);const details=$("item-details");details.replaceChildren(element("h3",item.name),element("p",`${item.number} · revision ${item.revision} · ${item.kind}`),element("p",item.notes),element("p",`Geometry: ${item.provenance}. Price: ${item.priceKnown?`$${item.unitCost}`:"unpriced"}`));if(item.source){const a=element("a",`${item.manufacturer} ${item.mpn} — source`) as HTMLAnchorElement;a.href=item.source;a.target="_blank";a.rel="noopener";details.append(a);}($<HTMLDetailsElement>("inspector")).open=true;}
function renderBom(){
 const mode=$<HTMLSelectElement>("bom-mode").value;
 const rows=mode==="hierarchy"?bomRows(assembly):bomTotals(assembly).lines.filter(r=>r.item.kind!=="assembly"&&(mode!=="cots"||r.item.kind==="cots")).map(r=>({...r,depth:0}));
 $("bom-rows").replaceChildren(...rows.map(({item,quantity,depth})=>{const row=element("article","");row.className="bom-row";const title=element("div","");const button=element("a",item.name) as HTMLAnchorElement;button.href=appBase(location.pathname)+projectPath(projectSlug(project),"assembly");title.append(button,element("small",`${"↳ ".repeat(Math.min(depth,3))}${item.number} · ${item.revision}`));const info=element("div",`${item.kind} · ${item.priceKnown?`$${item.unitCost}`:"Unpriced"}`);info.append(element("small",[item.manufacturer,item.mpn,item.provenance].filter(Boolean).join(" · ")));row.append(title,element("span",`Qty ${quantity}`),info);return row;}));
}
function showBuild(run?:BuildRequest){
 build=run;assembly=run?.result?.manifest?.assembly??project.assembly;
 $("revision-label").textContent=run?`${run.id.slice(0,8)} · ${run.id===project.workspace?.currentBuildId?"Current":"Historical"}`:`Project save ${project.revision}`;
 singlePart=!assembly.rootId;
 if(singlePart)assembly=AssemblySchema.parse({rootId:"ffffffff-ffff-4fff-8fff-ffffffffffff",items:[{id:"ffffffff-ffff-4fff-8fff-ffffffffffff",number:"ASSEMBLY",revision:"A",name:project.name,kind:"assembly",uses:[{id:"ffffffff-ffff-4fff-8fff-fffffffffffe",itemId:project.id,quantity:1}]},{id:project.id,number:"MODEL",revision:"A",name:project.name,kind:"fabricated",geometry:project.cadPlan??boxPlan(project.params.width,project.params.depth,project.params.height)}]});
 void viewer?.render(assembly,run?.result?.artifactBase??"",singlePart?{params:project.params,plan:project.cadPlan}:undefined);
 $("component-tree").replaceChildren(...bomRows(assembly).map(({item,depth,quantity})=>{const b=element("button",`${"↳ ".repeat(Math.min(depth,3))}${item.name} ×${quantity}`);b.className="component-row";b.onclick=()=>select(item);return b;}));
 const manifest=run?.result?.manifest;
 $<HTMLTextAreaElement>("parameter-values").value=JSON.stringify(manifest?.parameters??{},null,2);
 $("source-files").replaceChildren();$("source-preview").textContent="";
 for(const artifact of manifest?.artifacts??[]){const url=run!.result!.artifactBase+artifact.path;const a=element("a",artifact.path.split('/').at(-1)!) as HTMLAnchorElement;a.href=url;a.download=artifact.path.split('/').at(-1)!;$("source-files").append(a);if(/\.(scad|json|md|py)$/.test(artifact.path)){const b=element("button",`Read ${a.textContent}`);b.onclick=async()=>{$("source-preview").textContent=await (await fetch(url,{signal})).text();};$("source-files").append(b);}}
 const evidence=$("revision-evidence");evidence.replaceChildren(element("h3",run?`Build ${run.id.slice(0,8)}`:"No workspace build yet"));

 if(import.meta.env.OUTFITTER_APP_MODE !== "demo" && (!run || run.id===project.workspace?.currentBuildId)) {
  const captureUrl=`/api/apps/workshop/projects/${project.id}/preview?revision=${project.revision}&evidence=1`;
  void fetch(captureUrl).then(async response=>{
   if(!response.ok)return;
   const capture=await response.json();
   if(build?.id!==run?.id)return;
   const section=element("div","");section.append(element("h3","Visual evidence"));
   const record=element("a","Capture record") as HTMLAnchorElement;record.href=captureUrl;section.append(record);
   for(const artifact of capture.artifacts){const a=element("a",` ${artifact.kind} screenshot`) as HTMLAnchorElement;a.href=`/files/main/builds/${artifact.key}`;a.target="_blank";a.rel="noopener";section.append(a);}
   section.append(element("p",capture.limitations));evidence.append(section);
  }).catch(()=>{});
 }

 if(manifest){const download=element("a","Download revision bundle") as HTMLAnchorElement;download.href=`/api/apps/workshop/projects/${project.id}/bundle?build=${run!.id}`;evidence.append(download);evidence.append(element("p",`${manifest.runner} · ${manifest.compiler}`),element("p",`Source commit: ${manifest.sourceCommit}`),element("p",manifest.notes));for(const t of manifest.tests)evidence.append(element("p",`${t.status.toUpperCase()} · ${t.name}: ${t.detail}`));}
 if(run?.result?.error)evidence.append(element("p",run.result.error));renderBom();
}
function render(){
 if(import.meta.env.OUTFITTER_APP_MODE==="demo")for(const node of $("build-request").querySelectorAll<HTMLInputElement>("input,button"))node.disabled=true;
 $("project-name").textContent=project.name;
 $("build-request").hidden=!project.workspace;
 const runs=project.workspace?.requests??[];$("runner-status").textContent=runs.length?`${runs.at(-1)!.status} · runner ${runs.at(-1)!.runner}`:"No workspace connected. Existing CAD remains inspectable.";
 $("revision-help").textContent="Build records preserve their inputs and evidence. Private downloads are retained for one year; source stays in the project repository. Geometry checks do not establish physical acceptance.";
 $("revision-list").replaceChildren(...[...runs].reverse().map(r=>{const row=element("article","");row.className="run-row";const b=element("button",`${r.id.slice(0,8)} · ${r.status}${r.result?.stale?" · newer work exists":""}`);b.onclick=()=>showBuild(r);row.append(b,element("p",r.instructions),element("small",`${r.createdAt} · ${r.sourceCommit}`));return row;}));
 showBuild(runs.find(r=>r.id===project.workspace?.currentBuildId));
}
$("reset-view").onclick=()=>viewer?.reset();$("show-all").onclick=()=>{viewer?.isolate();viewer?.select();$<HTMLDetailsElement>("inspector").open=false;};$("isolate-item").onclick=()=>{if(selected){const descendants=new Set<string>();const walk=(i:Item)=>{descendants.add(i.id);for(const use of i.uses){const child=assembly.items.find(c=>c.id===use.itemId);if(child)walk(child);}};walk(selected);viewer?.isolate(descendants);}};
$("bom-mode").onchange=renderBom;
$("build-request").onsubmit=async(e)=>{e.preventDefault();try{const w=project.workspace;const previous=build??w?.requests.at(-1);if(!w||!previous)throw Error("Connect a project workspace through RequestWorkshopBuild first.");const parameters=JSON.parse($<HTMLTextAreaElement>("parameter-values").value);project=await request(`/api/apps/workshop/projects/${project.id}/builds`,"POST",{id:project.id,revision:project.revision,repository:w.repository,sourceDir:w.sourceDir,sourceCommit:previous.result?.manifest?.sourceCommit??previous.sourceCommit,instructions:$<HTMLInputElement>("instruction").value,parameters,runner:previous.runner});if(signal.aborted)return;render();notice("Build queued. The workspace runner must claim and execute it.");}catch(e){if(!signal.aborted)notice((e as Error).message);}};
$("model-panel").hidden=section==="parts"||section==="release";$("bom-panel").hidden=section!=="parts";$("revisions-panel").hidden=section!=="release";
try{const projects:Project[]=import.meta.env.OUTFITTER_APP_MODE==="demo"?(await import("./fixtures")).fixtureProjects:await request("/api/apps/workshop/projects");if(signal.aborted)return;const key=slugId(root.dataset.slug!);const found=key?projects.find(p=>p.id.endsWith(key)):undefined;if(!found)throw Error("Project not found");project=import.meta.env.OUTFITTER_APP_MODE==="demo"?found:await request(`/api/apps/workshop/projects/${found.id}`);if(signal.aborted)return;render();}catch(e){if(!signal.aborted)notice((e as Error).message);}

}
onPageLoad(signal=>{void start(signal);});
