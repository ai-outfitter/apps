import { assemblyPoster } from "./assembly-poster";
import { inspectionControls } from "./inspection-controls";
import { modelSizing } from "./model-sizing";
import { installedOperations } from "../lib/installed-operations";
import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
import { onPageLoad } from "@ai-outfitter/ui/page";
import type { ResolvedAssembly } from "../lib/assembly-resolution";
import { boxPlan } from "../model/cad-plan";
import { renderPowerPanel } from "./power-panel";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { installedDriveMotion, savedDriveMotion, type PlacedRotation } from "../lib/saved-drive-motion";
import { arteraDriveReview } from "../lib/artera-drive-review";
import { arteraMotionPreview } from "../lib/artera-motion-preview";
import type { Project } from "../lib/project";
import { bomRows,bomTotals,buildPrice,AssemblySchema,BuildAssemblySchema,type Item,type Assembly } from "../lib/assembly";
import type { BuildRequest } from "../lib/workspace";
import { modelCatalog, modelView, assemblyChildren, assemblyPath } from "../lib/model-catalog";
import { fileBase, filePath, fileType } from "../lib/assembly-file";
import { appBase, projectPath } from "../lib/sections";
import { inspectionTree, projectInspection } from "./project-inspection";
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
 return appBase(location.pathname)+projectPath(source.projectId.slice(-12))+(params.size?"?"+params:"");
};
const urlFor = (section: "overview" | "models" | "parts" | "power", item?: string) => {
 const params = new URLSearchParams(selection);
 if (item) params.set("item", item);
 if (section === "overview" && query.get("view") === "top") params.set("view","top");
 if (build && historical) params.set("build", build.id);
 return appBase(location.pathname) + projectPath(root.dataset.slug!, section) + (params.size ? "?" + params : "");
};
function renderCatalog() {
 if (!assembly || section !== "models") return;
 const rows = modelCatalog(assembly, $<HTMLInputElement>("model-search").value, $<HTMLSelectElement>("model-filter").value);
 $("models-summary").textContent = `${rows.length} of ${assembly.items.length} items · ${assembly.items.filter(item => item.kind === "assembly").length} assemblies`;
 $("models-empty").hidden = rows.length !== 0;
 $("model-catalog").replaceChildren(...rows.map(({item, quantity, modeled}) => {
  const card = element("article", ""); card.className = "model-card"; card.dataset.itemId = item.id;
  card.append(element("small", `${item.number} · ${item.kind}`), element("h3", item.name), element("p", quantity ? `Qty ${quantity} in full assembly` : "Not placed in full assembly"), element("small", [item.manufacturer, item.mpn].filter(Boolean).join(" · ")), element("p", modeled ? "3D model available" : "Awaiting geometry"));
  const link = element("a", modeled ? "View model" : "View part details") as HTMLAnchorElement; link.href = urlFor("overview", item.id); card.append(link); return card;
 }));
}
let resolved: ResolvedAssembly | undefined;
let project:Project,assembly:Assembly,selected:Item|undefined,build:BuildRequest|undefined;
const overview = section === "overview";
let renderedPowerFor: string | undefined;
function describeInspection(tab: string) {
 agentPage("workshop").describe({title: project.name, state: {
  tab, projectId: project.id, revision: project.revision,
  ...(selected && {selectedItem: {id: selected.id, name: selected.name, number: selected.number}}),
 }});
}
const inspection = overview ? projectInspection($("project-inspection"), tab => {
 describeInspection(tab);
 if (tab === "bom") renderBom();
 if (tab === "power" && renderedPowerFor !== inspectedAssembly().rootId) {
  renderPower();
  renderedPowerFor = inspectedAssembly().rootId;
 }
}) : undefined;
let inspectingParts=false;
function inspectedAssembly() {
 const item = inspection && selected && !inspectingParts ? selected.id : query.get("item");
 return modelView(assembly, item);
}
function availableBudgets(view: Assembly) {
 return {
  bom: legacy ? project.parts.length > 0 : !!view.items.find(item => item.id === view.rootId)?.uses.length,
  power: !!view.power && (view.rootId === assembly.rootId || bomRows(view).some(row => row.item.power?.loads.length)),
 };
}
function updateBudgetTabs(view: Assembly) {
 const {bom, power} = availableBudgets(view);
 $("tab-bom").hidden = !bom;
 $("tab-power").hidden = !power;
}
let viewer: ReturnType<typeof import("./assembly-viewer").createAssemblyViewer> | undefined;
if (overview) {
 try {
  const { createAssemblyViewer } = await import("./assembly-viewer");
  if (signal.aborted) return;
  viewer = createAssemblyViewer($<HTMLCanvasElement>("assembly-viewer"), message => $("assembly-status").textContent = message, (id,path) => {
    const item = assembly?.items.find(candidate => candidate.id === id);
    if (item) select(item,path);
  });
 } catch {
  if (signal.aborted) return;
  $("assembly-status").textContent = "3D preview unavailable in this browser.";
  $("assembly-viewer").hidden = true;
  $("view-tools").hidden = true;
  $("isolate-item").hidden = true;
 }
}
const poster=overview ? assemblyPoster($("assembly-poster")) : undefined;
let motionFrame = 0, motionOffset = 0;
let driveReview: ReturnType<typeof arteraDriveReview> | undefined;
let motion: ReturnType<typeof arteraMotionPreview>;
let savedAxes: NonNullable<ReturnType<typeof installedDriveMotion>>["axes"] | undefined;
let savedRotations: PlacedRotation[]=[];
let motionGeneration=0;
// The trigger and shelf picker sit beside the viewer; the review record stays below it. Both show and hide together.
const showMotion=(visible:boolean)=>{for(const id of ["motion-controls","drive-turns","drive-review-status","motion-preview"])$(id).hidden=!visible; if(inspection) $("motion-menu").hidden=!visible;};
const stopMotion=()=>{cancelAnimationFrame(motionFrame);motionFrame=0;$("motion-play").textContent="Play motion";};
const opSelect=$<HTMLSelectElement>("operation-select"), scrub=$<HTMLInputElement>("operation-time");
let operations:ReturnType<typeof installedOperations>=[];
let opFrame=0;
function pauseOperation() {
 cancelAnimationFrame(opFrame);opFrame=0;$("operation-play").textContent="Play operation";
}
function seek(time:number) {
 const entry=operations[opSelect.selectedIndex];
 if(!entry)return;
 scrub.value=String(time);
 $("operation-clock").textContent=time.toFixed(2)+" s";
 viewer?.previewPose(entry.pose(time));
}
function chooseOperation() {
 pauseOperation();stopMotion();
 const entry=operations[opSelect.selectedIndex];
 $("operation-timeline").hidden=!entry;
 showMotion(!entry && Boolean(motion));
 $("motion-menu").hidden=!operations.length && !motion;
 viewer?.inspectDrive([],false);
 $<HTMLInputElement>("inspect-drive").checked=false;
 if(entry){scrub.max=String(entry.operation.durationSeconds);seek(0);}
 else if(motion)applyMotion(0);
}
opSelect.onchange=chooseOperation;
scrub.oninput=()=>{pauseOperation();seek(Number(scrub.value));};
$("operation-reset").onclick=()=>{pauseOperation();seek(0);};
$("operation-play").onclick=()=>{
 if(opFrame){pauseOperation();return;}
 const duration=Number(scrub.max), current=Number(scrub.value);
 const start=performance.now()-1000*(current>=duration?0:current);
 $("operation-play").textContent="Pause operation";
 function tick(now:number) {
  const time=Math.max(0,Math.min(duration,(now-start)/1000));seek(time);
  if(time<duration) opFrame=requestAnimationFrame(tick);else pauseOperation();
 }
 opFrame=requestAnimationFrame(tick);
};
signal.addEventListener("abort",()=>{partInspection?.stop();motionGeneration++;pauseOperation();stopMotion();viewer?.dispose();},{once:true});
const applyMotion=(offset:number)=>{motionOffset=offset;if(inspection) $("motion-reset").hidden=offset===0;if(motion)viewer?.previewTranslation(motion.paths,offset,savedRotations,savedAxes);$("drive-turns").textContent=`Offset from saved pose · ${Number(offset.toFixed(1))} mm`;};
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
function descendants(item: Item) {
  const byId = new Map(assembly.items.map(child => [child.id, child]));
  const result = new Set<string>();
  function visit(current: Item) {
    if (result.has(current.id)) return;
    result.add(current.id);
    for (const use of current.uses) {
      const child = byId.get(use.itemId);
      if (child) visit(child);
    }
  }
  visit(item);
  return result;
}
let partInspection:ReturnType<typeof inspectionControls>|undefined;
let selectionPath: string | undefined;
function select(item:Item, path?:string){
 selectionPath=path;
 selected=item;
 partInspection?.select(item,path);
 viewer?.select(descendants(item),path,item.id);
 $("isolate-item").hidden=!viewer;
 $("selected-name").textContent=item.name;
 $("selected-meta").textContent=[item.kind, "Rev "+item.revision].join(" · ");
 const details=$("selected-body");
 details.replaceChildren();
 if(item.notes) details.append(element("p",item.notes));
 const facts=element("dl","");
 details.append(facts);
 function fact(label:string,value:HTMLElement|string){
   const entry=element("dd","");
   entry.append(value);
   facts.append(element("dt",label),entry);
 }
 const model=element("a",item.number) as HTMLAnchorElement;
 model.href=urlFor("overview",item.id);
 model.setAttribute("aria-label","Open model "+item.number);
 fact("Model",model);
 fact("Geometry",item.provenance);
 fact("Unit price",itemPrice(item));
 const supplier=element("span","");
 appendPartSource(supplier,item.source);
 if(supplier.childElementCount) fact("Supplier",supplier);
 const source = !historical && resolved?.sources.find(s=>s.itemId===item.id);
 if(source){
   const link=element("a",source.name+" · Rev "+source.revision+(source.configuration ? " · "+source.configuration : "")) as HTMLAnchorElement;
   link.href=sourceUrl(source);
   fact("Source model",link);
 }
 const children=assemblyChildren(assembly,item.id);
 if(children.length){
   const list=element("div","");
   list.className="inspection-children";
   details.append(element("h4","Components"),list);
   for(const {item:child,quantity,labels} of children){
     const button=element("button",child.name);
     if(labels.length) button.title=labels.join(", ");
     button.append(element("small","×"+quantity));
     button.onclick=()=>select(child,path);
     list.append(button);
   }
 }
if(item.files?.length) details.append(element("h4","Files"));
for (const file of item.files ?? []) {
 const url=appBase(location.pathname)+fileBase(file)+filePath(file);
 const link=document.createElement("a");
 link.href=url; link.download=file.fileName; link.textContent="Download "+file.fileName;
 details.append(link);
 const type=fileType(file.fileName);
 if(type.startsWith("video/")){
   const video=document.createElement("video");
   video.controls=true; video.preload="none"; video.src=url; video.style.maxWidth="100%";
   details.append(video);
 } else if(type==="image/gif"){
   const image=document.createElement("img");
   image.src=url; image.alt=file.fileName; image.style.maxWidth="100%"; details.append(image);
 }
}
if (inspection) {
 updateBudgetTabs(inspectedAssembly());
 $("tab-selected").hidden = false;
 $("show-all").hidden = false;
 inspection.open("selected");
 if (root?.contains(document.activeElement) && document.activeElement?.closest("#project-inspection")) $("tab-selected").focus({preventScroll:true});
}
}
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
function itemPrice(item: Item) {
 if(item.priceKnown) return `${usd.format(item.unitCost)} known`;
 if(item.estimatedUnitCost !== undefined) return `${usd.format(item.estimatedUnitCost)} estimated`;
 return "Unpriced";
}
function appendPartSource(container: HTMLElement, source: string) {
 if (!source) return;
 const link = document.createElement("a");
 link.href = source;
 if (!link.hostname || !["https:", "http:"].includes(link.protocol)) return;
 link.textContent = link.hostname.replace(/^www\./, "");
 link.setAttribute("aria-label", `Open part source at ${link.textContent}`);
 link.target = "_blank";
 link.rel = "noopener noreferrer";
 container.append(link);
}
function renderBom(){
 if (!assembly || (!inspection && section!=="parts")) return;
 $("bom-view").hidden = legacy;
 if(legacy){
  const total=project.parts.reduce((sum,part)=>sum+part.unitCost*part.quantity,0);
  $("bom-price").textContent="One-build price "+usd.format(total);
  $("bom-rows").replaceChildren(...project.parts.map(part=>{
   const row=element("article","");row.className="bom-row";
   const price=element("span",usd.format(part.unitCost)+" each");price.className="line-price";
   const details=element("div","");
   details.append(price);
   appendPartSource(details,part.source);
   row.append(element("strong",part.name),element("span",`Qty ${part.quantity}`),details);return row;
  }));
  return;
 }
 const view = inspectedAssembly();
 if (inspection) $("bom-heading").textContent = assembly.items.find(i => i.id === view.rootId)?.name ?? "Bill of materials";
 const {knownSubtotal,estimatedSubtotal,unpricedUnits}=buildPrice(view);
 $("bom-price").textContent=!assembly.rootId ? "No assembly selected." :
   `${unpricedUnits?"Partial one-build subtotal":"One-build price"} ${usd.format(knownSubtotal+estimatedSubtotal)} · ${usd.format(knownSubtotal)} known · ${usd.format(estimatedSubtotal)} estimated · ${unpricedUnits} unpriced ${unpricedUnits===1?"unit":"units"}`;
 const mode=$<HTMLSelectElement>("bom-mode").value;
 const rows=mode==="hierarchy"?bomRows(view):bomTotals(view).lines.filter(r=>r.item.kind!=="assembly"&&(mode!=="cots"||r.item.kind==="cots")).map(r=>({...r,depth:0}));
 $("bom-rows").replaceChildren(...rows.map(({ item, quantity, depth }) => {
  const row = element("article", "");
  row.className = "bom-row";
  const title = element("div", "");
  const link = document.createElement("a");
  link.textContent = item.name;
  link.href = urlFor("overview", item.id);
  if (inspection) link.onclick = event => {
   if (event.button || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
   event.preventDefault();
   select(item);
  };
  title.append(link, element("small", `${"↳ ".repeat(Math.min(depth, 3))}${item.number} · ${item.revision}`));
  const info = element("div", item.kind);
  const price = element("span", " · " + itemPrice(item));
  price.className = "line-price";
  info.append(price, element("small", [item.manufacturer, item.mpn, item.provenance].filter(Boolean).join(" · ")));
  appendPartSource(info, item.source);
  row.append(title, element("span", `Qty ${quantity}`), info);
  return row;
 }));
}
function renderPower() {
 renderPowerPanel($("power-panel"),assembly,inspectedAssembly().rootId,
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
}
function showBuild(run?:BuildRequest, snapshot=false){
 selected = undefined;
 $("isolate-item").hidden=true;
 selectionPath = undefined;
 if (inspection) {
  $("tab-selected").hidden = true;
  $("show-all").hidden = true;
 }
 renderedPowerFor = undefined;
 const motionVersion=++motionGeneration;savedRotations=[];savedAxes=undefined;
 pauseOperation();operations=[];$("operation-controls").hidden=true;
 stopMotion();motion=undefined;motionOffset=0;showMotion(false);
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
 const posterKey=JSON.stringify([project.id,project.revision,view.rootId,run?.id,location.search,resolved?.sources]);
 const captureUrl=!historical && !focused && !selection.size && !query.has("view") && import.meta.env.OUTFITTER_APP_MODE!=="demo"
   ? appBase(location.pathname)+`/api/apps/workshop/projects/${project.id}/preview?revision=${project.revision}&thumbnail=1` : undefined;
 const finishPoster=poster?.show(project,view,posterKey,captureUrl);
 const references=$("assembly-references");
 references.hidden=historical || !resolved?.sources.length;
 if(overview && !references.hidden && resolved){
  const links=resolved.sources.map(s=>{
   const a=element("a",`${s.name} · ${s.pinned?"pinned":"current"} revision ${s.revision}${s.configuration ? " · "+s.configuration : ""}`) as HTMLAnchorElement;
   a.href=sourceUrl(s);
   return a;
  });
  references.replaceChildren(element("strong","Source assemblies: "),...links.flatMap((a,i)=>i?[document.createTextNode(" · "),a]:[a]));
 }
 $("bom-heading").textContent = focused && focused.id !== assembly.rootId ? `Bill of materials · ${focused.name}` : "Bill of materials";
 const children = assemblyChildren(view);
 if (inspection) {
  partInspection?.stop();
  partInspection=inspectionControls(view,$("part-inspection-actions"),$<HTMLButtonElement>("restore-inspection"),(hidden,hinges)=>{
    viewer?.inspectParts(hidden,hinges);
    const changed=Boolean(hidden.size || hinges.length);
    if(inspectingParts===changed)return;
    inspectingParts=changed;
    updateBudgetTabs(inspectedAssembly());
    if($("tab-bom").getAttribute("aria-selected")==="true") renderBom();
    if($("tab-power").getAttribute("aria-selected")==="true") renderPower();
  },select,()=>{
    pauseOperation();stopMotion();
    if(operations[opSelect.selectedIndex])seek(0);
    else if(motion){applyMotion(0);$<HTMLSelectElement>("motion-level").value="";}
    viewer?.isolate();viewer?.inspectDrive([],false);$<HTMLInputElement>("inspect-drive").checked=false;
  });
  $("part-inspection-actions").hidden=!viewer;
  const inputs=run?.result?.manifest?.parameters ?? run?.parameters;
  $("tab-sizing").hidden=!modelSizing($("model-sizing"),{
    bounds:partInspection.bounds,preset:legacy?project.params:undefined,inputs,
    sources:historical ? undefined : resolved?.sources
      .filter(source=>source.configuration && partInspection!.instances.has(source.itemId))
      .map(source=>({label:source.name+" · "+source.configuration,href:sourceUrl(source),parameters:source.parameters})),
    configurations:!historical && (!resolved || project.revision===resolved.revision) ? project.assembly.configurations : undefined,
    requestBuild:project.workspace && !historical && !selection.size && import.meta.env.OUTFITTER_APP_MODE!=="demo" ? values=>{
      $<HTMLTextAreaElement>("parameter-values").value=JSON.stringify(values,null,2);
      const instruction=$<HTMLInputElement>("instruction");
      if(!instruction.value.trim())instruction.value="Rebuild with the selected model parameters.";
      $<HTMLFormElement>("build-request").requestSubmit();
    }:undefined,
  });
  $("project-inspection").inert = false;
  inspection.open("description");
  if (focused && focused.id !== assembly.rootId) $("project-name").textContent = project.name + " / " + focused.name;
  updateBudgetTabs(view);
  $("inspection-tree").replaceChildren(children.length
   ? inspectionTree(view, !historical && resolved ? resolved.sources : [], sourceUrl, select)
   : "No child components");
 } else {
  const {bom, power} = availableBudgets(view);
  for (const [id, target, visible] of [
   ["project-model", "overview", section === "parts" || section === "power"],
   ["project-bom", "parts", bom && section !== "parts"],
   ["project-power", "power", power && section !== "power"],
  ] as const) {
   const link = $<HTMLAnchorElement>(id);
   link.href = urlFor(target, focused?.id);
   link.hidden = !visible;
  }
  $("project-views").hidden = !$("project-views").querySelector("a:not([hidden])");
  $("bom-panel").hidden = section !== "parts" || !bom;
  if (section === "parts" && !bom && assembly.rootId) notice("This model has no bill of materials.");
 }
 if (section === "power") renderPower();
 if(selection.size && !historical) $("revision-label").textContent=`Source revision ${resolved?.revision ?? project.revision}${selection.get("configuration") ? " · "+selection.get("configuration") : ""}`;
 else if(!historical)$("revision-label").textContent=`Project save ${project.revision}${run?` · geometry build ${run.id.slice(0,8)}`:""}`;
 $<HTMLAnchorElement>("open-assembly").href=urlFor("overview");
 $<HTMLAnchorElement>("full-assembly").href=urlFor("overview");
 $("full-assembly-link").hidden=!focused || focused.id===assembly.rootId;
 $<HTMLAnchorElement>("browse-models").href=urlFor("models");
 if(query.has("item")&&!focused&&assembly.items.length)notice("That item is not in this revision. Showing the full assembly.");
 const preview=arteraMotionPreview(assembly,view,run?.result?.manifest?.parameters??{});
 void viewer?.render(view,run?.result?.artifactBase??"",legacy?{params:project.params,plan:project.cadPlan}:undefined,run?.result?.manifest?.artifacts??[],signal,historical?{}:resolved?.meshes).then(async()=>{
  if(motionVersion!==motionGeneration || build!==run || $("assembly-viewer").dataset.ready!=="true")return;
  if(query.get("view")==="top") viewer?.topView();
  finishPoster?.($("assembly-viewer").hasAttribute("data-empty") || selected ? undefined : ()=>viewer!.snapshot());
  const motionArtifact=run?.result?.manifest?.artifacts.find(a=>a.path.endsWith("/drive-motion.json"));
  motion=motionArtifact?undefined:preview;showMotion(Boolean(motion));
  let inline, inlineFailed=false;
  try { inline=installedDriveMotion(view); }
  catch(error){ inlineFailed=true;motion=undefined;notice(`Motion disabled: ${(error as Error).message}`); }
  if(inline) { motion=inline;savedRotations=inline.rotations;savedAxes=inline.axes; }
  else if(!inlineFailed && motionArtifact && run?.result){
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
  showMotion(Boolean(motion));
  $("motion-heading").textContent=savedRotations.length?"Saved assembly motion":"Unverified motion study";
  if(motion){
   const span=motion.levels.at(-1)!.offset-motion.levels[0].offset;
   $("drive-review-status").textContent=savedRotations.length
     ? `${motion.levels.length} saved positions across ${Number(span.toFixed(1))} mm of travel.`
     : "Preview the proposed drive across its shelf positions.";
  }
  $("drive-inspection-controls").hidden=Boolean(motionArtifact || inline);
  driveReview=motion && !motionArtifact && !inline?arteraDriveReview(assembly,view):undefined;
  $("drive-findings").replaceChildren(...(driveReview?.findings??[]).map(finding=>element("li",finding)));
  const inspect=$<HTMLInputElement>("inspect-drive");inspect.checked=false;inspect.disabled=!driveReview?.drives.length;
  const prompt=element("option","Choose position") as HTMLOptionElement;prompt.value="";
  $<HTMLSelectElement>("motion-level").replaceChildren(prompt,...(motion?.levels??[]).map((level,index)=>{const option=element("option",level.label) as HTMLOptionElement;option.value=String(index);return option;}));
  if(motion)applyMotion(0);
  operations=installedOperations(view);
  if(operations.length){
   const labels=new Map<string,number>();
   const options=operations.map(entry=>{
    const index=(labels.get(entry.label) ?? 0)+1;
    labels.set(entry.label,index);
    return element("option",entry.label+(index>1?" ("+index+")":""));
   });
   if(motion)options.push(element("option","Drive motion"));
   opSelect.replaceChildren(...options);
   $("operation-controls").hidden=false;chooseOperation();
  }
 });
 if (inspection && focused) select(focused);
 renderCatalog();
 const path=assemblyPath(assembly,view.rootId);
 $("assembly-breadcrumbs").hidden=path.length<2;
 $("assembly-breadcrumbs").replaceChildren(...path.flatMap((item,index)=>{
  const link=element("a",index===0 && item.id===assembly.rootId ? "Project overview" : item.name) as HTMLAnchorElement;
  link.href=urlFor("overview",item.id===assembly.rootId?undefined:item.id);
  if(index===path.length-1)link.setAttribute("aria-current","page");
  return index ? [element("span"," / "),link] : [link];
 }));
 const parents=assembly.items.filter(item=>item.uses.some(use=>use.itemId===view.rootId));
 $("assembly-parents").replaceChildren(...parents.map(item=>{
  const link=element("a",`Back to ${item.name}`) as HTMLAnchorElement;link.href=urlFor("overview",item.id===assembly.rootId?undefined:item.id);return link;
 }));
 const manifest=run?.result?.manifest;
 $<HTMLTextAreaElement>("parameter-values").value=JSON.stringify(manifest?.parameters??{},null,2);
 $("source-files").replaceChildren();$("source-preview").textContent="";
 for(const artifact of manifest?.artifacts??[]){const url=run!.result!.artifactBase+artifact.path;const a=element("a",artifact.path.split('/').at(-1)!) as HTMLAnchorElement;a.href=url;a.download=artifact.path.split('/').at(-1)!;$("source-files").append(a);if(/\.(scad|json|md|py)$/.test(artifact.path)){const b=element("button",`Read ${a.textContent}`);b.onclick=async()=>{try{const response=await fetch(url,{signal});if(!response.ok)throw Error("Cannot load source artifact");$("source-preview").textContent=await response.text();}catch(error){if(!signal.aborted)notice((error as Error).message);}};$("source-files").append(b);}}
 if (inspection) return;
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
 if(run?.result?.error)evidence.append(element("p",run.result.error));
 if(section==="parts") renderBom();
}
function render(){
 if(import.meta.env.OUTFITTER_APP_MODE==="demo")for(const node of $("build-request").querySelectorAll<HTMLInputElement>("input,button"))node.disabled=true;
 $("project-name").textContent=project.name;
 if (overview) {
  $("project-brief").textContent = project.brief;
  $("project-brief").hidden = !project.brief;
 }
 const runs=project.workspace?.requests??[];$("runner-status").textContent=runs.length?`${runs.at(-1)!.status} · runner ${runs.at(-1)!.runner}`:"No workspace connected. Existing CAD remains inspectable.";
 $("revision-help").textContent="Build records preserve their inputs and evidence. Private downloads are retained for one year; source stays in the project repository. Geometry checks do not establish physical acceptance.";
 $("revision-list").replaceChildren(...[...runs].reverse().map(r=>{const row=element("article","");row.className="run-row";const b=element("button",`${r.id.slice(0,8)} · ${r.status}${r.result?.stale?" · newer work exists":""}`);b.onclick=()=>showBuild(r,true);row.append(b,element("p",r.instructions),element("small",`${r.createdAt} · ${r.sourceCommit}`));return row;}));
 const requested = query.get("build");
 const run = runs.find(r=>r.id===(requested ?? project.workspace?.currentBuildId));
 if(requested&&!run)notice("That build was not found. Showing the current assembly.");
 showBuild(run ?? runs.find(r=>r.id===project.workspace?.currentBuildId),Boolean(requested && run));
}
$("top-view").onclick=()=>viewer?.topView();
$("reset-view").onclick = () => viewer?.reset();
$("show-all").onclick = () => {
 viewer?.isolate();
 viewer?.select();
 selected = undefined;
 $("isolate-item").hidden=true;
 selectionPath = undefined;
 if (inspection) {
  $("show-all").hidden = true;
  $("tab-selected").hidden = true;
  updateBudgetTabs(inspectedAssembly());
  inspection.open("components");
 }
};
$("isolate-item").onclick = () => {
 if (selected) {
  viewer?.isolate(descendants(selected), selectionPath);
  $("isolate-item").hidden=true;
  $("show-all").focus({preventScroll:true});
 }
};
$("bom-mode").onchange=renderBom;
$("model-search").oninput=renderCatalog;
if(query.get("kind")==="assembly")$<HTMLSelectElement>("model-filter").value="assembly";
$("model-filter").onchange=renderCatalog;
$("build-request").onsubmit=async(e)=>{e.preventDefault();try{const w=project.workspace;const previous=build??w?.requests.at(-1);if(!w||!previous)throw Error("Connect a project workspace through RequestWorkshopBuild first.");const parameters=JSON.parse($<HTMLTextAreaElement>("parameter-values").value);project=await request(`/api/apps/workshop/projects/${project.id}/builds`,"POST",{id:project.id,revision:project.revision,repository:w.repository,sourceDir:w.sourceDir,sourceCommit:previous.result?.manifest?.sourceCommit??previous.sourceCommit,instructions:$<HTMLInputElement>("instruction").value,parameters,runner:previous.runner});render();notice("Build queued. The workspace runner must claim and execute it.");}catch(e){notice((e as Error).message);}};
try{
 if(import.meta.env.OUTFITTER_APP_MODE==="demo"){
   const {fixtureProjects}=await import("./fixtures");
   const found=fixtureProjects.find(p=>p.id.endsWith(root.dataset.slug!.split("-").at(-1)!));
   if(!found)throw Error("Project not found");
   project=found;
 }else{
   let id=root.dataset.projectId;
   if(!id){
     const projects:{id:string}[]=await request("/api/apps/workshop/projects");
     id=projects.find(p=>p.id.endsWith(root.dataset.slug!.split("-").at(-1)!))?.id;
   }
   if(!id)throw Error("Project not found");
   project=await request(`/api/apps/workshop/projects/${id}`);
 }
 const recordPath=`/api/apps/workshop/projects/${project.id}`;
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
