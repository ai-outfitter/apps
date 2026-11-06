import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { requireEditor, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { storage } from "@ai-outfitter/app-sdk/storage";
import type { BatchResult, ChangeReceipt } from "@ai-outfitter/app-sdk/batch-documents";
import { and, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { evidenceActions, evidencePublishInput } from "./evidence";
import type { IntakeContext } from "./intake";
import { releaseEvidenceUploads } from "./schema";

const metadata = evidencePublishInput.omit({base64:true,bundle:true}).extend({
  size:z.number().int().min(1).max(3_000_000),
  visibility:z.enum(["organization","public"]).default("organization"),
});
export const submitReleaseEvidenceInput=z.strictObject({
  bundle:evidencePublishInput.shape.bundle,
  assets:z.array(metadata.extend({key:z.uuid()})).min(1).max(20),
}).refine(value=>new Set(value.assets.map(asset=>asset.key)).size===value.assets.length,"Each asset needs a distinct key")
  .refine(value=>new Set(value.assets.map(asset=>asset.path)).size===value.assets.length,"Each asset needs a distinct path");
const lifetime=10*60*1000;
const conflict=(message:string)=>new Response(message,{status:409});

type Reservation=typeof releaseEvidenceUploads.$inferSelect;
function checkReservation(row:Reservation|undefined,context:IntakeContext,fingerprint?:string):asserts row is Reservation {
  if(!row || row.createdBy!==context.identity.userId || row.installationId!==context.identity.installationId)throw new Response("Upload unavailable",{status:404});
  if(fingerprint && row.fingerprint!==fingerprint)throw conflict("This asset key already identifies different input");
}
const uploadToken=()=>crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-","");

async function issue(context:IntakeContext,bundle:string,asset:z.output<typeof metadata>&{key:string}) {
  requireEditor(context.identity);
  if(!context.storageLocals)throw new Response("Evidence storage unavailable",{status:503});
  const {key,...value}=asset;
  const fingerprint=await sha256Hex(canonicalActionValue({bundle,...value}));
  const find=async()=> (await context.db().select().from(releaseEvidenceUploads).where(eq(releaseEvidenceUploads.key,key)))[0];
  let row=await find();
  if(row)checkReservation(row,context,fingerprint);
  if(!row){
    await context.db().insert(releaseEvidenceUploads).values({key,token:uploadToken(),installationId:context.identity.installationId,createdBy:context.identity.userId,actor:JSON.stringify(context.actor),originActor:JSON.stringify(context.originActor),bundle,path:value.path,metadata:JSON.stringify(value),fingerprint,createdAt:Date.now(),expiresAt:Date.now()+lifetime}).onConflictDoNothing();
    row=await find();
    if(!row)throw conflict("This bundle path is already reserved; use its original asset key or a new bundle");
    checkReservation(row,context,fingerprint);
  }
  const files=storage(context.storageLocals,"main");
  const existing=await files.head({space:"evidence",key:`${bundle}/${value.path}`});
  if(existing){
    if(existing.sha256!==value.sha256 || existing.size!==value.size || existing.contentType!==value.contentType || existing.visibility!==value.visibility)throw conflict("Published evidence differs; use a new bundle");
    return {key,status:"complete" as const,result:{bundle,path:value.path,url:new URL(files.url(existing),context.origin).href,sha256:existing.sha256,size:existing.size}};
  }
  if(row.expiresAt<=Date.now()){
    await context.db().update(releaseEvidenceUploads).set({expiresAt:Date.now()+lifetime,token:uploadToken()}).where(and(eq(releaseEvidenceUploads.key,key),eq(releaseEvidenceUploads.token,row.token),lte(releaseEvidenceUploads.expiresAt,Date.now())));
    row=await find();
    checkReservation(row,context,fingerprint);
  }
  return {key,status:"pending" as const,result:{uploadUrl:new URL(`/api/evidence/uploads/${row.token}`,context.origin).href,method:"PUT",authenticationRequired:true,expiresAt:row.expiresAt,headers:{"Content-Type":value.contentType,"Content-Length":String(value.size)}}};
}

/** This reserves uploads, never submits a recommendation or grants release approval. */
export async function submitReleaseEvidence(context:IntakeContext,input:z.output<typeof submitReleaseEvidenceInput>):Promise<BatchResult>{
  requireEditor(context.identity);
  const items:ChangeReceipt[]=[];
  const instructions:BatchResult["instructions"]=[];
  for(const asset of input.assets){
    try{
      const receipt=await issue(context,input.bundle,asset);items.push(receipt);
      if(receipt.status==="pending")instructions.push({code:"UPLOAD_RELEASE_ASSET",itemKey:asset.key,actor:"caller",required:true,message:"PUT the declared bytes to the upload URL using the same authenticated account, then repeat this document to read the verified receipt.",url:receipt.result.uploadUrl});
    }catch(error){
      if(!(error instanceof Response))throw error;
      items.push({key:asset.key,status:"failed",error:{code:error.status===409?"EVIDENCE_CONFLICT":"UPLOAD_REFUSED",message:await error.text()}});
    }
  }
  return {items,instructions};
}

/** The platform authenticates membership again before this route receives any bytes. */
export async function uploadReleaseEvidence(context:IntakeContext,token:string,request:Request){
  requireEditor(context.identity);
  if(!/^[a-f0-9]{64}$/.test(token))throw new Response("Upload unavailable",{status:404});
  const [row]=await context.db().select().from(releaseEvidenceUploads).where(eq(releaseEvidenceUploads.token,token));
  if(!row || row.createdBy!==context.identity.userId || row.installationId!==context.identity.installationId || row.expiresAt<=Date.now())throw new Response("Upload unavailable or expired",{status:404});
  const asset=metadata.parse(JSON.parse(row.metadata));
  if(request.headers.get("content-type")!==asset.contentType)throw new Response("Content type differs from the upload ticket",{status:422});
  const declared=request.headers.get("content-length");
  if(declared!==null && Number(declared)!==asset.size)throw new Response("Content length differs from the upload ticket",{status:422});
  const bytes=await uploadBytes(request,asset.size);
  if(await sha256Hex(bytes)!==asset.sha256)throw new Response("Upload digest differs from the upload ticket",{status:422});
  const [current]=await context.db().select().from(releaseEvidenceUploads).where(eq(releaseEvidenceUploads.token,token));
  if(!current || current.expiresAt<=Date.now())throw new Response("Upload expired",{status:404});
  const {size:_size,...value}=asset;
  const result=await evidenceActions["evidence.publish"].invoke(context,{...value,bundle:row.bundle,base64:bytes.toString("base64")});
  return {items:[{key:row.key,status:"complete",result}],instructions:[]};
}

async function uploadBytes(request:Request,size:number){
  const reader=request.body?.getReader();
  if(!reader)throw new Response("Missing upload body",{status:400});
  const chunks:Uint8Array[]=[];let length=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>size)throw new Response("Upload exceeds the declared size",{status:413});chunks.push(value);}}
  finally{await reader.cancel();reader.releaseLock();}
  if(length!==size)throw new Response("Upload size differs from the upload ticket",{status:422});
  const bytes=Buffer.concat(chunks);
  return bytes;
}
