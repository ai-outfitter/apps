import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { PrintPackageSchema, PrintPlateInput } from "../lib/print-plates";
import { ProjectSchema } from "../lib/project";
import { resolvedProject } from "./assembly-references";
import type { WorkshopContext } from "./graphql";
import { printableUses, storedPrintBytes } from "./print-analysis";
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

export async function parseSlicedPrintPackage(artifact:Uint8Array, result:Uint8Array, plates:Input["plates"], parts:Part[]) {
  // Inspect bounded central-directory entries only. Toolpaths can be large and do
  // not need to be decompressed to read the slicer's recorded plate summaries.
  const filenames = new Set<string>();
  const entries = unzipSync(artifact, {filter:entry=>{
    if (entry.name.match(/^Metadata\/plate_\d+\.gcode$/) && entry.originalSize > 0) filenames.add(entry.name);
    return ["Metadata/project_settings.config","Metadata/slice_info.config"].includes(entry.name) && entry.originalSize <= 1_000_000;
  }});
  const settings = entries["Metadata/project_settings.config"];
  const summary = entries["Metadata/slice_info.config"];
  if (!settings || !summary) throw invalid("3MF is missing its native profile or slice summary");
  const profile = Profile.parse(JSON.parse(strFromU8(settings)));
  const resultData = SliceResult.parse(JSON.parse(strFromU8(result)));
  const summaryPlates = new Map<number,string>();
  for (const [ , xml] of strFromU8(summary).matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const index = Number(xml.match(/<metadata key="index" value="(\d+)"\/>/)?.[1]);
    if (!Number.isInteger(index) || summaryPlates.has(index)) throw invalid("Invalid 3MF plate summary");
    summaryPlates.set(index,xml);
  }
  if (plates.length !== summaryPlates.size || plates.length !== resultData.sliced_plates.length ||
      new Set(plates.map(plate=>plate.index)).size !== plates.length) throw invalid("Include each sliced plate exactly once");
  const assigned = new Map<string,number>();
  const results = plates.map(plate=>{
    const actual = resultData.sliced_plates.find(entry=>entry.id===plate.index);
    const xml = summaryPlates.get(plate.index);
    if (!actual || !xml || !filenames.has(`Metadata/plate_${plate.index}.gcode`)) throw invalid("Plate is missing its slice result or G-code");
    const declaredNames = plate.members.flatMap(member=>{
      const part = parts.find(candidate=>candidate.itemId===member.itemId && candidate.sha256===member.sha256);
      const quantity = (assigned.get(member.itemId) ?? 0) + member.quantity;
      if (!part?.fileName || quantity > part.quantity) throw invalid("Plate membership differs from the current printable assembly");
      assigned.set(member.itemId,quantity);
      return Array.from({length:member.quantity},()=>part.fileName!);
    });
    const nativeNames = [...xml.matchAll(/<object\s+identify_id="[^"]+"\s+name="([^"]+)"\s+skipped="false"\s*\/>/g)].map(match=>decodeXml(match[1]));
    if (sort(declaredNames) !== sort(actual.objects.map(object=>object.name)) || sort(declaredNames) !== sort(nativeNames))
      throw invalid("Plate object names or quantities differ from the slicer output");
    const filamentGrams = actual.filaments.reduce((sum,filament)=>sum+filament.total_used_g,0);
    const roundedTime = Number(xml.match(/<metadata key="prediction" value="([\d.]+)"\/>/)?.[1]);
    const roundedWeight = Number(xml.match(/<metadata key="weight" value="([\d.]+)"\/>/)?.[1]);
    if (!(Math.abs(actual.total_predication-roundedTime)<1 && Math.abs(filamentGrams-roundedWeight)<0.011))
      throw invalid("Plate estimates disagree between the slicer report and the 3MF");
    return {...plate, durationSeconds:actual.total_predication,filamentGrams,warnings:actual.warning_message.trim()?[actual.warning_message]:[]};
  });
  return {plates:results,printer:profile.printer_model,material:profile.filament_settings_id.join(", ").slice(0,160),
    profileSha256:await sha256Hex(Uint8Array.from(settings))};
}

export async function recordWorkshopPrintPlate(context:WorkshopContext, input:Input) {
  const {projectId,expectedRevision,...evidence} = input;
  const project = await getWorkshopProject(context.db(),projectId);
  const packages = project.printPackages ?? [];
  const previous = packages.find(entry=>entry.artifact.sha256===input.artifact.sha256);
  if (previous) {
    const plates = previous.plates.map(({durationSeconds,filamentGrams,warnings,...identity})=>identity);
    if (JSON.stringify(plates)!==JSON.stringify(input.plates) || previous.result.sha256!==input.result.sha256)
      throw new Response("This slice package was already recorded with different evidence", {status:409});
    return {status:"recorded",projectId,revision:project.revision,plates:previous.plates};
  }
  if (project.revision !== expectedRevision) throw new Response("Project changed; reload before recording the print", {status:409});
  if (packages.length >= 20) throw new Response("Print package limit reached", {status:409});
  const parts = printableUses(await resolvedProject(context.db(),{projectId,revision:expectedRevision}));
  const storage = context.storage();
  const uploads = [];
  const staged = await storage.list("builds",{prefix:projectId+"/print/",limit:1000});
  const stagedSize = staged.reduce((size,entry)=>size+entry.size,0);
  for (const [source,contentType] of [[input.artifact,"application/zip"],[input.result,"application/json"]] as const) {
    const target = {space:"builds",key:key(projectId,source)};
    const head = await storage.head(target);
    if (head?.sha256===source.sha256 && head.size===source.bytes && head.contentType===contentType) continue;
    const declaration = {sha256:source.sha256,size:source.bytes,contentType};
    const bytes = await storage.takeUpload(target,declaration);
    if (!bytes) uploads.push({fileName:source.fileName,...storage.uploadTicket(target,declaration)});
    else {
      if (staged.length >= 70 || stagedSize + input.artifact.bytes + input.result.bytes > 250_000_000)
        throw new Response("Print evidence storage limit reached", {status:413});
      await storage.put(target.space,target.key,bytes,{contentType});
      await storage.discardUpload(target,declaration);
    }
  }
  if (uploads.length) return {status:"awaiting_upload",uploads};
  const artifact = await storedPrintBytes(context,key(projectId,input.artifact),input.artifact);
  const result = await storedPrintBytes(context,key(projectId,input.result),input.result);
  if (!artifact || !result) throw invalid("Uploaded slice package differs from its receipts");
  let parsed;
  try { parsed = await parseSlicedPrintPackage(artifact,result,input.plates,parts); }
  catch (error) { if (error instanceof Response) throw error; throw invalid("Could not read the Bambu Studio slice package"); }
  const saved = PrintPackageSchema.parse({...evidence,...parsed,sourceRevision:project.revision,
    recordedAt:new Date().toISOString(),recordedBy:context.identity.userId});
  const updated = {...project,printPackages:[...packages,saved]};
  if (!ProjectSchema.safeParse(updated).success) throw new Response("Print evidence exceeds project storage limit", {status:413});
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
      const state = verified && matches ? "completed" as const : "stale" as const;
      output.push({...plate,members,printer,material,slicer,profileSha256,state,
        ...(verified && {artifact:download(projectId,artifact),report:download(projectId,result)})});
    }
  }
  return output;
}
