import { assemblyPoster } from "./assembly-poster";
import { inspectionLink, sizingConfigurations } from "../lib/inspection-links";
import { occurrenceInspection } from "./occurrence-inspection";
import { inspectionControls } from "./inspection-controls";
import { modelSizing } from "./model-sizing";
import { installedOperations } from "../lib/installed-operations";
import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { parameterDefinitions, type ResolvedAssembly } from "../lib/assembly-resolution";
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
import { modelCatalog, modelView } from "../lib/model-catalog";
import { fileBase, filePath, fileType, isReferenceImage } from "../lib/assembly-file";
import { appBase, projectPath } from "../lib/sections";
import { projectInspection } from "./project-inspection";
import type { Occurrence } from "../lib/assembly-inspection";
import { componentIdentity } from "../lib/occurrence-route";
import { printableParts, renderPrintAnalysis, type PrintAnalysis } from "./print-analysis";
import { renderCotsEvidence } from "./cots-evidence";
import type { CotsEvidenceResult } from "../server/cots-evidence";
async function start(signal:AbortSignal){
const workspace=document.querySelector<HTMLElement>(".workspace");
if(!workspace)return;
const root = workspace;
const section=root.dataset.section;
const canEdit = root.dataset.canEdit === "true";
const base = appBase(location.pathname);
const $=<T extends HTMLElement=HTMLElement>(id:string)=>root.querySelector<T>(`#${id}`)!;
const element=(tag:string,text:string)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const notice=(s:string)=>$("workspace-notice").textContent=s;
let legacy=false, historical=false;
let query = new URLSearchParams(location.search);
const selection = new URLSearchParams();
for(const key of ["revision","configuration","parameters"]) if(query.has(key)) selection.set(key,query.get(key)!);
const sourceUrl = (source: ResolvedAssembly["sources"][number]) => {
 const params=new URLSearchParams();
 if(source.pinned)params.set("revision",String(source.revision));
 if(source.configuration)params.set("configuration",source.configuration);
 if(source.parameters)params.set("parameters",JSON.stringify(source.parameters));
 return base+projectPath(source.projectId.slice(-12))+(params.size?"?"+params:"");
};
const urlFor = (section: "overview" | "models" | "parts" | "power", item?: string) => {
 const params = new URLSearchParams(selection);
 if (item) params.set("item", item);
 if (section === "overview" && query.get("view") === "top") params.set("view","top");
 if (build && historical) params.set("build", build.id);
 return base + projectPath(root.dataset.slug!, section) + (params.size ? "?" + params : "");
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
let cotsGeneration = 0;
function cotsRoot() {
 const item = assembly.items.find(candidate => candidate.id === (selected?.id ?? occurrenceUI?.level?.item.id ?? query.get("item")));
 return item?.id;
}
function hasCots(rootId?: string) {
 if (!rootId) return assembly.items.some(item => item.kind === "cots");
 const visited = new Set<string>();
 const items = new Map(assembly.items.map(item => [item.id, item]));
 const queue = [rootId];
 for (const id of queue) {
  if (visited.has(id)) continue;
  visited.add(id);
  const item = items.get(id);
  if (item?.kind === "cots") return true;
  if (item) queue.push(...item.uses.map(use => use.itemId));
 }
 return false;
}
async function renderCotsTab() {
 const generation = ++cotsGeneration;
 const host = $("cots-evidence");
 host.textContent = "Loading purchased part evidence…";
 if (historical || import.meta.env.OUTFITTER_APP_MODE === "demo") {
  host.textContent = "Purchased part evidence is unavailable for this view.";
  return;
 }
 const parameters = new URLSearchParams(selection);
 const itemId = cotsRoot();
 if (itemId) parameters.set("itemId", itemId);
 const path = base + `/api/apps/workshop/projects/${project.id}/cots-evidence?${parameters}`;
 try {
  const result: CotsEvidenceResult = await request(path);
  if (signal.aborted || generation !== cotsGeneration) return;
  if (result.revision !== (resolved?.revision ?? project.revision)) {
   host.textContent = "The assembly save changed. Reload to inspect its purchased parts.";
   return;
  }
  renderCotsEvidence(host, result, occurrenceLink);
 } catch {
  if (!signal.aborted && generation === cotsGeneration) host.textContent = "Could not load purchased part evidence. Reopen this tab to retry.";
 }
}
let renderedPowerFor: string | undefined;
let printGeneration = 0;
function renderPrintTab() {
 const view = inspectedAssembly();
 const parts = printableParts(view);
 const host = $("print-analysis");
 const generation = ++printGeneration;
 renderPrintAnalysis(host, view);
 if (!parts.size || import.meta.env.OUTFITTER_APP_MODE === "demo") return;
 if (historical) {
  renderPrintAnalysis(host, view, undefined, true);
  return;
 }
 const revision = resolved?.revision ?? project.revision;
 const parameters = new URLSearchParams(selection);
 parameters.set("view", "print");
 if (view.rootId && view.rootId!==assembly.rootId) parameters.set("itemId",view.rootId);
 const path = base + `/api/apps/workshop/projects/${project.id}/assembly?${parameters}`;
 const deadline = Date.now() + 10 * 60 * 1000;
 let delay = 3000;
 const active = () => generation === printGeneration && !signal.aborted && $("tab-print").getAttribute("aria-selected") === "true";
 async function refresh() {
  if (!active()) return;
  try {
   const latest: PrintAnalysis & { revision: number } = await request(path);
   if (!active()) return;
   if (latest.revision !== revision) throw Error("Assembly revision changed");
   renderPrintAnalysis(host, view, latest);
   if (Date.now()<deadline && latest.parts.some(part=>parts.has(part.itemId) && part.sha256 && part.state==="pending" && !part.needsEditor)) {
    setTimeout(()=>void refresh(),delay);
    delay=Math.min(delay*2,30_000);
   }
  } catch {
   if (active()) renderPrintAnalysis(host, view, undefined, true);
  }
 }
 void refresh();
}
function describeInspection(tab: string) {
 agentPage("workshop").describe({title: project.name, state: {
  tab, projectId: project.id, revision: project.revision,
  ...(selected && {selectedItem: {id: selected.id, name: selected.name, number: selected.number}}),
 }});
}
const inspection = overview ? projectInspection($("project-inspection"), tab => {
 describeInspection(tab);
 occurrenceUI?.tabChanged(tab);
 if (tab === "bom") renderBom();
 if (tab === "cots") void renderCotsTab();
 if (tab === "print") renderPrintTab();
 if (tab === "power" && renderedPowerFor !== inspectedAssembly().rootId) {
  renderPower();
  renderedPowerFor = inspectedAssembly().rootId;
 }
}) : undefined;
let inspectingParts=false;
function inspectedAssembly() {
 const item = inspection ? (!inspectingParts && selected?.id) || occurrenceUI?.level?.item.id : query.get("item");
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
 const purchased = hasCots(cotsRoot());
 $("tab-cots").hidden = !purchased;
 $("purchased-parts-shortcut").hidden = !purchased;
 $("tab-print").hidden = !printableParts(view).size;
}
let viewer: ReturnType<typeof import("./assembly-viewer").createAssemblyViewer> | undefined;
let occurrenceUI: ReturnType<typeof occurrenceInspection> | undefined;
if (overview) {
 try {
  const { createAssemblyViewer } = await import("./assembly-viewer");
  if (signal.aborted) return;
  viewer = createAssemblyViewer($<HTMLCanvasElement>("assembly-viewer"), message => $("assembly-status").textContent = message,
    (_id, path) => occurrenceUI?.pick(occurrenceUI.fromViewer(path)), showAll,
    path => occurrenceUI?.open(occurrenceUI.fromViewer(path)));
 } catch {
  if (signal.aborted) return;
  $("assembly-status").textContent = "3D preview unavailable in this browser.";
  $("assembly-viewer").hidden = true;
  $("view-tools").hidden = true;
  $("isolate-item").hidden = true;
 }
}
if (overview) occurrenceUI = occurrenceInspection(root, viewer, {
 changed: renderOccurrence,
 tab(name) {
  if (name) inspection?.open(name);
  return inspection?.current;
 },
 hide: path => partInspection?.toggleHidden(path),
 invalid: notice,
}, signal);
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
const request=async(path:string,method="GET",body?:unknown)=>{const r=await fetch(path.startsWith("/api/apps/workshop/") ? base + path : path,{signal,method,headers:body?{"Content-Type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(await r.text());return r.json();};
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
function renderOccurrence(pick?: Occurrence, level?: Occurrence) {
 const item = pick?.item ?? level?.item;
 selected = pick?.item;
 selectionPath = pick && occurrenceUI?.viewerPath(pick.path);
 viewer?.select(selected ? descendants(selected) : undefined, selectionPath);
 $("isolate-item").hidden = !viewer || !selected || Boolean(pick && !selectionPath);
 $("show-all").hidden = !selected;
 const openName = level ? componentIdentity(level.item).name : project.name;
 $("project-name").textContent = openName;
 document.title = openName + " — Workshop";
 $("inspection-product").textContent = project.name;
 const levelSource = sourceFor(level);
 $("occurrence-meta").textContent = [
  level && [componentIdentity(level.item).number, level.item.kind, "Rev " + level.item.revision].filter(Boolean).join(" · "),
  "Installed variant: " + (selection.get("configuration") ?? levelSource?.configuration ?? "Saved assembly"),
  "Source revision " + (levelSource?.revision ?? resolved?.revision ?? project.revision),
 ].filter(Boolean).join("  /  ");
 $("detail-context").textContent = pick ? "Selected component" : level?.item.kind === "assembly" ? "Open assembly" : "Part model";
 $("selected-name").textContent = item ? componentIdentity(item).name : project.name;
 $("selected-meta").textContent = item ? [componentIdentity(item).number, item.kind === "cots" ? "Purchased part (COTS)" : item.kind, "Rev " + item.revision].filter(Boolean).join(" · ") : "";
 if (item) partInspection?.select(item, pick ? selectionPath : occurrenceUI?.viewerPath(level?.path));
 else $("part-inspection-actions").replaceChildren();
 $("project-brief").hidden = Boolean(pick || level?.item.id !== assembly.rootId || !project.brief);
 $("reference-images").hidden = Boolean(pick || level?.item.id !== assembly.rootId || !$("reference-images").querySelector("figure"));
 renderItemDetails(item, pick);
 renderSource(pick ?? level);
 renderSizing(pick ?? level);
 updateBudgetTabs(inspectedAssembly());
 if (inspection && !$("project-inspection").inert) {
  // A component's available evidence can differ from the open assembly's.
  inspection.open(inspection.current);
 }
}

function renderItemDetails(item?: Item, occurrence?: Occurrence) {
 const details=$("selected-body");
 details.replaceChildren();
 if (!item) {
  details.textContent = "No assembly details have been saved.";
  return;
 }
 if (occurrence?.item.kind === "assembly" && occurrence !== occurrenceUI?.level) {
  const open = document.createElement("a");
  open.href = occurrenceUI!.openHref(occurrence);
  open.textContent = "Inspect " + occurrence.label;
  open.className = "inspect-selected";
  details.append(open);
 }
 if(item.notes) details.append(element("p",item.notes));
 const facts=element("dl","");
 details.append(facts);
 function fact(label:string,value:HTMLElement|string){
   const entry=element("dd","");
   entry.append(value);
   facts.append(element("dt",label),entry);
 }
 if (item.manufacturer) fact("Manufacturer", item.manufacturer);
 if (item.mpn) fact("Manufacturer part number", item.mpn);
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
if(item.files?.length) details.append(element("h4","Files"));
for (const file of item.files ?? []) {
 const url=base+fileBase(file)+filePath(file);
 const link=document.createElement("a");
 link.href=url; link.download=file.fileName; link.textContent="Download "+file.fileName;
 details.append(link);
 const type=fileType(file.fileName);
 if(type.startsWith("video/")){
   const video=document.createElement("video");
   video.controls=true; video.preload="none"; video.src=url; video.style.maxWidth="100%";
   details.append(video);
 } else if(type.startsWith("image/")){
   const image=document.createElement("img");
   image.src=url; image.alt=file.fileName; image.style.maxWidth="100%"; details.append(image);
 }
}
}
function occurrenceLink(itemId: string) {
 const occurrence = occurrenceUI?.pathFor(itemId);
 return occurrence ? occurrenceUI!.hrefFor(occurrence) : urlFor("overview", itemId);
}
function sourceFor(occurrence?: Occurrence) {
 if (historical || !occurrence) return undefined;
 return occurrenceUI?.trailFor(occurrence).reverse()
  .map(row => resolved?.sources.find(source => source.itemId === row.item.id)).find(Boolean);
}
function renderSource(occurrence?: Occurrence) {
 const host = $("inspection-source");
 host.replaceChildren();
 const run = build ?? project.workspace?.requests.at(-1);
 const workspace = project.workspace;
 const reference = sourceFor(occurrence);
 const config = !historical && sizingConfigurations(project.assembly)?.find(config => config.name === selection.get("configuration"));
 const values = readParameters(selection.get("parameters"));
 const inputs = run?.result?.manifest?.parameters ?? run?.parameters;
 const summary = document.createElement("dl");
 function fact(label: string, value: string | HTMLElement) {
  const entry = document.createElement("dd");
  entry.append(value);
  summary.append(element("dt", label), entry);
 }
 if (reference) {
  const link = document.createElement("a");
  link.href = sourceUrl(reference);
  link.textContent = reference.name;
  fact("Source model", link);
  fact("Source revision", String(reference.revision));
  if (reference.configuration) fact("Source variant", reference.configuration);
 } else if (workspace) {
  let repository: string | HTMLAnchorElement = workspace.repository;
  if (/^https?:\/\//i.test(workspace.repository)) {
   const link = document.createElement("a");
   link.href = workspace.repository;
   link.textContent = workspace.repository;
   repository = link;
  }
  fact("Repository", repository);
  if (workspace.sourceDir) fact("Source directory", workspace.sourceDir);
  if (run?.sourceCommit) fact("Source commit", run.result?.manifest?.sourceCommit ?? run.sourceCommit);
  fact("Build status", run?.status ?? "No build requested");
 } else host.append(element("p", "No source repository or build is linked to this model."));
 if (summary.children.length) host.append(summary);
 const scope = occurrence && descendants(occurrence.item);
 const installed = !historical && resolved?.sources.filter(source => source !== reference && scope?.has(source.itemId));
 if (installed && installed.length) {
  const links = document.createElement("ul");
  for (const source of installed) {
   const row = document.createElement("li");
   const link = document.createElement("a");
   link.href = sourceUrl(source);
   link.textContent = `${source.name} · ${source.pinned ? "pinned" : "current"} revision ${source.revision}`;
   row.append(link);
   links.append(row);
  }
  host.append(element("h3", "Installed source models"), links);
 }
 const rows: { name: string; value: unknown; unit: string; defaultValue?: unknown; source: string; overridden?: boolean }[] = [];
 for (const parameter of parameterDefinitions(project.assembly, config || undefined)) {
  rows.push({ name: parameter.name, value: values[parameter.name] ?? parameter.defaultValue,
    defaultValue: parameter.defaultValue, source: [config && config.name, ...parameter.placements].filter(Boolean).join(" · "),
    unit: "", overridden: Object.hasOwn(values, parameter.name) });
 }
 for (const parameter of reference ? reference.parameterDefinitions ?? [] : []) {
  rows.push({ name: parameter.name, value: reference && (reference.parameters?.[parameter.name] ?? parameter.defaultValue),
    defaultValue: parameter.defaultValue, source: [reference && reference.name, ...parameter.placements].filter(Boolean).join(" · "),
    unit: "", overridden: Boolean(reference && Object.hasOwn(reference.parameters ?? {}, parameter.name)) });
 }
 for (const [name, value] of Object.entries(reference ? reference.parameters ?? {} : inputs ?? {})) {
  if (rows.some(row => row.name === name)) continue;
  rows.push({ name, value, unit: "", source: reference ? reference.name : "Build inputs", overridden: Boolean(reference) });
 }
 if (legacy && !rows.length) {
  for (const name of ["width","depth","height","wall"] as const) {
   rows.push({ name, value: project.params[name], unit: "mm", source: "Saved model dimensions" });
  }
 }
 if (!rows.length) {
  host.append(element("p", "No parameters are recorded for this view."));
  return;
 }
 const table = document.createElement("table");
 table.className = "parameter-values";
 const header = table.createTHead().insertRow();
 for (const heading of ["Parameter", "Value", "Defined in"]) header.append(element("th", heading));
 const body = table.createTBody();
 for (const parameter of rows) {
  const row = body.insertRow();
  const label = element("th", parameter.name);
  label.setAttribute("scope", "row");
  const value = element("td", `${parameter.value}${parameter.unit ? " " + parameter.unit : ""}`);
  if (parameter.overridden) value.append(element("span", "Overridden"));
  if (parameter.defaultValue !== undefined) value.append(element("small", "Default " + parameter.defaultValue));
  row.append(label, value, element("td", parameter.source));
 }
 host.append(element("h3", "Parameters"), table);
}
function readParameters(raw: string | null): Record<string, number> {
 if (!raw) return {};
 try { return JSON.parse(raw) ?? {}; }
 catch { return {}; }
}
function renderSizing(occurrence?: Occurrence) {
 const box = occurrence?.bounds;
 const bounds = box && !box.isEmpty() ? { min: box.min.toArray(), max: box.max.toArray() } : undefined;
 modelSizing($("model-sizing"), {
  bounds,
  preset: legacy ? project.params : undefined,
  inputs: build?.result?.manifest?.parameters ?? build?.parameters,
  configurations: !historical && (!resolved || project.revision === resolved.revision) ? sizingConfigurations(project.assembly) : undefined,
  sources: historical ? undefined : resolved?.sources
    .filter(source => source.configuration && partInspection?.instances.has(source.itemId))
    .map(source => ({ label: source.name + " · " + source.configuration, href: sourceUrl(source), parameters: source.parameters })),
  requestBuild: !$("build-editor").hidden ? values => {
   $<HTMLTextAreaElement>("parameter-values").value = JSON.stringify(values, null, 2);
   const instruction = $<HTMLInputElement>("instruction");
   if (!instruction.value.trim()) instruction.value = "Rebuild with the selected model parameters.";
   $<HTMLFormElement>("build-request").requestSubmit();
  } : undefined,
 });
 if (!$("model-sizing").children.length) $("model-sizing").textContent = "No model dimensions or configuration inputs are available.";
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
  link.href = inspection ? occurrenceLink(item.id) : urlFor("overview", item.id);
  const occurrence = occurrenceUI?.pathFor(item.id);
  if (inspection && occurrence) link.onclick = event => {
   if (event.button || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
   event.preventDefault();
   occurrenceUI?.pick(occurrence.path);
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
 ++cotsGeneration;
 selected = undefined;
 $("isolate-item").hidden=true;
 selectionPath = undefined;
 if (inspection) {
  $("show-all").hidden = true;
  $("project-inspection").inert = true;
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
 const view = modelView(assembly, root.dataset.openAddress || query.has("inspect") ? undefined : focused?.id);
 const posterKey=JSON.stringify([project.id,project.revision,view.rootId,run?.id,location.pathname,location.search,resolved?.sources]);
 const captureUrl=!historical && !focused && !root.dataset.openAddress && !selection.size && !query.has("view") && !query.has("inspect") && import.meta.env.OUTFITTER_APP_MODE!=="demo"
   ? base+`/api/apps/workshop/projects/${project.id}/preview?revision=${project.revision}&thumbnail=1` : undefined;
 const finishPoster=poster?.show(project,view,posterKey,captureUrl);
 $("bom-heading").textContent = focused && focused.id !== assembly.rootId ? `Bill of materials · ${focused.name}` : "Bill of materials";
 if (inspection) {
  $("build-editor").hidden = !project.workspace || historical || Boolean(selection.size) || !canEdit;
  partInspection?.stop();
  inspectingParts = false;
  partInspection=inspectionControls(view,$("part-inspection-actions"),$<HTMLButtonElement>("restore-inspection"),(hidden,hinges)=>{
    viewer?.inspectParts(hidden,hinges);
    occurrenceUI?.setHidden(new Set([...hidden].map(path => occurrenceUI!.fromViewer(path))));
    const changed=Boolean(hidden.size || hinges.length);
    if(inspectingParts===changed)return;
    inspectingParts=changed;
    updateBudgetTabs(inspectedAssembly());
    if(inspection.current === "bom") renderBom();
    if(inspection.current === "power") renderPower();
  },()=>{
    pauseOperation();stopMotion();
    if(operations[opSelect.selectedIndex])seek(0);
    else if(motion){applyMotion(0);$<HTMLSelectElement>("motion-level").value="";}
    viewer?.isolate();viewer?.inspectDrive([],false);$<HTMLInputElement>("inspect-drive").checked=false;
  });
  $("part-inspection-actions").hidden=!viewer;
  const references=$("reference-images");
  const photos=new Map<string,HTMLElement>();
  for(const item of view.items) for(const file of item.files??[]) {
   if(!isReferenceImage(file.fileName))continue;
   const href=base+fileBase(file)+filePath(file);
   if(photos.has(href))continue;
   const figure=document.createElement("figure");
   const link=document.createElement("a");
   link.href=href;link.download=file.fileName;
   const image=document.createElement("img");
   image.loading="lazy"; image.src=href; image.alt=file.fileName;
   link.append(image);figure.append(link,element("figcaption",item.name));
   photos.set(href,figure);
  }
  references.querySelector("div")!.replaceChildren(...photos.values());
  references.hidden=!photos.size;
  if (!occurrenceUI?.load(assembly, focused)) {
   $("assembly-status").textContent = "Assembly occurrence unavailable.";
   return;
  }
  $("project-inspection").inert = false;
  inspection.open(occurrenceUI.savedTab ?? (query.get("inspection") === "cots" ? "cots" : "description"));
  if (!viewer) occurrenceUI.ready();
  $("purchased-parts-shortcut").querySelector("button")!.onclick = () => {
   inspection.open("cots");
   $("tab-cots").focus();
  };

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
 if (overview) {
  const full = $<HTMLAnchorElement>("full-assembly");
  full.href = urlFor("overview");
  full.hidden = !focused || focused.id === assembly.rootId;
  $<HTMLAnchorElement>("browse-models").href = urlFor("models");
  const pcb = $<HTMLAnchorElement>("inspection-pcb");
  pcb.href = base + projectPath(root.dataset.slug!, "pcb");
  pcb.hidden = root.dataset.hasPcb !== "true";
 }
 if(query.has("item")&&!focused&&assembly.items.length)notice("That item is not in this revision. Showing the full assembly.");
 const preview=arteraMotionPreview(assembly,view,run?.result?.manifest?.parameters??{});
 void viewer?.render(view,run?.result?.artifactBase??"",legacy?{params:project.params,plan:project.cadPlan}:undefined,run?.result?.manifest?.artifacts??[],signal,historical?{}:resolved?.meshes).then(async()=>{
  if(motionVersion!==motionGeneration || build!==run || $("assembly-viewer").dataset.ready!=="true")return;
  occurrenceUI?.ready();
  finishPoster?.($("assembly-viewer").hasAttribute("data-empty") || selected || occurrenceUI?.active ? undefined : ()=>viewer!.snapshot());
  const motionArtifact=run?.result?.manifest?.artifacts.find(a=>a.path.endsWith("/drive-motion.json"));
  motion=motionArtifact?undefined:preview;showMotion(Boolean(motion));
  let inline, inlineFailed=false;
  try { inline=installedDriveMotion(view); }
  catch(error){ inlineFailed=true;motion=undefined;notice(`Motion disabled: ${(error as Error).message}`); }
  if(inline) { motion=inline;savedRotations=inline.rotations;savedAxes=inline.axes; }
  else if(!inlineFailed && motionArtifact && run?.result){
   try {
    const artifactPath=run.result.artifactBase+motionArtifact.path;
    const response=await fetch(artifactPath.startsWith("/") ? base+artifactPath : artifactPath,{signal});
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
 renderCatalog();
 const manifest=run?.result?.manifest;
 $<HTMLTextAreaElement>("parameter-values").value=JSON.stringify(manifest?.parameters??{},null,2);
 $("source-files").replaceChildren();$("source-preview").textContent="";
 for(const artifact of manifest?.artifacts??[]){const path=run!.result!.artifactBase+artifact.path;const url=path.startsWith("/")?base+path:path;const a=element("a",artifact.path.split('/').at(-1)!) as HTMLAnchorElement;a.href=url;a.download=artifact.path.split('/').at(-1)!;$("source-files").append(a);if(/\.(scad|json|md|py)$/.test(artifact.path)){const b=element("button",`Read ${a.textContent}`);b.onclick=async()=>{try{const response=await fetch(url,{signal});if(!response.ok)throw Error("Cannot load source artifact");$("source-preview").textContent=await response.text();}catch(error){if(!signal.aborted)notice((error as Error).message);}};$("source-files").append(b);}}
 if (inspection) return;
 const evidence=$("revision-evidence");evidence.replaceChildren(element("h3",run?`Build ${run.id.slice(0,8)}`:"No workspace build yet"));
 if(import.meta.env.OUTFITTER_APP_MODE !== "demo" && (!run || run.id===project.workspace?.currentBuildId)) {
  const captureUrl=`/api/apps/workshop/projects/${project.id}/preview?revision=${project.revision}&evidence=1`;
  void fetch(base + captureUrl,{signal}).then(async response=>{
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
 $<HTMLSelectElement>("project-purpose").value=project.purpose ?? "product";
 $<HTMLSelectElement>("project-purpose").disabled=!canEdit || Boolean(query.get("revision") || query.get("build"));
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
$("project-purpose").onchange=async()=>{
 const control=$<HTMLSelectElement>("project-purpose");
 control.disabled=true;
 try {
  const response=await fetch(base + `/api/apps/workshop/projects/${project.id}/purpose`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:project.revision,purpose:control.value}),signal});
  if(!response.ok)throw Error(await response.text());
  project=await response.json();
  notice(project.purpose==="component"?"Saved in the component library. Existing assembly references are preserved.":"Saved as a product to manufacture.");
 } catch(error) {if(!signal.aborted){control.value=project.purpose??"product";notice((error as Error).message);}}
 finally {if(!signal.aborted)control.disabled=false;}
};
$("top-view").onclick=()=>viewer?.topView();
$("reset-view").onclick = () => viewer?.reset();
function showAll() {
 viewer?.isolate();
 occurrenceUI?.clear();
}
$("show-all").onclick = showAll;
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
if (!selection.has("revision") && !savedBuild) {
 const normalized = inspectionLink(project.assembly, query);
 if (normalized) {
   query = normalized;
   const url = new URL(location.href);
   url.search = normalized.toString();
   history.replaceState(history.state,"",url);
   for (const key of ["configuration","parameters"]) {
     if (normalized.has(key)) selection.set(key,normalized.get(key)!); else selection.delete(key);
   }
 }
}
if ((selection.size || project.assembly?.items.some(i=>i.reference)) && !savedBuild) {
 const readView = async (): Promise<ResolvedAssembly> => {
  if (import.meta.env.OUTFITTER_APP_MODE !== "demo") return request(recordPath + "/assembly?" + selection);
  const { resolveAssembly } = await import("../lib/assembly-resolution");
  return resolveAssembly(project, async ref => (await import("./fixtures")).fixtureRequest<Project>("/" + ref.projectId, "GET"), {
   projectId: project.id, configuration: selection.get("configuration") ?? undefined,
   parameters: readParameters(selection.get("parameters")),
  });
 };
 resolved=await readView();
 if(!selection.has("revision") && resolved.revision!==project.revision) {
  project=await request(recordPath);resolved=await readView();
  if(resolved.revision!==project.revision)throw Error("Project changed while opening. Reload to read the current revision.");
 }
}

render();}catch(e){if(!signal.aborted){$("project-name").textContent="Could not load project";notice((e as Error).message);}}

}
onPageLoad(start);
