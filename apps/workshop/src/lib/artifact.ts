import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
export const ArtifactPathSchema=z.string().max(300).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/).refine(p=>!p.split('/').includes('..'));
export type ArtifactRecord={path:string;sha256:string;bytes:number};
/** Only installation-owned build artifacts may supply mesh bytes. */
export async function verifiedArtifact(base:string,path:string,artifacts:ArtifactRecord[],signal?:AbortSignal,fetcher:typeof fetch=fetch){
 ArtifactPathSchema.parse(path);
 if(!/^\/files\/main\/builds\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/$/.test(base))throw Error('Mesh has no saved build artifact location');
 const artifact=artifacts.find(a=>a.path===path);
 if(!artifact || !path.startsWith(artifact.sha256+'/'))throw Error('Mesh is not registered in this build');
 const response=await fetcher(base+path,{signal});
 if(!response.ok)throw Error('Cannot load saved mesh artifact');
 const bytes=await response.arrayBuffer();
 if(bytes.byteLength!==artifact.bytes||bytesToHex(sha256(new Uint8Array(bytes)))!==artifact.sha256)throw Error('Mesh artifact failed integrity check');
 return bytes;
}
