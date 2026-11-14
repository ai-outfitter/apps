// Runs in the sealed container (or a Kubernetes workspace with Chromium).
// Reuses current evidence; captures new revisions without changing project state.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureEvidence } from '../../../box/capture-evidence.mjs';

export async function capturePreviews({ origin='http://outfitter.localhost:8787', appPath='/o/box/workshop', output='/out/visual-evidence', cookie, log=console.log }={}) {
  const appPackageHash=createHash('sha256').update(readFileSync(process.env.WORKSHOP_APP_PACKAGE??'/app/src/generated/apps/workshop.operational.json')).digest('hex');
  const {chromium,request}=await import('playwright-core');
  const apiContext=await request.newContext({storageState:cookie?{cookies:cookie.split('; ').map(value=>{const at=value.indexOf('=');return {name:value.slice(0,at),value:value.slice(at+1),domain:new URL(origin).hostname,path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'};}),origins:[]}:undefined});
  let browser,context;
  const openBrowser=async()=>{
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??process.env.CHROME_EXECUTABLE_PATH,args:['--host-resolver-rules=MAP *.localhost 127.0.0.1','--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  context=await browser.newContext({colorScheme:'light',storageState:await apiContext.storageState()});
  };
  try {
    if(!cookie) {
      const auth=await apiContext.post(origin+'/api/auth/sign-in/email',{data:{email:process.env.WORKSHOP_CAPTURE_EMAIL??'local@example.test',password:process.env.WORKSHOP_CAPTURE_PASSWORD??'local-orgs-only'},headers:{Origin:origin}});
      if(!auth.ok()) throw new Error(`Capture sign-in: ${auth.status()}`);
    }
    const api=origin+appPath+'/api/apps/workshop/projects';
    const response=await apiContext.get(api);
    if(!response.ok()) throw new Error(`Project list: ${response.status()}`);
    let captured=0;
    for(const project of await response.json()) {
      let page;
      try {
      const endpoint=`${api}/${project.id}/preview?revision=${project.revision}&evidence=1`;
      const existing=await apiContext.get(endpoint);
      if(existing.ok()&&(await existing.json()).appPackageHash===appPackageHash) continue;
      if(!existing.ok()&&existing.status()!==404) throw new Error(`Preview lookup: ${existing.status()}`);
      if(!context) await openBrowser();
      page=await context.newPage();
        // Slug identity is its UUID suffix; names can change without breaking links.
        const url=`${origin}${appPath}/projects/${project.id.slice(-12)}/assembly`;
        const evidence=await captureEvidence(page,{url,readySelector:'#assembly-viewer[data-ready]',previewSelector:'#assembly-viewer'});
        const directory=join(output,project.id,String(project.revision));mkdirSync(directory,{recursive:true});
        for(const image of evidence.images) writeFileSync(join(directory,image.kind+'.png'),image.bytes);
        const result=await apiContext.put(endpoint,{headers:{Origin:origin},data:{appPackageHash,revision:project.revision,capturedAt:evidence.capturedAt,renderer:evidence.renderer,images:evidence.images.map(({kind,bytes,width,height})=>({kind,base64:bytes.toString('base64'),width,height}))}});
        if(result.status()===409){log(`Project ${project.id} changed during capture; retry next pass`);continue;}
        if(!result.ok()) throw new Error(`Publish evidence: ${result.status()} ${await result.text()}`);
        writeFileSync(join(directory,'evidence.json'),JSON.stringify(await result.json(),null,2));
        captured++;log(`Captured revision ${project.revision} of ${project.name}`);
      }catch(error){log(`Preview ${project.id}: ${error.message}`);}finally{await page?.close();}
    }
    return captured;
  } finally { await browser?.close();await apiContext.dispose(); }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 do {
  try{console.log(`Published ${await capturePreviews({origin:process.env.WORKSHOP_CAPTURE_ORIGIN,output:process.env.WORKSHOP_CAPTURE_OUTPUT})} revision previews`);}catch(error){console.error(error);if(!process.argv.includes('--watch'))process.exitCode=1;}
  if(process.argv.includes('--watch'))await new Promise(resolve=>setTimeout(resolve,30000));
 }while(process.argv.includes('--watch'));
}
