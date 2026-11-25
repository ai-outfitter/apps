import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { PrintPackageSchema, PrintPlateInput } from "../lib/print-plates";
import { ProjectSchema } from "../lib/project";
import { resolvedProject } from "./assembly-references";
import type { WorkshopContext } from "./graphql";
import { printableUses, storedPrintBytes } from "./print-analysis";
import { matchesSlicedMesh, slicedGeometry } from "./slice-geometry";
import { getWorkshopProject, updateWorkshopProject } from "./projects";

type Input = z.infer<typeof PrintPlateInput>;
type Source = Pick<Input["artifact"],"fileName"|"sha256"|"bytes">;
type Part = { itemId:string; fileName?:string; sha256?:string; quantity:number };
const key = (projectId:string, source:Source) => `${projectId}/print/${source.sha256}/${source.fileName}`;
const download = (projectId:string, source:Source) => ({...source,downloadPath:`/files/main/builds/${key(projectId,source)}`});
const invalid = (message:string) => new Response(message, {status:400});
const sort = (values:string[]) => [...values].sort().join("\n");
const decodeXml = (value:string) => value.replace(/&(?:amp|quot|lt|gt|apos);/g, match =>
  ({"&amp;":"&","&quot;":'"',"&lt;":"<","&gt;":">","&apos;":"'"} as Record<string,string>)[match]);

const SliceResult = z.object({
  return_code:z.literal(0),
  sliced_plates:z.array(z.object({
    id:z.number().int().positive(),
    total_predication:z.number().positive(),
    warning_message:z.string().max(2000),
    filaments:z.array(z.object({total_used_g:z.number().nonnegative()})).min(1),
    objects:z.array(z.object({name:z.string().min(1).max(160)})).min(1).max(1000),
  })).min(1).max(30),
});
const Profile = z.object({
  printer_model:z.string().min(1).max(160),
  filament_settings_id:z.array(z.string().min(1).max(120)).min(1).max(10),
});

