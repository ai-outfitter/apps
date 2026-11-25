import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { assemblyFile, fileName, filePath, fileBase, fileType, type AssemblyFile } from "../lib/assembly-file";
import { meshBounds } from "../lib/assembly";
import type { WorkshopContext } from "./graphql";
import { analyzePrint, printWarnings, storedPrintBytes } from "./print-analysis";
import { getWorkshopProject, patchWorkshopProject } from "./projects";

export const uploadInput = assemblyFile.extend({
  itemId:z.uuid(), expectedRevision:z.number().int().nonnegative(), meshBounds:meshBounds.optional(),
}).refine(i=>(fileType(i.fileName)==="model/stl")===Boolean(i.meshBounds),"Supply meshBounds for STL only")
  .refine(i=>!i.supportPolicy || fileType(i.fileName)==="model/stl","Supply supportPolicy for STL only");
export const verifyInput = z.object({projectId:z.uuid(), itemId:z.uuid(), fileName, byteOffset:z.number().int().nonnegative().optional(), expectedSha256:assemblyFile.shape.sha256.optional()}).strict();
const target = (file:AssemblyFile) => ({space:"builds",key:file.projectId+"/assembly/"+filePath(file)});
const receipt = (file:AssemblyFile) => ({...file,contentType:fileType(file.fileName),downloadPath:fileBase(file)+filePath(file)});

export async function uploadAssemblyFile(c:WorkshopContext, input:z.infer<typeof uploadInput>) {
  const {itemId,expectedRevision,meshBounds:bounds,...file}=input;
  const project=await getWorkshopProject(c.db(),file.projectId);
  const item=project.assembly.items.find(i=>i.id===itemId);
  if (!item || item.reference) throw new Response("Select a saved item in its owning project",{status:400});
  const storage=c.storage(), key=target(file), contentType=fileType(file.fileName);
  const existing=item.files?.find(f=>f.fileName===file.fileName);
  const path=filePath(file);
  const alreadyAttached=existing?.projectId===file.projectId && existing.sha256===file.sha256 && existing.bytes===file.bytes && existing.supportPolicy===file.supportPolicy &&
    (!bounds || (item.mesh?.path===path && JSON.stringify(item.mesh.bounds)===JSON.stringify(bounds)));
  if (!alreadyAttached && project.revision!==expectedRevision) throw new Response("Project changed; reread WorkshopAssembly",{status:409});
  const declaration={sha256:file.sha256,size:file.bytes,contentType};
  const head=await storage.head(key);
  if (head?.sha256!==file.sha256 || head.size!==file.bytes || head.contentType!==contentType) {
    const bytes=await storage.takeUpload(key,declaration);
    if (!bytes) return {status:"awaiting_upload",upload:storage.uploadTicket(key,declaration)};
    await storage.put(key.space,key.key,bytes,{contentType});
    await storage.discardUpload(key,declaration);
  }
  let revision=project.revision;
  if (!alreadyAttached) {
    item.files=[...(item.files??[]).filter(f=>f.fileName!==file.fileName),file];
    if (bounds) item.mesh={path,bounds};
    revision=(await patchWorkshopProject(c.db(),c.identity,{id:project.id,revision:expectedRevision},()=>({assembly:project.assembly}))).revision;
  }
  const result = {status:"attached",projectId:project.id,itemId,revision,file:receipt(file)};
  if (!bounds) return result;
  const bytes = await storedPrintBytes(c,key.key,file);
  const preflight = await analyzePrint(c,{name:file.fileName,sha256:file.sha256,bytes},file.supportPolicy,true);
  return {...result,preflight,warnings:printWarnings(preflight)};
}

export async function verifyAssemblyFile(c:WorkshopContext,input:z.infer<typeof verifyInput>) {
  const project=await getWorkshopProject(c.db(),input.projectId);
  const file=project.assembly.items.find(i=>i.id===input.itemId)?.files?.find(f=>f.fileName===input.fileName);
  if (!file) throw new Response("File is not attached to this item",{status:404});
  if(input.expectedSha256 && file.sha256!==input.expectedSha256) throw new Response("Attachment changed; restart the read",{status:409});
  if(input.byteOffset!==undefined && input.byteOffset>=file.bytes) throw new Response("Offset is outside the attachment",{status:400});
  const object=await c.storage().get(target(file));
  if (!object) throw new Response("Attached file is missing or expired",{status:410});
  const bytes=new Uint8Array(await new Response(object.body).arrayBuffer());
  if (object.contentType!==fileType(file.fileName) || bytes.length!==file.bytes || bytesToHex(sha256(bytes))!==file.sha256)
    throw new Response("Stored file differs from its saved receipt",{status:409});
  const result={status:"verified",revision:project.revision,itemId:input.itemId,file:receipt(file)};
  if(input.byteOffset===undefined) {
    if (fileType(file.fileName)!=="model/stl") return result;
    const preflight = await analyzePrint(c,{name:file.fileName,sha256:file.sha256,bytes},file.supportPolicy);
    return {...result,preflight,warnings:printWarnings(preflight)};
  }
  const end=Math.min(bytes.length,input.byteOffset+24*1024);
  const base64=btoa(String.fromCharCode(...bytes.subarray(input.byteOffset,end)));
  return {...result,byteOffset:input.byteOffset,base64,nextByteOffset:end<bytes.length?end:null};
}
