import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { zipSync, strToU8 } from "fflate";
import { BuildManifestSchema } from "../lib/workspace";
import { ProjectSchema } from "../lib/project";
import { parsePcbReview, pcbReviewArtifact } from "../lib/pcb-review";
import type { WorkshopContext } from "./graphql";
import { getWorkshopProject, updateWorkshopProject } from "./projects";

const path = z.string().max(300).regex(/^[a-f0-9]{64}\/[a-zA-Z0-9_.-]+$/);
export const PcbFileInput = z.object({
  snapshotId: z.uuid(), path, base64: z.string().max(28_000_000),
  contentType: z.enum(["model/gltf-binary", "application/json", "application/zip", "application/x-tar", "application/pdf", "text/csv", "text/plain", "image/png"]),
}).strict();
export const PcbImportInput = z.object({
  snapshotId: z.uuid(), revision: z.number().int().nonnegative(),
  reviewPath: path, manifest: BuildManifestSchema.refine(m => m.artifacts.length <= 50 && m.assembly.items.length === 0, "PCB imports allow at most 50 files and no assembly geometry"),
}).strict();
export const pcbArtifactKey = (projectId: string, snapshotId: string, file: string) => `${projectId}/pcb/${snapshotId}/${file}`;
const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

export async function uploadPcbFile(c: WorkshopContext, projectId: string, input: z.infer<typeof PcbFileInput>) {
  const project = await getWorkshopProject(c.db(), projectId);
  if (project.pcbSnapshots?.some(s => s.id === input.snapshotId)) throw new Response("Snapshot is immutable", {status:409});
  if ((project.pcbSnapshots?.length ?? 0) >= 30) throw new Response("Snapshot limit reached", {status:409});
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(input.base64), c => c.charCodeAt(0)); }
  catch { throw new Response("Invalid base64 artifact", {status:400}); }
  const key = pcbArtifactKey(projectId,input.snapshotId,input.path);
  // Include abandoned uploads in the project quota; storage expires after one year.
  const uploaded = await c.storage().list("builds", {prefix:projectId+"/pcb/",limit:1000});
  const other = uploaded.filter(file => file.key !== key);
  const sameSnapshot = other.filter(file => file.key.startsWith(projectId+"/pcb/"+input.snapshotId+"/"));
  if (other.length >= 999 || other.reduce((sum,file)=>sum+file.size,0)+bytes.length > 500_000_000 ||
      sameSnapshot.length >= 50 || sameSnapshot.reduce((sum,file)=>sum+file.size,0)+bytes.length > 30_000_000)
    throw new Response("PCB upload storage limit reached", {status:413});
  if (input.path.split("/")[0] !== digest(bytes)) throw new Response("Artifact hash mismatch", {status:400});
  return c.storage().put("builds", pcbArtifactKey(projectId,input.snapshotId,input.path), bytes, {contentType:input.contentType});
}

export async function importPcbSnapshot(c: WorkshopContext, projectId: string, input: z.infer<typeof PcbImportInput>) {
  const project = await getWorkshopProject(c.db(),projectId);
  if (project.revision !== input.revision) throw new Response("Project changed; reload before importing", {status:409});
  if (project.pcbSnapshots?.some(s => s.id === input.snapshotId)) throw new Response("Snapshot already imported", {status:409});
  if ((project.pcbSnapshots?.length ?? 0) >= 30) throw new Response("Snapshot limit reached", {status:409});
  if(pcbReviewArtifact(input.manifest.artifacts)?.path !== input.reviewPath) throw new Response("Package must contain exactly one matching pcb-review.json",{status:400});
  let total=0, reviewBytes: Uint8Array|undefined;
  for (const artifact of input.manifest.artifacts) {
    total+=artifact.bytes;
    if (total>30_000_000) throw new Response("PCB package exceeds 30 MB", {status:413});
    if (artifact.path.split("/")[0] !== artifact.sha256) throw new Response("Artifact path/hash mismatch", {status:400});
    const stored=await c.storage().get({space:"builds",key:pcbArtifactKey(projectId,input.snapshotId,artifact.path)});
    if (!stored) throw new Response(`Missing artifact: ${artifact.path}`, {status:400});
    if(stored.contentType!==artifact.contentType) throw new Response("Artifact content type mismatch",{status:400});
    const bytes=new Uint8Array(await new Response(stored.body).arrayBuffer());
    if(bytes.length!==artifact.bytes || digest(bytes)!==artifact.sha256) throw new Response("Artifact bytes do not match manifest", {status:400});
    if(artifact.path===input.reviewPath) {
      if(artifact.contentType!=="application/json" || bytes.length>2_000_000) throw new Response("Invalid PCB review document",{status:400});
      reviewBytes=bytes;
    }
  }
  if(!reviewBytes) throw new Response("PCB review document missing",{status:400});
  let review: ReturnType<typeof parsePcbReview>;
  try { review=parsePcbReview(JSON.parse(new TextDecoder().decode(reviewBytes)),input.manifest.artifacts); }
  catch { throw new Response("Invalid PCB review document",{status:400}); }
  if(!input.manifest.artifacts.some(a=>a.path.endsWith(".kicad_pcb") && a.sha256===review.boardSha256)) throw new Response("Native PCB source hash is not registered",{status:400});
  const snapshot={id:input.snapshotId,origin:"imported" as const,importedAt:new Date().toISOString(),importedBy:c.identity.userId,reviewPath:input.reviewPath,manifest:input.manifest,artifactBase:`/files/main/builds/${projectId}/pcb/${input.snapshotId}/`};
  // Only append evidence. Geometry, power model and validated workflow history stay unchanged.
  const updated={...project,pcbSnapshots:[...(project.pcbSnapshots??[]),snapshot]};
  if(!ProjectSchema.safeParse(updated).success) throw new Response("PCB snapshot exceeds project storage limit; use a separate project",{status:413});
  return updateWorkshopProject(c.db(),c.identity,updated,projectId,true);
}

export async function pcbSnapshotBundle(c: WorkshopContext, projectId: string, snapshotId: string) {
  const project=await getWorkshopProject(c.db(),projectId);
  const snapshot=project.pcbSnapshots?.find(s=>s.id===snapshotId);
  if(!snapshot) throw new Response("Snapshot not found",{status:404});
  const files: Record<string,Uint8Array>={"snapshot.json":strToU8(JSON.stringify(snapshot,null,2))};let total=0;
  for(const artifact of snapshot.manifest.artifacts){
    total+=artifact.bytes;if(total>30_000_000)throw new Response("Package exceeds download limit",{status:413});
    const stored=await c.storage().get({space:"builds",key:pcbArtifactKey(projectId,snapshotId,artifact.path)});
    if(!stored)throw new Response("Snapshot artifact unavailable or expired",{status:410});
    const bytes=new Uint8Array(await new Response(stored.body).arrayBuffer());
    if(bytes.length!==artifact.bytes || digest(bytes)!==artifact.sha256)throw new Response("Snapshot artifact integrity failure",{status:409});
    files[artifact.path]=bytes;
  }
  return new Response(new Uint8Array(zipSync(files)).buffer,{headers:{"Content-Type":"application/zip","Content-Disposition":`attachment; filename="pcb-${snapshotId}.zip"`}});
}
