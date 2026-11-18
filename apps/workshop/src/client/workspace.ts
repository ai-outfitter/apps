import { onPageLoad } from "@ai-outfitter/ui/page";
import type { ResolvedAssembly } from "../lib/assembly-resolution";
import { boxPlan } from "../model/cad-plan";
import { renderPowerPanel } from "./power-panel";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { savedDriveMotion, type PlacedRotation } from "../lib/saved-drive-motion";
import { arteraDriveReview } from "../lib/artera-drive-review";
import { arteraMotionPreview } from "../lib/artera-motion-preview";
import type { Project } from "../lib/project";
import { bomRows,bomTotals,AssemblySchema,BuildAssemblySchema,type Item,type Assembly } from "../lib/assembly";
import type { BuildRequest } from "../lib/workspace";
import { modelCatalog, modelView, assemblyChildren, assemblyPath } from "../lib/model-catalog";
import { appBase, projectPath } from "../lib/sections";
async function start(signal:AbortSignal){
const root=document.querySelector<HTMLElement>(".workspace");
if(!root)return;
const section=root.dataset.section;
const $=<T extends HTMLElement=HTMLElement>(id:string)=>root.querySelector<T>(`#${id}`)!;
const element=(tag:string,text:string)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const notice=(s:string)=>$("workspace-notice").textContent=s;
let legacy=false, historical=false;
const query = new URLSearchParams(location.search);
const selection = new URLSearchParams();
for(const key of ["revision","configuration","parameters"]) if(query.has(key)) selection.set(key,query.get(key)!);
const sourceUrl = (source: ResolvedAssembly["sources"][number]) => {
 const params=new URLSearchParams();
 if(source.pinned)params.set("revision",String(source.revision));
 if(source.configuration)params.set("configuration",source.configuration);
 if(source.parameters)params.set("parameters",JSON.stringify(source.parameters));
 return appBase(location.pathname)+projectPath(source.projectId.slice(-12),"assembly")+(params.size?"?"+params:"");
};
const urlFor = (section: "models" | "assembly", item?: string) => {
 const params = new URLSearchParams(selection);
 if (item) params.set("item", item);
 if (build && historical) params.set("build", build.id);
 return appBase(location.pathname) + projectPath(root.dataset.slug!, section) + (params.size ? "?" + params : "");
};
function renderCatalog() {
 if (!assembly) return;
 const rows = modelCatalog(assembly, $<HTMLInputElement>("model-search").value, $<HTMLSelectElement>("model-filter").value);
 $("models-summary").textContent = `${rows.length} of ${assembly.items.length} items · ${assembly.items.filter(item => item.kind === "assembly").length} assemblies`;
 $("models-empty").hidden = rows.length !== 0;
 $("model-catalog").replaceChildren(...rows.map(({item, quantity, modeled}) => {
  const card = element("article", ""); card.className = "model-card"; card.dataset.itemId = item.id;
  card.append(element("small", `${item.number} · ${item.kind}`), element("h3", item.name), element("p", quantity ? `Qty ${quantity} in full assembly` : "Not placed in full assembly"), element("small", [item.manufacturer, item.mpn].filter(Boolean).join(" · ")), element("p", modeled ? "3D model available" : "Awaiting geometry"));
  const link = element("a", modeled ? "View model" : "View part details") as HTMLAnchorElement; link.href = urlFor("assembly", item.id); card.append(link); return card;
 }));
}
let resolved: ResolvedAssembly | undefined;
let project:Project,assembly:Assembly,selected:Item|undefined,build:BuildRequest|undefined;
let viewer: ReturnType<typeof import("./assembly-viewer").createAssemblyViewer> | undefined;
if (section === "assembly") {
 try {
  const { createAssemblyViewer } = await import("./assembly-viewer");
  if (signal.aborted) return;
  viewer = createAssemblyViewer($<HTMLCanvasElement>("assembly-viewer"), message => $("assembly-status").textContent = message, id => {
    const item = assembly?.items.find(candidate => candidate.id === id);
    if (item) select(item);
  });
 } catch {
  if (signal.aborted) return;
  $("assembly-status").textContent = "3D preview unavailable in this browser.";
  $("assembly-viewer").hidden = true;
  $("view-tools").hidden = true;
  $("isolate-item").hidden = true;
 }
}
let motionFrame = 0, motionOffset = 0;
let driveReview: ReturnType<typeof arteraDriveReview> | undefined;
let motion: ReturnType<typeof arteraMotionPreview>;
let savedRotations: PlacedRotation[]=[];
let motionGeneration=0;
const stopMotion=()=>{cancelAnimationFrame(motionFrame);motionFrame=0;$("motion-play").textContent="Play motion";};
signal.addEventListener("abort",()=>{motionGeneration++;stopMotion();viewer?.dispose();},{once:true});
const applyMotion=(offset:number)=>{motionOffset=offset;if(motion)viewer?.previewTranslation(motion.paths,offset,savedRotations);$("drive-turns").textContent=`Z shaft turns from saved pose: ${(offset/70).toFixed(2)} · X and Y held stationary`;};
$<HTMLInputElement>("inspect-drive").onchange=()=>{viewer?.inspectDrive(driveReview?.drives??[],$<HTMLInputElement>("inspect-drive").checked);applyMotion(motionOffset);};
$("motion-level").onchange=()=>{stopMotion();if($<HTMLSelectElement>("motion-level").value===""){applyMotion(0);return;}const level=motion?.levels[Number($<HTMLSelectElement>("motion-level").value)];if(level)applyMotion(level.offset);};
$("motion-reset").onclick=()=>{stopMotion();applyMotion(0);$<HTMLSelectElement>("motion-level").value="";};
$("motion-play").onclick=()=>{
 if(motionFrame){stopMotion();return;}
 if(!motion)return;
 $("motion-play").textContent="Pause motion";
 $<HTMLSelectElement>("motion-level").value="";
 let last=performance.now(),direction=1;
 const animate=(now:number)=>{
  if(!motion)return;
  const low=motion.levels[0].offset,high=motion.levels.at(-1)!.offset;
  let next=motionOffset+direction*(high-low)*Math.min(now-last,100)/8000;last=now;
  if(next>=high){next=high;direction=-1;}if(next<=low){next=low;direction=1;}
  applyMotion(next);motionFrame=requestAnimationFrame(animate);
 };
 motionFrame=requestAnimationFrame(animate);
};
const request=async(path:string,method="GET",body?:unknown)=>{const r=await fetch(path,{signal,method,headers:body?{"Content-Type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(await r.text());return r.json();};
function select(item:Item){selected=item;viewer?.select(item.kind==="assembly"?undefined:item.id);$<HTMLAnchorElement>("open-component").href=urlFor("assembly",item.id);const details=$("item-details");details.replaceChildren(element("h3",item.name),element("p",`${item.number} · revision ${item.revision} · ${item.kind}`),element("p",item.notes),element("p",`Geometry: ${item.provenance}. Price: ${item.priceKnown?`$${item.unitCost}`:"unpriced"}`));const source = !historical && resolved?.sources.find(s=>s.itemId===item.id);
if(source){const a=element("a",`Open ${source.name} · revision ${source.revision}${source.configuration ? " · "+source.configuration : ""}`) as HTMLAnchorElement;
a.href=sourceUrl(source);details.append(a);}
if(item.source){const a=element("a",`${item.manufacturer} ${item.mpn} — source`) as HTMLAnchorElement;a.href=item.source;a.target="_blank";a.rel="noopener";details.append(a);}($<HTMLDetailsElement>("inspector")).open=true;}
function renderBom(){
 if (!assembly) return;
 const mode=$<HTMLSelectElement>("bom-mode").value;
 const rows=mode==="hierarchy"?bomRows(assembly):bomTotals(assembly).lines.filter(r=>r.item.kind!=="assembly"&&(mode!=="cots"||r.item.kind==="cots")).map(r=>({...r,depth:0}));
 $("bom-rows").replaceChildren(...rows.map(({item,quantity,depth})=>{const row=element("article","");row.className="bom-row";const title=element("div","");const button=element("button",item.name);button.onclick=()=>{select(item);$("model-panel").hidden=false;};title.append(button,element("small",`${"↳ ".repeat(Math.min(depth,3))}${item.number} · ${item.revision}`));const info=element("div",`${item.kind} · ${item.priceKnown?`$${item.unitCost}`:"Unpriced"}`);info.append(element("small",[item.manufacturer,item.mpn,item.provenance].filter(Boolean).join(" · ")));row.append(title,element("span",`Qty ${quantity}`),info);return row;}));
}
function showBuild(run?:BuildRequest, snapshot=false){
 const motionVersion=++motionGeneration;savedRotations=[];
 stopMotion();motion=undefined;motionOffset=0;$("motion-preview").hidden=true;
 build=run;historical=snapshot || Boolean(run && run.id!==project.workspace?.currentBuildId);
 const parsed=(historical?BuildAssemblySchema:AssemblySchema).safeParse(historical?(run?.result?.manifest?.assembly??{items:[]}):project.assembly);
 assembly=(!historical && resolved?.assembly) || (parsed.success?parsed.data:{items:[]});
 if(!parsed.success)notice("This assembly failed validation; its geometry and power cannot be displayed.");
 else if(historical&&!run?.result?.manifest?.assembly)notice("This build has no saved assembly. Current project data is not shown here.");
 $("revision-label").textContent=run?`${run.id.slice(0,8)} · ${run.id===project.workspace?.currentBuildId?"Current":"Historical"}`:`Project save ${project.revision}`;
 legacy=parsed.success&&!historical&&!assembly.rootId;
 if(legacy)assembly=AssemblySchema.parse({rootId:"ffffffff-ffff-4fff-8fff-ffffffffffff",items:[{id:"ffffffff-ffff-4fff-8fff-ffffffffffff",number:"ASSEMBLY",revision:"A",name:project.name,kind:"assembly",uses:[{id:"ffffffff-ffff-4fff-8fff-fffffffffffe",itemId:project.id,quantity:1}]},{id:project.id,number:"MODEL",revision:"A",name:project.name,kind:"fabricated",geometry:project.cadPlan??boxPlan(project.params.width,project.params.depth,project.params.height)}]});
 const focused = assembly.items.find(item => item.id === query.get("item"));
 const view = modelView(assembly, focused?.id);
 const references=$("assembly-references");
 references.hidden=historical || !resolved?.sources.length;
 if(!references.hidden && resolved){
  const links=resolved.sources.map(s=>{
   const a=element("a",`${s.name} · ${s.pinned?"pinned":"current"} revision ${s.revision}${s.configuration ? " · "+s.configuration : ""}`) as HTMLAnchorElement;
   a.href=sourceUrl(s);
   return a;
  });
  references.replaceChildren(element("h3","Source assemblies"),...links.map(a=>{const p=element("p","");p.append(a);return p;}));
 }
 $("assembly-title").textContent = focused?.name ?? "Full assembly";
 renderPowerPanel($("power-panel"),assembly,focused?.id??assembly.rootId,
  !historical && !selection.size && import.meta.env.OUTFITTER_APP_MODE!=="demo" ? async next=>{
   const editable = structuredClone(project.assembly);
   if (resolved) {
    for (const local of editable.items) {
     if (local.power) local.power = next.items.find(i=>i.id===local.id)?.power;
    }
   }
   const saved = resolved ? editable : next;
   const receipt=await request(`/api/apps/workshop/projects/${project.id}/assembly`,"PUT",{expectedRevision:project.revision,assembly:saved});
   project.revision=receipt.revision;
   project.assembly=saved;
   assembly=next;
   if(resolved)resolved.assembly=next;
   $("revision-label").textContent=`Project save ${project.revision}${build?` · geometry build ${build.id.slice(0,8)}`:""}`;notice(`Power values saved with assembly revision ${project.revision}. Derived climate assumptions must be recalculated in the source budget if loads change.`);
  }:undefined, resolved && !historical ? new Set(project.assembly.items.filter(i=>!i.reference).map(i=>i.id)) : undefined);
 if(selection.size && !historical) $("revision-label").textContent=`Source revision ${resolved?.revision ?? project.revision}${selection.get("configuration") ? " · "+selection.get("configuration") : ""}`;
 else if(!historical)$("revision-label").textContent=`Project save ${project.revision}${run?` · geometry build ${run.id.slice(0,8)}`:""}`;
 $<HTMLAnchorElement>("open-assembly").href=urlFor("assembly");
 $<HTMLAnchorElement>("full-assembly").href=urlFor("assembly");
 $<HTMLAnchorElement>("browse-models").href=urlFor("models");
 if(query.has("item")&&!focused&&assembly.items.length)notice("That item is not in this revision. Showing the full assembly.");
 const preview=arteraMotionPreview(assembly,view,run?.result?.manifest?.parameters??{});
 void viewer?.render(view,run?.result?.artifactBase??"",legacy?{params:project.params,plan:project.cadPlan}:undefined,run?.result?.manifest?.artifacts??[],signal,historical?{}:resolved?.meshes).then(async()=>{
  if(motionVersion!==motionGeneration || build!==run || $("assembly-viewer").dataset.ready!=="true")return;
  if(query.get("view")==="top") viewer?.topView();
  const motionArtifact=run?.result?.manifest?.artifacts.find(a=>a.path.endsWith("/drive-motion.json"));
  motion=motionArtifact?undefined:preview;$("motion-preview").hidden=!motion;
  if(motionArtifact && run?.result){
   try {
    const response=await fetch(run.result.artifactBase+motionArtifact.path,{signal});
    if(!response.ok)throw Error("Cannot load saved drive motion");
    const bytes=await response.arrayBuffer();
    const hash=bytesToHex(sha256(new Uint8Array(bytes)));
    if(hash!==motionArtifact.sha256 || bytes.byteLength!==motionArtifact.bytes)throw Error("Saved motion artifact failed integrity check");
    const saved=savedDriveMotion(JSON.parse(new TextDecoder().decode(bytes)),assembly,view);
    if(motionVersion!==motionGeneration)return;
    motion=saved;savedRotations=saved?.rotations??[];
   }catch(error){if(motionVersion!==motionGeneration)return;motion=undefined;notice(`Motion disabled: ${(error as Error).message}`);}
  }
  $("motion-preview").hidden=!motion;
  $("motion-heading").textContent=savedRotations.length?"Saved assembly motion":"Unverified motion study";
  $("drive-review-status").textContent=savedRotations.length?"Motion uses the saved build’s shafts, pulleys and carriage geometry. Physical load and safety testing remain separate acceptance gates.":"Mechanical review: incomplete. Animation does not establish a working drive.";
  $("drive-inspection-controls").hidden=Boolean(motionArtifact);
  driveReview=motion && !motionArtifact?arteraDriveReview(assembly,view):undefined;
  $("drive-findings").replaceChildren(...(driveReview?.findings??[]).map(finding=>element("li",finding)));
  const inspect=$<HTMLInputElement>("inspect-drive");inspect.checked=false;inspect.disabled=!driveReview?.drives.length;
  $("drive-turns").textContent="Z shaft turns from saved pose: 0.00 · X and Y held stationary";
  const prompt=element("option","Choose a shelf") as HTMLOptionElement;prompt.value="";
  $<HTMLSelectElement>("motion-level").replaceChildren(prompt,...(motion?.levels??[]).map((level,index)=>{const option=element("option",level.label) as HTMLOptionElement;option.value=String(index);return option;}));
  if(motion)applyMotion(0);
 });
 if(focused){select(focused);$<HTMLDetailsElement>("inspector").open=false;}
 renderCatalog();
 const children = assemblyChildren(view);
 $("component-summary").textContent = children.length ? `${children.length} immediate components · quantities in this assembly` : "No child components";
 $("component-tree").replaceChildren(...children.map(({item,quantity,labels})=>{
  const row=element("div", ""); row.className="component-row";
  const link=element("a",`${item.name} ×${quantity}`) as HTMLAnchorElement; link.href=urlFor("assembly",item.id);
  row.append(link,element("small",`${item.number} · ${item.kind}${labels.length > 1 ? " · " + labels.join(", ") : ""}`));
  const inspect=element("button","Details");inspect.setAttribute("aria-label",`Details for ${item.name}`);inspect.onclick=()=>select(item);row.append(inspect);
  return row;
 }));
 const path=assemblyPath(assembly,view.rootId);
 $("assembly-breadcrumbs").replaceChildren(...path.flatMap((item,index)=>{
  const link=element("a",index===0 && item.id===assembly.rootId ? "Full assembly" : item.name) as HTMLAnchorElement;
  link.href=urlFor("assembly",item.id===assembly.rootId?undefined:item.id);
  if(index===path.length-1)link.setAttribute("aria-current","page");
  return index ? [element("span"," / "),link] : [link];
 }));
 const parents=assembly.items.filter(item=>item.uses.some(use=>use.itemId===view.rootId));
 $("assembly-parents").replaceChildren(...parents.map(item=>{
  const link=element("a",`Back to ${item.name}`) as HTMLAnchorElement;link.href=urlFor("assembly",item.id===assembly.rootId?undefined:item.id);return link;
 }));
 const manifest=run?.result?.manifest;
 $<HTMLTextAreaElement>("parameter-values").value=JSON.stringify(manifest?.parameters??{},null,2);
 $("source-files").replaceChildren();$("source-preview").textContent="";
 for(const artifact of manifest?.artifacts??[]){const url=run!.result!.artifactBase+artifact.path;const a=element("a",artifact.path.split('/').at(-1)!) as HTMLAnchorElement;a.href=url;a.download=artifact.path.split('/').at(-1)!;$("source-files").append(a);if(/\.(scad|json|md|py)$/.test(artifact.path)){const b=element("button",`Read ${a.textContent}`);b.onclick=async()=>{try{const response=await fetch(url,{signal});if(!response.ok)throw Error("Cannot load source artifact");$("source-preview").textContent=await response.text();}catch(error){if(!signal.aborted)notice((error as Error).message);}};$("source-files").append(b);}}
 const evidence=$("revision-evidence");evidence.replaceChildren(element("h3",run?`Build ${run.id.slice(0,8)}`:"No workspace build yet"));
 if(import.meta.env.OUTFITTER_APP_MODE !== "demo" && (!run || run.id===project.workspace?.currentBuildId)) {
  const captureUrl=`/api/apps/workshop/projects/${project.id}/preview?revision=${project.revision}&evidence=1`;
  void fetch(captureUrl,{signal}).then(async response=>{
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
 const runs=project.workspace?.requests??[];$("runner-status").textContent=runs.length?`${runs.at(-1)!.status} · runner ${runs.at(-1)!.runner}`:"No workspace connected. Existing CAD remains inspectable.";
 $("revision-help").textContent="Build records preserve their inputs and evidence. Private downloads are retained for one year; source stays in the project repository. Geometry checks do not establish physical acceptance.";
 $("revision-list").replaceChildren(...[...runs].reverse().map(r=>{const row=element("article","");row.className="run-row";const b=element("button",`${r.id.slice(0,8)} · ${r.status}${r.result?.stale?" · newer work exists":""}`);b.onclick=()=>showBuild(r,true);row.append(b,element("p",r.instructions),element("small",`${r.createdAt} · ${r.sourceCommit}`));return row;}));
 const requested = query.get("build");
 const run = runs.find(r=>r.id===(requested ?? project.workspace?.currentBuildId));
 if(requested&&!run)notice("That build was not found. Showing the current assembly.");
 showBuild(run ?? runs.find(r=>r.id===project.workspace?.currentBuildId),Boolean(requested && run));
}
$("top-view").onclick=()=>viewer?.topView();
$("reset-view").onclick=()=>viewer?.reset();$("show-all").onclick=()=>{viewer?.isolate();viewer?.select();$<HTMLDetailsElement>("inspector").open=false;};$("isolate-item").onclick=()=>{if(selected){const descendants=new Set<string>();const walk=(i:Item)=>{descendants.add(i.id);for(const use of i.uses){const child=assembly.items.find(c=>c.id===use.itemId);if(child)walk(child);}};walk(selected);viewer?.isolate(descendants);}};
$("bom-mode").onchange=renderBom;
$("model-search").oninput=renderCatalog;
if(query.get("kind")==="assembly")$<HTMLSelectElement>("model-filter").value="assembly";
$("model-filter").onchange=renderCatalog;
$("build-request").onsubmit=async(e)=>{e.preventDefault();try{const w=project.workspace;const previous=build??w?.requests.at(-1);if(!w||!previous)throw Error("Connect a project workspace through RequestWorkshopBuild first.");const parameters=JSON.parse($<HTMLTextAreaElement>("parameter-values").value);project=await request(`/api/apps/workshop/projects/${project.id}/builds`,"POST",{id:project.id,revision:project.revision,repository:w.repository,sourceDir:w.sourceDir,sourceCommit:previous.result?.manifest?.sourceCommit??previous.sourceCommit,instructions:$<HTMLInputElement>("instruction").value,parameters,runner:previous.runner});render();notice("Build queued. The workspace runner must claim and execute it.");}catch(e){notice((e as Error).message);}};
$("model-panel").hidden=section==="parts"||section==="release"||section==="models"||section==="overview";$("models-panel").hidden=section!=="models"&&section!=="overview";$("bom-panel").hidden=section!=="parts";$("revisions-panel").hidden=section!=="release";
try{const projects:Project[]=import.meta.env.OUTFITTER_APP_MODE==="demo"?(await import("./fixtures")).fixtureProjects:await request("/api/apps/workshop/projects");const found=projects.find(p=>p.id.replaceAll("-","").endsWith(root.dataset.slug!.split("-").at(-1)!));if(!found)throw Error("Project not found");project=import.meta.env.OUTFITTER_APP_MODE==="demo"?found:await request(`/api/apps/workshop/projects/${found.id}`);
const recordPath=`/api/apps/workshop/projects/${found.id}`;
const savedBuild=query.get("build") && project.workspace?.requests.some(r=>r.id===query.get("build"));
if ((selection.size || project.assembly?.items.some(i=>i.reference)) && !savedBuild) {
 const readView=():Promise<ResolvedAssembly>=>request(recordPath+"/assembly?"+selection);
 resolved=await readView();
 if(!selection.has("revision") && resolved.revision!==project.revision) {
  project=await request(recordPath);resolved=await readView();
  if(resolved.revision!==project.revision)throw Error("Project changed while opening. Reload to read the current revision.");
 }
}
if(selection.size)$("build-request").hidden=true;
render();}catch(e){if(!signal.aborted){$("project-name").textContent="Could not load project";notice((e as Error).message);}}

}
onPageLoad(start);
