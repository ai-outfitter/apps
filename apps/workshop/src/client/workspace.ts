import { displayName } from "../lib/occurrence-address";
import type { Occurrence } from "../lib/assembly-inspection";
import { assemblyPoster } from "./assembly-poster";
import { inspectionLink, sizingConfigurations } from "../lib/inspection-links";
import { occurrenceInspection } from "./occurrence-inspection";
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
import { modelCatalog, modelView } from "../lib/model-catalog";
import { fileBase, filePath, fileType, isReferenceImage } from "../lib/assembly-file";
import { appBase, projectPath } from "../lib/sections";
import { projectInspection } from "./project-inspection";
import { printableParts, renderPrintAnalysis, type PrintAnalysis } from "./print-analysis";
import { renderCotsEvidence } from "./cots-evidence";
import type { CotsEvidenceResult } from "../server/cots-evidence";
async function start(signal:AbortSignal){
const workspace = document.querySelector<HTMLElement>(".workspace");
if (!workspace) return;
const root = workspace;
const section=root.dataset.section;
const $=<T extends HTMLElement=HTMLElement>(id:string)=>root.querySelector<T>(`#${id}`)!;
const element=(tag:string,text:string)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const notice=(s:string)=>$("workspace-notice").textContent=s;
const appUrl = (path: string) => /^\/(api|files)\//.test(path) ? appBase(location.pathname) + path : path;
let legacy=false, historical=false;
let query = new URLSearchParams(location.search);
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
let cotsGeneration = 0;
function cotsRoot() { return selected?.id ?? occurrenceUI?.level?.item.id ?? query.get("item") ?? undefined; }
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
 const path = appBase(location.pathname) + `/api/apps/workshop/projects/${project.id}/cots-evidence?${parameters}`;
 try {
  const result: CotsEvidenceResult = await request(path);
  if (signal.aborted || generation !== cotsGeneration) return;
  if (result.revision !== (resolved?.revision ?? project.revision)) {
   host.textContent = "The assembly save changed. Reload to inspect its purchased parts.";
   return;
  }
  renderCotsEvidence(host, result, item => urlFor("overview", item));
 } catch {
  if (!signal.aborted && generation === cotsGeneration) host.textContent = "Could not load purchased part evidence. Reopen this tab to retry.";
 }
}
let renderedPowerFor: string | undefined;
let printGeneration = 0;
function renderPrintTab() {
 const view = modelView(assembly, cotsRoot());
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
 const path = appBase(location.pathname) + `/api/apps/workshop/projects/${project.id}/assembly?${parameters}`;
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
 occurrenceUI?.setTab(tab);
 describeInspection(tab);
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
 const item = inspection ? (inspectingParts ? occurrenceUI?.level?.item.id : cotsRoot()) : query.get("item");
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
 $("tab-print").hidden = !printableParts(modelView(assembly, cotsRoot())).size;
}
let viewer: ReturnType<typeof import("./assembly-viewer").createAssemblyViewer> | undefined;
let occurrenceUI: ReturnType<typeof occurrenceInspection> | undefined;
if (overview) {
 try {
  const { createAssemblyViewer } = await import("./assembly-viewer");
  if (signal.aborted) return;
  viewer = createAssemblyViewer($<HTMLCanvasElement>("assembly-viewer"),
    message => $("assembly-status").textContent = message,
    (_id, path, drill) => occurrenceUI?.pick(path, drill), showAll);
 } catch {
  if (signal.aborted) return;
  $("assembly-status").textContent = "3D preview unavailable in this browser.";
  $("assembly-viewer").hidden = true;
  $("view-tools").hidden = true;
  $("isolate-item").hidden = true;
 }
 occurrenceUI = occurrenceInspection(root, viewer, signal, renderLevelDetails, level => {
  const { number } = displayName(level.item);
  return [number, level.item.kind, "Rev " + level.item.revision, "Installed: " + (selection.get("configuration") ?? "Saved assembly"),
    "Project save " + (resolved?.revision ?? project.revision)].filter(Boolean).join(" · ");
 }, notice);
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
const request=async(path:string,method="GET",body?:unknown)=>{const r=await fetch(appUrl(path),{signal,method,headers:body?{"Content-Type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(await r.text());return r.json();};
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
function renderLevelDetails(pick: Occurrence | undefined, level: Occurrence | undefined, tab: string) {
 if (!inspection) return;
 const target = pick ?? level;
 selected = pick?.item;
 selectionPath = pick?.path;
 viewer?.isolate();
 viewer?.select(pick ? descendants(pick.item) : undefined, pick?.path);
 $("isolate-item").hidden = !viewer || !pick;
 $("show-all").hidden = !viewer || !pick;
 const details = $("selected-body");
 details.replaceChildren();
 $("detail-scope").textContent = pick ? "Selected component" : "Open level";
 $("selected-name").textContent = target?.label ?? project.name;
 $("selected-meta").textContent = target
   ? [displayName(target.item).number, target.item.kind === "cots" ? "Purchased part (COTS)" : target.item.kind, "Rev " + target.item.revision].filter(Boolean).join(" · ")
   : "";
 $("project-brief").hidden = !!pick || level?.path !== assembly.rootId || !project.brief;
 $("purpose-field").hidden = Boolean(pick || level?.path !== assembly.rootId);
 if (target) {
  renderComponent(details, target.item, target.path === assembly.rootId);
 } else {
  details.append(element("p", "No saved assembly is available."));
 }
 partInspection?.select(pick?.path);
 const bounds = target && !target.bounds.isEmpty() ? { min: target.bounds.min.toArray(), max: target.bounds.max.toArray() } : undefined;
 $("tab-sizing").hidden = !modelSizing($("model-sizing"), {
  bounds,
  preset: legacy ? project.params : undefined,
  configurations: !historical && (!resolved || project.revision === resolved.revision) ? sizingConfigurations(project.assembly) : undefined,
  configurationUrl: new URL(urlFor("overview"), location.origin),
  inputs: $("build-editor").hidden ? undefined : build?.result?.manifest?.parameters ?? build?.parameters,
  requestBuild: $("build-editor").hidden ? undefined : values => {
   $<HTMLTextAreaElement>("parameter-values").value = JSON.stringify(values, null, 2);
   const instruction = $<HTMLInputElement>("instruction");
   if (!instruction.value.trim()) instruction.value = "Rebuild with the selected model parameters.";
   $<HTMLFormElement>("build-request").requestSubmit();
  },
 });
 renderSource(target);
 updateBudgetTabs(inspectedAssembly());
 inspection.open(tab);
}

function renderComponent(details: HTMLElement, item: Item, isProduct: boolean) {
 if (item.notes) details.append(element("p", item.notes));
 const facts = element("dl", "");
 function fact(label: string, value: HTMLElement | string) {
  const entry = element("dd", "");
  entry.append(value);
  facts.append(element("dt", label), entry);
 }
 if (!isProduct) {
  const model = element("a", "Open standalone model") as HTMLAnchorElement;
  model.href = urlFor("overview", item.id);
  fact("Model", model);
 }
 if (item.geometry || item.mesh) fact("Geometry", item.provenance);
 if (item.kind !== "assembly") fact("Unit price", itemPrice(item));
 if (item.manufacturer) fact("Manufacturer", item.manufacturer);
 if (item.mpn) fact("Manufacturer part number", item.mpn);
 const supplier = element("span", "");
 appendPartSource(supplier, item.source);
 if (supplier.childElementCount) fact("Supplier", supplier);
 if (facts.childElementCount) details.append(facts);
 if (item.files?.length) details.append(element("h4", "Files"));
 for (const file of item.files ?? []) {
  const href = appBase(location.pathname) + fileBase(file) + filePath(file);
  const link = document.createElement("a");
  link.href = href;
  link.download = file.fileName;
  link.textContent = "Download " + file.fileName;
  details.append(link);
  const type = fileType(file.fileName);
  if (type.startsWith("video/")) {
   const video = document.createElement("video");
   video.controls = true; video.preload = "none"; video.src = href;
   details.append(video);
  } else if (type.startsWith("image/")) {
   const image = document.createElement("img");
   image.src = href; image.alt = file.fileName; image.loading = "lazy";
   details.append(image);
  }
 }
}

function renderSource(target?: Occurrence) {
 const host = $("source-record");
 const files = $("source-files");
 host.replaceChildren();
 files.replaceChildren();
 const run = build;
 const manifest = run?.result?.manifest;
 const source = !historical && target && occurrenceUI?.nearest(target.path,
  item => Boolean(resolved?.sources.some(value => value.itemId === item.id)));
 const record = source ? resolved?.sources.find(value => value.itemId === source.id) : undefined;
 const revision = record?.revision ?? resolved?.revision ?? project.revision;
 const configuration = record?.configuration ?? selection.get("configuration");
 const title = element("h3", "Source record");
 const facts = element("dl", "");
 const fact = (label: string, value: string | HTMLElement) => {
  const dd = element("dd", "");
  dd.append(value);
  facts.append(element("dt", label), dd);
 };
 if (record) {
  const link = element("a", record.name) as HTMLAnchorElement;
  link.href = sourceUrl(record);
  fact("Source model", link);
 }
 fact("Revision", "Project save " + revision + (record?.pinned ? " (pinned)" : ""));
 if (configuration) fact("Configuration", configuration);
 if (!record && !historical && target && resolved?.sources.length) {
  const scope = descendants(target.item);
  for (const source of resolved.sources.filter(source => scope.has(source.itemId))) {
   const label = source.name + " · " + (source.pinned ? "pinned" : "current") + " revision " + source.revision +
     (source.configuration ? " · " + source.configuration : "");
   const link = element("a", label) as HTMLAnchorElement;
   link.href = sourceUrl(source);
   fact("Installed source", link);
  }
 }
 if (!record && run) {
  fact("Build status", run.status);
  fact("Source commit", manifest?.sourceCommit ?? run.sourceCommit);
  if (run.sourceDir) fact("Source directory", run.sourceDir);
 } else if (!record) {
  fact("Build status", "No saved workspace build");
 }
 host.append(title, facts);

 const format = (name: string) => {
  const label = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
 };
 const definitions = record?.parameterDefinitions ?? (!record && configuration
   ? sizingConfigurations(project.assembly)?.find(config => config.name === configuration)?.parameters : undefined) ?? [];
 const overrides: Record<string, number> = record?.parameters ?? (!record ? JSON.parse(selection.get("parameters") ?? "{}") : {});
 const buildValues = !record && !configuration ? manifest?.parameters ?? run?.parameters : undefined;
 const values = new Map<string, { value: unknown; baseline?: number; origin: string; overridden?: boolean; unit?: string }>();
 for (const definition of definitions) {
  const overridden = Object.hasOwn(overrides, definition.name) && overrides[definition.name] !== definition.defaultValue;
  values.set(definition.name, {
   value: overrides[definition.name] ?? definition.defaultValue, baseline: definition.defaultValue, overridden,
   origin: configuration ?? "Assembly configuration",
  });
 }
 for (const [name, value] of Object.entries(overrides))
  if (!values.has(name)) values.set(name, { value, origin: "Installed configuration", overridden: true });
 for (const [name, value] of Object.entries(buildValues ?? {})) values.set(name, { value, origin: "Workspace build" });
 if (legacy && !values.size) {
  const { width, depth, height, wall } = project.params;
  for (const [name, value] of Object.entries({ width, depth, height })) values.set(name, { value, unit: "mm", origin: "Saved CAD preset" });
  if (!["cube", "custom"].includes(project.params.design)) values.set("wall thickness", { value: wall, unit: "mm", origin: "Saved CAD preset" });
 }
 host.append(element("h3", "Parameters"));
 if (!values.size) host.append(element("p", "No parameter values are recorded for this source."));
 else {
  const parameters = element("dl", "");
  for (const [name, value] of values) {
   const dd = element("dd", [String(value.value), value.unit].filter(Boolean).join(" "));
   const metadata = [value.overridden ? "Overridden" : "", value.baseline !== undefined ? "Default " + value.baseline : "", value.origin].filter(Boolean);
   dd.append(element("small", metadata.join(" · ")));
   parameters.append(element("dt", format(name)), dd);
  }
  host.append(parameters);
 }
 if (!record && run && manifest) {
  for (const artifact of manifest.artifacts.filter(entry => /(?:source\.tar|\.(?:scad|py|step|stp))$/i.test(entry.path))) {
   const label = artifact.path.split("/").at(-1)!;
   const link = element("a", label === "source.tar" ? "Download source archive" : label) as HTMLAnchorElement;
   link.href = appUrl(run.result!.artifactBase + artifact.path);
   link.download = label;
   files.append(link);
  }
 }
 if (!files.childElementCount && !record) files.append(element("small", "No source artifact is attached."));
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
  link.textContent = displayName(item).name;
  link.href = urlFor("overview", item.id);
  const installed = occurrenceUI?.level?.children.filter(child => child.item.id === item.id) ?? [];
  if (installed.length === 1) {
   link.href = occurrenceUI?.href(installed[0].path) ?? link.href;
   link.onclick = event => {
    if (event.button || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    occurrenceUI?.pick(installed[0].path);
    inspection?.open("description");
   };
  }
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
 if (inspection) $("show-all").hidden = true;
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
 const captureUrl=!historical && !focused && !selection.size && !root.dataset.level && !["view","inspect","sel","explode"].some(key => query.has(key)) && import.meta.env.OUTFITTER_APP_MODE!=="demo"
   ? appBase(location.pathname)+`/api/apps/workshop/projects/${project.id}/preview?revision=${project.revision}&thumbnail=1` : undefined;
 $("bom-heading").textContent = focused && focused.id !== assembly.rootId ? `Bill of materials · ${focused.name}` : "Bill of materials";
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
  },()=>{
    pauseOperation();stopMotion();
    if(operations[opSelect.selectedIndex])seek(0);
    else if(motion){applyMotion(0);$<HTMLSelectElement>("motion-level").value="";}
    viewer?.isolate();viewer?.inspectDrive([],false);$<HTMLInputElement>("inspect-drive").checked=false;
  });
  $("part-inspection-actions").hidden=!viewer;
  $("project-inspection").inert = false;
  const references=$("reference-images");
  const photos=new Map<string,HTMLElement>();
  for(const item of view.items) for(const file of item.files??[]) {
   if(!isReferenceImage(file.fileName))continue;
   const href=appBase(location.pathname)+fileBase(file)+filePath(file);
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
  const shortcut = $("purchased-parts-shortcut");
  shortcut.querySelector("button")!.onclick = () => {
   inspection.open("cots");
   $("tab-cots").focus();
  };
  const edit = Boolean(project.workspace && !historical && !selection.size && import.meta.env.OUTFITTER_APP_MODE !== "demo");
  $("build-editor").hidden = !edit;
  $<HTMLTextAreaElement>("parameter-values").value = JSON.stringify(run?.result?.manifest?.parameters ?? run?.parameters ?? {}, null, 2);
  const runs = project.workspace?.requests ?? [];
  $("runner-status").textContent = runs.length ? `${runs.at(-1)!.status} · runner ${runs.at(-1)!.runner}` : "";
  occurrenceUI?.load(view);
  if (!occurrenceUI?.level) renderLevelDetails(undefined, undefined, "description");
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
  $<HTMLAnchorElement>("browse-models").href = urlFor("models");
  const productHome = $<HTMLAnchorElement>("product-home");
  productHome.href = urlFor("overview");
  productHome.hidden = !focused || focused.id === assembly.rootId || Boolean(occurrenceUI?.active && root.dataset.level);
  const pcb = $<HTMLAnchorElement>("product-pcb");
  if (pcb) pcb.href = appBase(location.pathname) + projectPath(root.dataset.slug!, "pcb");
 }
 if(query.has("item")&&!focused&&assembly.items.length)notice("That item is not in this revision. Showing the full assembly.");
 const staticView = occurrenceUI?.level ? modelView(view, occurrenceUI.level.item.id) : view;
 const finishPoster = poster?.show(project, staticView, posterKey, captureUrl);
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
 renderCatalog();
 const manifest = run?.result?.manifest;
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
 $("project-name").textContent=project.name;
 if(overview) $("product-identity").textContent=project.name;
 $<HTMLSelectElement>("project-purpose").value=project.purpose ?? "product";
 $<HTMLSelectElement>("project-purpose").disabled=import.meta.env.OUTFITTER_APP_MODE==="demo" || Boolean(query.get("revision") || query.get("build"));
 if (overview) {
  $("project-brief").textContent = project.brief;
  $("project-brief").hidden = !project.brief;
 }
 const runs=project.workspace?.requests??[];
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
  const response=await fetch(appUrl(`/api/apps/workshop/projects/${project.id}/purpose`),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:project.revision,purpose:control.value}),signal});
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
if (overview) $("build-request").onsubmit=async(e)=>{e.preventDefault();try{const w=project.workspace;const previous=build??w?.requests.at(-1);if(!w||!previous)throw Error("Connect a project workspace through RequestWorkshopBuild first.");const parameters=JSON.parse($<HTMLTextAreaElement>("parameter-values").value);project=await request(`/api/apps/workshop/projects/${project.id}/builds`,"POST",{id:project.id,revision:project.revision,repository:w.repository,sourceDir:w.sourceDir,sourceCommit:previous.result?.manifest?.sourceCommit??previous.sourceCommit,instructions:$<HTMLInputElement>("instruction").value,parameters,runner:previous.runner});render();notice("Build queued. The workspace runner must claim and execute it.");}catch(e){notice((e as Error).message);}};
try{
 if(import.meta.env.OUTFITTER_APP_MODE==="demo"){
   const {fixtureProjects}=await import("./fixtures");
   const found=fixtureProjects().find(p=>p.id.endsWith(root.dataset.slug!.split("-").at(-1)!));
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
const initial = root.querySelector<HTMLTemplateElement>("#resolved-assembly");
if (initial?.content.textContent) resolved = JSON.parse(initial.content.textContent);
if (import.meta.env.OUTFITTER_APP_MODE === "demo" && (selection.has("configuration") || selection.has("parameters"))) {
 const { configuredAssembly } = await import("../lib/assembly-resolution");
 const { assemblySelection } = await import("../lib/assembly-selection");
 project = { ...project, assembly: configuredAssembly(project.assembly, assemblySelection(project.id, selection)) };
} else if ((selection.size || project.assembly?.items.some(i=>i.reference)) && !savedBuild) {
 const readView=():Promise<ResolvedAssembly>=>request(recordPath+"/assembly?"+selection);
 resolved ??= await readView();
 if(!selection.has("revision") && resolved.revision!==project.revision) {
  project=await request(recordPath);resolved=await readView();
  if(resolved.revision!==project.revision)throw Error("Project changed while opening. Reload to read the current revision.");
 }
}
render();}catch(e){if(!signal.aborted){$("project-name").textContent="Could not load project";notice((e as Error).message);}}

}
onPageLoad(start);
