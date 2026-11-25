import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type Assembly, bomRows } from "../lib/assembly";
import { filePath, fileType } from "../lib/assembly-file";
import type { ResolvedAssembly } from "../lib/assembly-resolution";
import type { ArtifactRecord } from "../lib/artifact";
import { resolvedProject } from "./assembly-references";
import type { WorkshopContext } from "./graphql";
import { listPrintPlates } from "./print-plates";

const slicerProfileSha256 = "d104b31ec627cddd90419dd8151edb545c5dee3d3c5beaf54f89024308598dd6";
export type SupportPolicy = "support-free" | "supports-required";
type Estimate = { filamentGrams: number; durationSeconds: number; printer: string; material: string; slicer: string };
type Finding = { z_mm: number; unsupported_area_mm2: number };
type Preflight = {
  state: "pending" | "stale" | "completed" | "error";
  profileSha256: string;
  submitted?: boolean;
  needsEditor?: boolean;
  analyzerDigest?: string;
  result?: { status: "pass" | "warning" | "fail"; findings?: Finding[]; support_heights_mm?: number[]; solid_valid?: boolean; message?: string; estimate?: Estimate };
};
type Input = { name: string; sha256: string; bytes?: Uint8Array };

export async function analyzePrint(context: WorkshopContext, input: Input, policy?: SupportPolicy,retryFailed=false): Promise<Preflight> {
  const {name, sha256: digest, bytes} = input;
  const selector = {kind:"stl" as const,supportPolicy:policy,files:[{name,sha256:digest}]};
  let submitting = false;
  try {
    const host = context.host();
    let job = await host.call("fabrication.preflight", {lookup:selector});
    const retry = retryFailed && job?.state==="error";
    if (bytes && (!job || retry)) {
      if (bytesToHex(sha256(bytes)) !== digest) return {state:"error",profileSha256:slicerProfileSha256};
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += 24 * 1024) {
        chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24 * 1024))));
      }
      submitting = true;
      job = await host.call("fabrication.preflight", {
        request:{kind:"stl",supportPolicy:policy,files:[{name,sha256:digest,base64:chunks.join("")}]},
        ...(retry && {retry:true as const}),
      });
    }
    if (!job) return {state:"pending",profileSha256:slicerProfileSha256};
    if (!/^sha256:[a-f0-9]{64}$/.test(job.profile)) return {state:"stale",profileSha256:slicerProfileSha256};
    const analyzerDigest = job.profile;
    const output = job.result as (NonNullable<Preflight["result"]> & {sha256?:string;profile_sha256?:string}) | undefined;
    if (job.state === "completed") {
      if (output?.sha256 !== digest || output.profile_sha256 !== slicerProfileSha256) return {state:"stale",profileSha256:slicerProfileSha256};
      return {state:"completed",profileSha256:slicerProfileSha256,analyzerDigest,result:output};
    }
    if (job.state === "error") return {state:"error",profileSha256:slicerProfileSha256,analyzerDigest};
    return {state:"pending",profileSha256:slicerProfileSha256,analyzerDigest,submitted:true};
  } catch (error) {
    if (submitting && error instanceof Response && error.status===403)
      return {state:"pending",profileSha256:slicerProfileSha256,needsEditor:true};
    if (error instanceof Response && error.status===429) return {state:"pending",profileSha256:slicerProfileSha256};
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

type PrintTarget = { itemId?:string; artifactPath?:string; fileName:string; sha256:string };
export function machinePrintFindings(target:PrintTarget, report:Preflight) {
  const identity = {...target,state:report.state,profileSha256:report.profileSha256,...(report.analyzerDigest && {analyzerDigest:report.analyzerDigest})};
  if (report.state !== "completed") {
    const code = {pending:"check_pending",stale:"check_stale",error:"check_unavailable"}[report.state];
    return [{...identity,code}];
  }
  if (report.result?.status === "pass") return [];
  const status = report.result?.status ?? "warning";
  const findings = report.result?.findings;
  if (findings?.length) return [...findings].sort((a,b)=>b.unsupported_area_mm2-a.unsupported_area_mm2).slice(0,8)
    .map(finding=>({...identity,status,code:"unsupported_area",value:finding.unsupported_area_mm2,
    unit:"mm2",location:{zMm:finding.z_mm}}));
  return [{...identity,status,code:report.result?.solid_valid === false ? "invalid_solid" : "needs_support",
    ...(report.result?.support_heights_mm?.length && {location:{zMm:report.result.support_heights_mm[0]}})}];
}

export async function storedPrintBytes(context: WorkshopContext, key: string, artifact: Pick<ArtifactRecord, "sha256" | "bytes">) {
  const object = await context.storage().get({space:"builds",key});
  if (!object) return;
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  if (bytes.length === artifact.bytes && bytesToHex(sha256(bytes)) === artifact.sha256) return bytes;
}

export function printableUses(resolved: ResolvedAssembly,itemId?:string) {
  const rows = new Map<string,{item:ResolvedAssembly["assembly"]["items"][number];quantity:number;usageIds:string[]}>();
  for (const row of bomRows(itemId ? {...resolved.assembly,rootId:itemId} : resolved.assembly)) {
    if (row.item.kind !== "printed") continue;
    const entry = rows.get(row.item.id) ?? {item:row.item,quantity:0,usageIds:[]};
    entry.quantity += row.quantity;
    entry.usageIds.push(row.path);
    rows.set(row.item.id,entry);
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

/** A transient analysis or source read cannot invalidate an already committed save. */
export async function assemblyPrintFindings(context:WorkshopContext,saved:{id:string;revision:number;assembly:Assembly}) {
  if (!saved.assembly.items.some(item=>item.reference || item.kind==="printed" && item.mesh)) return [];
  let view:ResolvedAssembly;
  try {
    view=await resolvedProject(context.db(),{projectId:saved.id,revision:saved.revision});
  } catch {
    return saved.assembly.items.flatMap(item=>{
      if (item.kind!=="printed") return [];
      const attached=item.files?.find(file=>fileType(file.fileName)==="model/stl" && filePath(file)===item.mesh?.path);
      return attached ? machinePrintFindings({itemId:item.id,fileName:attached.fileName,sha256:attached.sha256},
        {state:"error",profileSha256:slicerProfileSha256}) : [];
    });
  }
  const inputs = printableUses(view).filter(part=>part.fileName && part.sha256);
  const findings = [];
  for (let start=0;start<inputs.length;start+=8) {
    const batch=await Promise.all(inputs.slice(start,start+8).map(async ({itemId,fileName,sha256,policy})=>{
      const target={itemId,fileName:fileName!,sha256:sha256!};
      return machinePrintFindings(target,await analyzePrint(context,{name:target.fileName,sha256:target.sha256},policy));
    }));
    findings.push(...batch.flat());
  }
  return findings;
}

export async function readWorkshopPrint(context: WorkshopContext, projectId: string, resolved: ResolvedAssembly,itemId?:string) {
  const assemblyUses = printableUses(resolved);
  const uses = itemId ? printableUses(resolved,itemId) : assemblyUses;
  let jobsRemaining = 4;
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
      } else if (analysis.state === "pending" && !analysis.submitted && !context.identity.canEdit) {
        analysis = {...analysis,needsEditor:true};
      } else if (analysis.state === "pending" && !analysis.submitted && jobsRemaining>0) {
        jobsRemaining--;
        const bytes = await storedPrintBytes(context,key,mesh.artifact);
        analysis = bytes ? await analyzePrint(context,{...input,bytes},policy) : {state:"error",profileSha256:slicerProfileSha256};
      }
    }
    const estimate = analysis.result?.estimate;
    const {fileName,sha256,...identity} = part;
    parts.push({...identity,...(fileName && {fileName}),...(sha256 && {sha256}),...analysis,
      ...(estimate && {estimate:{...estimate,profileSha256:analysis.profileSha256,analyzerDigest:analysis.analyzerDigest!}})});
  }
  return {parts,plates:await listPrintPlates(context,projectId,assemblyUses)};
}