export async function parseSlicedPrintPackage(artifact:Uint8Array, result:Uint8Array, plates:Input["plates"], parts:Part[], loadPart:(part:Part)=>Promise<Uint8Array|undefined>) {
  // Inspect bounded central-directory entries only. Toolpaths can be large and do
  // not need to be decompressed to read the slicer's recorded plate summaries.
  const filenames = new Set<string>();
  const seen = new Set<string>();
  let xmlBytes = 0;
  const entries = unzipSync(artifact, {filter:entry=>{
    if (seen.has(entry.name)) throw invalid("3MF contains a repeated file path");
    seen.add(entry.name);
    if (entry.originalSize > 0) filenames.add(entry.name);
    const inspect = ["Metadata/project_settings.config","Metadata/slice_info.config","Metadata/model_settings.config","3D/3dmodel.model"].includes(entry.name) ||
      /^3D\/Objects\/[a-zA-Z0-9_.-]+\.model$/.test(entry.name);
    if (inspect && (xmlBytes+=entry.originalSize)>12_000_000) throw invalid("3MF geometry exceeds the verification size limit");
    return inspect;
  }});
  const settings = entries["Metadata/project_settings.config"];
  const summary = entries["Metadata/slice_info.config"];
  if (!settings || !summary) throw invalid("3MF is missing its native profile or slice summary");
  const profile = Profile.parse(JSON.parse(strFromU8(settings)));
  const resultData = SliceResult.parse(JSON.parse(strFromU8(result)));
  const summaryXml = strFromU8(summary);
  const slicerVersion = summaryXml.match(/<header_item key="X-BBL-Client-Version" value="([\d.]+)"\s*\/>/)?.[1];
  if (!slicerVersion) throw invalid("3MF is missing the Bambu Studio slicer version");
  const summaryPlates = new Map<number,string>();
  for (const [ , xml] of summaryXml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const index = Number(xml.match(/<metadata key="index" value="(\d+)"\/>/)?.[1]);
    if (!Number.isInteger(index) || summaryPlates.has(index)) throw invalid("Invalid 3MF plate summary");
    summaryPlates.set(index,xml);
  }
  if (plates.length !== summaryPlates.size || plates.length !== resultData.sliced_plates.length ||
      new Set(plates.map(plate=>plate.index)).size !== plates.length) throw invalid("Include each sliced plate exactly once");
  const geometry = slicedGeometry(entries);
  if (geometry.size!==plates.length) throw invalid("3MF model settings omit a sliced plate");
  const assigned = new Map<string,number>();
  const checked = new WeakMap<number[],Map<string,boolean>>();
  const results = [];
  for (const plate of plates) {
    const actual = resultData.sliced_plates.find(entry=>entry.id===plate.index);
    const xml = summaryPlates.get(plate.index);
    if (!actual || !xml || !filenames.has(`Metadata/plate_${plate.index}.gcode`)) throw invalid("Plate is missing its slice result or G-code");
    const candidates = plate.members.flatMap(member=>{
      const part = parts.find(candidate=>candidate.itemId===member.itemId && candidate.sha256===member.sha256);
      const quantity = (assigned.get(member.itemId) ?? 0) + member.quantity;
      if (!part?.fileName || quantity > part.quantity) throw invalid("Plate membership differs from the current printable assembly");
      assigned.set(member.itemId,quantity);
      return Array.from({length:member.quantity},()=>part);
    });
    const declaredNames = candidates.map(part=>part.fileName!);
    const native = [...xml.matchAll(/<object\s+identify_id="([^"]+)"\s+name="([^"]+)"\s+skipped="false"\s*\/>/g)]
      .map(([,id,name])=>({id,name:decodeXml(name)}));
    const meshes = geometry.get(plate.index);
    if (new Set(native.map(object=>object.id)).size!==native.length || meshes?.size!==native.length ||
        sort(declaredNames) !== sort(actual.objects.map(object=>object.name)) || sort(declaredNames) !== sort(native.map(object=>object.name)))
      throw invalid("Plate object names or quantities differ from the slicer output");
    for (const object of native) {
      const vertices = meshes!.get(object.id);
      if (!vertices) throw invalid("A sliced object has no matching 3MF build geometry");
      const hashes = checked.get(vertices)??new Map<string,boolean>();
      checked.set(vertices,hashes);
      let matched = false;
      for (let i=0;i<candidates.length;i++) {
        const part = candidates[i];
        if (part.fileName!==object.name || !part.sha256) continue;
        let matches = hashes.get(part.sha256);
        if (matches===undefined) {
          const bytes = await loadPart(part);
          if (!bytes) throw invalid("Stored STL bytes are unavailable for verifying the sliced geometry");
          matches = matchesSlicedMesh(bytes,vertices);
          hashes.set(part.sha256,matches);
        }
        if (!matches) continue;
        candidates.splice(i,1);
        matched=true;
        break;
      }
      if (!matched) throw invalid(`Sliced geometry differs from the current STL for ${object.name}`);
    }
    const filamentGrams = actual.filaments.reduce((sum,filament)=>sum+filament.total_used_g,0);
    const roundedTime = Number(xml.match(/<metadata key="prediction" value="([\d.]+)"\/>/)?.[1]);
    const roundedWeight = Number(xml.match(/<metadata key="weight" value="([\d.]+)"\/>/)?.[1]);
    if (!(Math.abs(actual.total_predication-roundedTime)<1 && Math.abs(filamentGrams-roundedWeight)<0.011))
      throw invalid("Plate estimates disagree between the slicer report and the 3MF");
    results.push({...plate, durationSeconds:actual.total_predication,filamentGrams,warnings:actual.warning_message.trim()?[actual.warning_message]:[]});
  }
  return {plates:results,printer:profile.printer_model,material:profile.filament_settings_id.join(", ").slice(0,160),
    slicer:`Bambu Studio ${slicerVersion}`,profileSha256:await sha256Hex(Uint8Array.from(settings))};
}

