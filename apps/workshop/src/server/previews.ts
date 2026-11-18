import { z } from "zod";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { artifactRef } from "@ai-outfitter/app-sdk/evidence";
import type { WorkshopContext } from "./graphql";
import { getWorkshopProject } from "./projects";

export const previewVersion = "v1";
export const previewKey = (id: string, revision: number) => `${id}/previews/${previewVersion}-${revision}/evidence.json`;
const image = z.object({ kind: z.enum(["preview", "desktop", "mobile"]), base64: z.string().max(4_000_000), width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }).strict();
export const previewInput = z.object({ revision: z.number().int().nonnegative(), capturedAt: z.iso.datetime(), appPackageHash: z.string().regex(/^[a-f0-9]{64}$/), renderer: z.string().min(1).max(200), images: z.array(image).length(3) }).strict();

/** Evidence is separate from the editable project: attaching it cannot create another revision. */
export async function savePreview(c: WorkshopContext, id: string, input: z.infer<typeof previewInput>) {
  const project = await getWorkshopProject(c.db(), id);
  if (project.revision !== input.revision) throw new Response("Project changed during capture", { status: 409 });
  if (new Set(input.images.map(i => i.kind)).size !== 3) throw new Response("Preview, desktop and mobile captures are required", { status: 400 });
  const key = previewKey(id, input.revision);
  const existing = await c.storage().get({ space: "builds", key });
  if (existing) {
    const saved=await new Response(existing.body).json() as {appPackageHash?:string};
    if(saved.appPackageHash===input.appPackageHash)return saved;
  }
  // Validate every image before writing any evidence.
  const images = await Promise.all(input.images.map(async i => {
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(i.base64), char => char.charCodeAt(0)); } catch { throw new Response("Invalid image encoding", { status: 400 }); }
    const signature = [137,80,78,71,13,10,26,10];
    if (bytes.length < 33 || signature.some((value,index) => bytes[index] !== value) || new TextDecoder().decode(bytes.slice(12,16)) !== "IHDR") throw new Response("PNG capture required", { status: 400 });
    const view = new DataView(bytes.buffer);
    if (view.getUint32(16) !== i.width || view.getUint32(20) !== i.height) throw new Response("Image dimensions do not match", { status: 400 });
    return { ...i, bytes, hash: await sha256Hex(new Uint8Array(bytes).buffer) };
  }));
  const artifacts = [];
  for (const image of images) {
    const imageKey = `${id}/previews/${previewVersion}-${input.revision}/${image.hash}.png`;
    await c.storage().put("builds", imageKey, image.bytes, { contentType: "image/png" });
    artifacts.push({ kind: image.kind, width: image.width, height: image.height, bytes: image.bytes.length, key: imageKey,
      ...artifactRef.parse({provider:"workshop", recordId:imageKey, version:previewVersion, contentHash:image.hash}) });
  }
  // If an edit raced capture, the immutable images remain historical, never the new preview.
  if ((await getWorkshopProject(c.db(), id)).revision !== input.revision) throw new Response("Project changed during capture", { status: 409 });
  const build = project.workspace?.requests.find(run => run.id === project.workspace?.currentBuildId);
  const evidence = { version: 1, projectId:id, revision:input.revision, capturedAt:input.capturedAt, uploadedAt:new Date().toISOString(), renderer:input.renderer, appPackageHash:input.appPackageHash,
    buildId:build?.id ?? null, sourceCommit:build?.result?.manifest?.sourceCommit ?? null, artifacts,
    limitations:"Rendered appearance only. These captures do not verify physical fit, strength or manufacturing readiness." };
  await c.storage().put("builds", `${id}/previews/${previewVersion}-${input.revision}/${input.appPackageHash}/evidence.json`, new TextEncoder().encode(JSON.stringify(evidence)), {contentType:"application/json"});
  await c.storage().put("builds", key, new TextEncoder().encode(JSON.stringify(evidence)), {contentType:"application/json"});
  return evidence;
}
