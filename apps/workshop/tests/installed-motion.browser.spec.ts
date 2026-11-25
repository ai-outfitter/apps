import {fulfillFrom, fulfillPlatformIdentity} from '@ai-outfitter/app-test/playwright';
import {appArtifact} from '@ai-outfitter/app-test/prepare';
import {appWorker} from '@ai-outfitter/app-test/worker';
import {expect,test} from '@playwright/test';
import {documentText} from '@ai-outfitter/app-sdk/graph-graphql-typed';
import {documents} from '../src/server/documents';
import {projectSlug} from '../src/lib/sections';

// Tier 4: a prototype builder plays the installed drive without a consumer build.
test('play saved arm motion through a chamber and vehicle',async({page})=>{
 test.setTimeout(120000);
 const app=await appWorker('workshop',appArtifact(new URL('..',import.meta.url),'operational'),'motion-browser');
 const member={userId:'builder',organizationId:'motion-browser',role:'member'},origin='https://workshop.outfitter.example';
 const item=(name:string,kind='assembly')=>({id:crypto.randomUUID(),number:name,name,revision:'A',kind});
 const usage=(itemId:string)=>({id:crypto.randomUUID(),itemId,quantity:1});
 async function create(name:string, assembly:unknown){
  const project=await(await app.call('/api/apps/workshop/projects',member,{method:'POST',body:{name,example:'cube'}})).json() as {id:string;revision:number;name:string};
  const graph=async(name:'WorkshopAssembly'|'UpdateWorkshopAssembly',variables:unknown)=>{
   const response=await app.call('/api/internal/actions/v1/call',member,{method:'POST',body:{
    action:name==='WorkshopAssembly'?'graph.graphql':'graph.mutate',input:{query:documentText(documents[name].document),variables}
   }});
   const result=await response.json() as {data?:unknown;errors?:unknown};
   expect(result.errors).toBeUndefined();
   return result.data;
  };
  await graph('UpdateWorkshopAssembly',{projectId:project.id,expectedRevision:project.revision,assembly});
  expect(await graph('WorkshopAssembly',{projectId:project.id})).toMatchObject({workshopAssembly:{assembly}});
  return project;
 }
 try{
  const arm=item('Arm'),shaft=item('Shaft','cots'),moving=usage(shaft.id);
  const root=await create('Source',{rootId:arm.id,items:[{...arm,uses:[{...moving,joint:{kind:'prismatic',axis:[0,0,1]}},usage(shaft.id)],
   operations:[{name:'Sow',durationSeconds:2,tracks:[{path:moving.id+'#0',keys:[{time:0,value:0},{time:2,value:70}]}]}],driveMotion:{version:1,viewRootIds:[arm.id],z:{
   translationUsageIds:[moving.id],levels:[{label:'Low',offset:0},{label:'High',offset:70}],
   rotations:[{usageId:moving.id,axis:[1,0,0],pivot:[0,0,0],radiansPerMillimeter:0.09}],
  }}},{...shaft,geometry:{version:1,units:'mm',features:[{kind:'box',mode:'add',origin:[0,0,0],size:[12,5,3]}]}}]});
  let consumer=root;
  for(const name of ['Chamber','Vehicle']){
   const frame=item(name),mount=item('Mount');
   consumer=await create(name,{rootId:frame.id,items:[{...frame,uses:[usage(mount.id)]},{...mount,reference:{projectId:consumer.id}}]});
  }
  await page.route(origin+'/**',async route=>{
   if(await fulfillPlatformIdentity(route))return;
   const url=new URL(route.request().url());
   await fulfillFrom(route,await app.call(url.pathname+url.search,member));
  });
  const workers:string[]=[];
  page.on('worker',worker=>workers.push(worker.url()));
  await page.goto(origin+'/projects/'+projectSlug(consumer));
  await page.locator('#motion-menu > summary').click();
  const selector=page.getByRole('combobox',{name:'Operation',exact:true});
  await expect(selector.locator('option').first()).toHaveText('Arm · Sow');
  await page.getByRole('button',{name:'Play operation'}).click();
  await expect(page.locator('#operation-clock')).not.toHaveText('0.00 s');
  await page.getByRole('button',{name:'Reset operation'}).click();
  await expect(page.locator('#operation-clock')).toHaveText('0.00 s');
  await page.locator('#operation-time').focus();
  await page.keyboard.press('End');
  await expect(page.locator('#operation-clock')).toHaveText('2.00 s');
  await selector.selectOption({label:'Drive motion'});
  const play=page.getByRole('button',{name:'Play motion',exact:true});
  await expect(play).toBeVisible({timeout:60000});
  for (const [width,height] of [[1440,900],[390,844]]) {
   await page.setViewportSize({width,height});
   await expect(play).toBeInViewport({ratio:1});
   await expect(page.locator('#motion-level')).toBeInViewport({ratio:1});
  }
  await play.click();
  await expect(page.getByRole('button',{name:'Pause motion'})).toBeVisible();
  await page.selectOption('#motion-level','1');
  const canvas=page.locator('#assembly-viewer');
  await expect(canvas).toHaveAttribute('data-motion-offset','70');
  await expect(canvas).toHaveAttribute('data-motion-solids','1');
  await expect(canvas).toHaveAttribute('data-saved-rotors','1');
  expect(workers).toHaveLength(1);
  workers.length=0;
  await page.reload();
  await expect(canvas).toHaveAttribute('data-ready','true',{timeout:60000});
  expect(workers).toEqual([]);
  await expect(page.locator('#assembly-poster')).toBeHidden();

  // Reopen the same authorized snapshot without WebGL. Its last rendered
  // image must remain visible even though the interactive viewer cannot start.
  await page.addInitScript(()=>{
   const getContext=HTMLCanvasElement.prototype.getContext;
   HTMLCanvasElement.prototype.getContext=function(this:HTMLCanvasElement,...args:Parameters<typeof getContext>){
    return args[0].includes('webgl') ? null : getContext.apply(this,args);
   } as typeof getContext;
  });
  await page.reload();
  const poster=page.getByRole('img',{name:'Saved assembly snapshot'});
  await expect(poster).toBeVisible();
  await expect(page.locator('#assembly-status')).toContainText('3D preview unavailable');

  const sourcePath='/api/apps/workshop/projects/'+root.id;
  const source=await (await app.call(sourcePath,member)).json() as import('../src/lib/project').Project;
  source.assembly.items.find(i=>i.id===shaft.id)!.geometry!.features.push({
    kind:'box',mode:'add',origin:[0,0,0],size:[20,10,5],
  });
  const edit=await app.call(sourcePath+'/assembly',member,{method:'PUT',body:{
    assembly:source.assembly,expectedRevision:source.revision,
  }});
  expect(edit.status).toBe(200);
  await page.reload();
  await page.getByRole('tab',{name:'Source & parameters'}).click();
  await expect(page.locator('#inspection-source')).toContainText(String(source.revision+1));
  await expect(page.locator('#assembly-poster')).toBeVisible();
  await expect(poster).toHaveCount(0);
 }finally{await page.unrouteAll({behavior:'ignoreErrors'});await app.dispose();}
});