export async function recordWorkshopPrintPlate(context:WorkshopContext, input:Input) {
  const {projectId,expectedRevision,...evidence} = input;
  const project = await getWorkshopProject(context.db(),projectId);
  const packages = project.printPackages ?? [];
  const previous = packages.find(entry=>entry.artifact.sha256===input.artifact.sha256);
  if (previous?.geometryVerified) {
    const plates = previous.plates.map(({durationSeconds,filamentGrams,warnings,...identity})=>identity);
    if (JSON.stringify(plates)!==JSON.stringify(input.plates) || previous.result.sha256!==input.result.sha256)
      throw new Response("This slice package was already recorded with different evidence", {status:409});
    return {status:"recorded",projectId,revision:project.revision,plates:previous.plates};
  }
  if (project.revision !== expectedRevision) throw new Response("Project changed; reload before recording the print", {status:409});
  if (!previous && packages.length >= 20) throw new Response("Print package limit reached", {status:409});
  const parts = printableUses(await resolvedProject(context.db(),{projectId,revision:expectedRevision}));
  const storage = context.storage();
  const uploads = [];
  const stored = [];
  const toPromote = [];
  const currentReceipts = new Map(packages.filter(entry=>entry!==previous)
    .flatMap(entry=>[entry.artifact,entry.result]).map(receipt=>[key(projectId,receipt),receipt.bytes]));
  for (const [source,contentType] of [[input.artifact,"application/zip"],[input.result,"application/json"]] as const) {
    const objectKey = key(projectId,source);
    currentReceipts.set(objectKey,source.bytes);
    const target = {space:"builds",key:objectKey};
    const declaration = {sha256:source.sha256,size:source.bytes,contentType};
    const existing = await storedPrintBytes(context,objectKey,source);
    if (existing) {
      stored.push(existing);
      continue;
    }
    const bytes = await storage.takeUpload(target,declaration);
    if (!bytes) uploads.push({fileName:source.fileName,...storage.uploadTicket(target,declaration)});
    else {
      stored.push(bytes);
      toPromote.push({target,declaration,bytes});
    }
  }
  if ([...currentReceipts.values()].reduce((sum,bytes)=>sum+bytes,0)>250_000_000)
    throw new Response("Print evidence storage limit reached",{status:413});
  if (uploads.length) return {status:"awaiting_upload",uploads};
  const [artifact,result] = stored;
  let parsed;
  const meshes = new Map(parts.map(part=>[part.itemId,part.mesh]));
  try {
    parsed = await parseSlicedPrintPackage(artifact,result,input.plates,parts,async part=>{
      const mesh = meshes.get(part.itemId);
      if (!mesh || mesh.artifact.sha256!==part.sha256) return;
      return storedPrintBytes(context,mesh.base.slice("/files/main/builds/".length)+mesh.artifact.path,mesh.artifact);
    });
  }
  catch (error) { if (error instanceof Response) throw error; throw invalid("Could not read the Bambu Studio slice package"); }
  const saved = PrintPackageSchema.parse({...evidence,...parsed,sourceRevision:project.revision,
    geometryVerified:true,recordedAt:new Date().toISOString(),recordedBy:context.identity.userId});
  const updated = {...project,printPackages:[...packages.filter(entry=>entry!==previous),saved]};
  if (!ProjectSchema.safeParse(updated).success) throw new Response("Print evidence exceeds project storage limit", {status:413});
  for (const {target,declaration,bytes} of toPromote) {
    await storage.put(target.space,target.key,bytes,{contentType:declaration.contentType});
    await storage.discardUpload(target,declaration);
  }
  const next = await updateWorkshopProject(context.db(),context.identity,updated,projectId,true);
  return {status:"recorded",projectId,revision:next.revision,plates:saved.plates};
}

export async function listPrintPlates(context:WorkshopContext, projectId:string, parts:Part[]) {
  const project = await getWorkshopProject(context.db(),projectId);
  const output = [];
  for (const saved of project.printPackages ?? []) {
    const {artifact,result,plates,printer,material,slicer,profileSha256} = saved;
    const [file,report] = await Promise.all([context.storage().head({space:"builds",key:key(projectId,artifact)}),
      context.storage().head({space:"builds",key:key(projectId,result)})]);
    const verified = file?.sha256===artifact.sha256 && file.size===artifact.bytes && report?.sha256===result.sha256 && report.size===result.bytes;
    const quantities = new Map<string,number>();
    for (const member of plates.flatMap(plate=>plate.members)) {
      quantities.set(member.itemId,(quantities.get(member.itemId)??0)+member.quantity);
    }
    for (const plate of plates) {
      const members = plate.members.map(member=>{
        const current = parts.find(part=>part.itemId===member.itemId && part.sha256===member.sha256);
        return {...member,...(current?.fileName && {fileName:current.fileName})};
      });
      const matches = plate.members.every(member=>parts.some(part=>part.itemId===member.itemId &&
        part.sha256===member.sha256 && part.quantity >= quantities.get(member.itemId)!));
      const state = saved.geometryVerified && verified && matches ? "completed" as const : "stale" as const;
      output.push({...plate,members,printer,material,slicer,profileSha256,state,
        ...(verified && {artifact:download(projectId,artifact),report:download(projectId,result)})});
    }
  }
  return output;
}
