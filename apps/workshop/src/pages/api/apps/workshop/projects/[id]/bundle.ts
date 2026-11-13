import type { APIRoute } from 'astro';
import { respond } from '@ai-outfitter/app-sdk/server';
import { workshopContext } from '../../../../../../server/context';
import { getWorkshopProject } from '../../../../../../server/projects';
import { artifactKey } from '../../../../../../server/workspace';
import { zipSync,strToU8 } from 'fflate';
export const GET:APIRoute=({request,locals,params})=>respond(async()=>{
 const c=workshopContext(request,locals);const p=await getWorkshopProject(c.db(),params.id??'');
 const run=p.workspace?.requests.find(r=>r.id===(new URL(request.url).searchParams.get('build')??p.workspace?.currentBuildId));
 if(!run?.result?.manifest)throw new Response('Build not found',{status:404});
 const files:Record<string,Uint8Array>={'manifest.json':strToU8(JSON.stringify(run.result.manifest,null,2))};
 let total=0;
 for(const a of run.result.manifest.artifacts){total+=a.bytes;if(total>50_000_000)throw new Response('Use individual artifact downloads for bundles over 50 MB',{status:413});const f=await c.storage().get({space:'builds',key:artifactKey(p.id,run.id,a.path)});if(!f)throw new Response('Artifact unavailable',{status:404});files[a.path]=new Uint8Array(await new Response(f.body).arrayBuffer());}
 return new Response(new Uint8Array(zipSync(files)).buffer,{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="workshop-${run.id}.zip"`}});
});
