import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { bomRows } from "../lib/assembly";
import { filePath, fileType } from "../lib/assembly-file";
import type { ResolvedAssembly } from "../lib/assembly-resolution";
import type { ArtifactRecord } from "../lib/artifact";
import type { WorkshopContext } from "./graphql";
import { listPrintPlates } from "./print-plates";

export const preflightProfile = "326a17d070f137bc3d5eb1115d66b4910aa39313f1afb35c839a76be515d2a4c";
const slicerProfileSha256 = "d104b31ec627cddd90419dd8151edb545c5dee3d3c5beaf54f89024308598dd6";
export type SupportPolicy = "support-free" | "supports-required";
type Estimate = { filamentGrams: number; durationSeconds: number; printer: string; material: string; slicer: string };
type Finding = { z_mm: number; unsupported_area_mm2: number };
type Preflight = {
  state: "pending" | "stale" | "completed" | "error";
  profileSha256: string;
  submitted?: boolean;
  result?: { status: "pass" | "warning" | "fail"; findings?: Finding[]; support_heights_mm?: number[]; message?: string; estimate?: Estimate };
};
type Input = { name: string; sha256: string; bytes?: Uint8Array };

export async function analyzePrint(context: WorkshopContext, input: Input, policy?: SupportPolicy, retryFailed = false): Promise<Preflight> {
  const {name, sha256: digest, bytes} = input;
  const id = await sha256Hex(JSON.stringify([preflightProfile, "stl", policy ?? null, [{name, sha256:digest}]]));
  try {
    const host = context.host();
    let job = await host.call("fabrication.preflight", {id});
    if (bytes && (!job || (job.state === "error" && retryFailed))) {
      if (bytesToHex(sha256(bytes)) !== digest) return {state:"error",profileSha256:slicerProfileSha256};
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += 24 * 1024) {
        chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24 * 1024))));
      }
      job = await host.call("fabrication.preflight", {request:{kind:"stl",supportPolicy:policy,files:[{name,sha256:digest,base64:chunks.join("")}]}});
    }
    if (!job) return {state:"pending",profileSha256:slicerProfileSha256};
    if (job.id !== id || job.profile !== preflightProfile) return {state:"stale",profileSha256:slicerProfileSha256};
    const output = job.result as (NonNullable<Preflight["result"]> & {sha256?:string;profile_sha256?:string}) | undefined;
    if (job.state === "completed") {
      if (output?.sha256 !== digest || output.profile_sha256 !== slicerProfileSha256) return {state:"stale",profileSha256:slicerProfileSha256};
      return {state:"completed",profileSha256:slicerProfileSha256,result:output};
    }
    if (job.state === "error") return {state:"error",profileSha256:slicerProfileSha256};
    return {state:"pending",profileSha256:slicerProfileSha256,submitted:true};
  } catch {
    return {state:"error",profileSha256:slicerProfileSha256};
  }
}

export const printWarnings = (report: Preflight) => {
  if (report.state === "pending") return ["Print preflight pending"];
  if (report.state === "stale") return ["Print preflight is stale"];
  if (report.state === "error") return ["Print preflight unavailable"];
  if (report.result?.status !== "pass") {
    const peak = report.result?.findings?.reduce<Finding | undefined>((max, finding) =>
      !max || finding.unsupported_area_mm2 > max.unsupported_area_mm2 ? finding : max, undefined);
    return [peak ? `${report.result?.message ?? "Print preflight flagged an unsupported area"} (${peak.unsupported_area_mm2} mm² at Z ${peak.z_mm} mm)`
      : report.result?.message ?? "Print preflight requires review"];
  }
  return [];
};

export async function storedPrintBytes(context: WorkshopContext, key: string, artifact: Pick<ArtifactRecord, "sha256" | "bytes">) {
  const object = await context.storage().get({space:"builds",key});
  if (!object) return;
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  if (bytes.length === artifact.bytes && bytesToHex(sha256(bytes)) === artifact.sha256) return bytes;
}

export function printableUses(resolved: ResolvedAssembly) {
  const rows = new Map<string,{item:ResolvedAssembly["assembly"]["items"][number];quantity:number;usageIds:string[]}>();
  for (const row of bomRows(resolved.assembly)) {
    if (row.item.kind !== "printed") continue;
    const entry = rows.get(row.item.id) ?? {item:row.item,quantity:0,usageIds:[]};
    entry.quantity += row.quantity;
    entry.usageIds.push(row.path);
    rows.set(row.item.id,entry);
  }
  for (const item of resolved.assembly.items) {
    if (item.kind === "printed" && !rows.has(item.id)) rows.set(item.id,{item,quantity:0,usageIds:[]});
  }
  return [...rows.values()].map(({item,quantity,usageIds}) => {
    const file = item.files?.find(candidate => fileType(candidate.fileName) === "model/stl" && filePath(candidate) === item.mesh?.path);
    const mesh = resolved.meshes[item.id];
    const base = mesh?.base.match(/^\/files\/main\/builds\/([a-zA-Z0-9_-]+)\/[a-zA-Z0-9_-]+\/$/);
    return {itemId:item.id,ownerProjectId:file?.projectId ?? base?.[1] ?? resolved.projectId,name:item.name,quantity,usageIds,
      fileName:file?.fileName ?? mesh?.artifact.path.split("/").at(-1),sha256:file?.sha256 ?? mesh?.artifact.sha256,
      policy:file?.supportPolicy,mesh};
  });
}

export async function readWorkshopPrint(context: WorkshopContext, projectId: string, resolved: ResolvedAssembly) {
  const uses = printableUses(resolved);
  const parts = [];
  for (const {mesh,policy,...part} of uses) {
    let analysis: Preflight = {state:"pending",profileSha256:slicerProfileSha256};
    if (mesh && part.fileName && part.sha256) {
      const input = {name:part.fileName,sha256:part.sha256};
      analysis = await analyzePrint(context,input,policy);
      const key = mesh.base.slice("/files/main/builds/".length) + mesh.artifact.path;
      const head = await context.storage().head({space:"builds",key});
      if (head?.sha256 !== mesh.artifact.sha256 || head.size !== mesh.artifact.bytes) {
        analysis = {state:"stale",profileSha256:slicerProfileSha256};
      } else if (analysis.state === "pending" && !analysis.submitted) {
        const bytes = await storedPrintBytes(context,key,mesh.artifact);
        analysis = bytes ? await analyzePrint(context,{...input,bytes},policy) : {state:"error",profileSha256:slicerProfileSha256};
      }
    }
    const estimate = analysis.result?.estimate;
    const {fileName,sha256,...identity} = part;
    parts.push({...identity,...(fileName && {fileName}),...(sha256 && {sha256}),...analysis,
      ...(estimate && {estimate:{...estimate,profileSha256:analysis.profileSha256}})});
  }
  return {parts,plates:await listPrintPlates(context,projectId,parts)};
}
