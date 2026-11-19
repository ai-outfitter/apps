import {fulfillFrom, fulfillPlatformIdentity} from '@ai-outfitter/app-test/playwright';
import {appArtifact} from '@ai-outfitter/app-test/prepare';
import {appWorker} from '@ai-outfitter/app-test/worker';
import {expect,test} from '@playwright/test';
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
  const saved=await app.call('/api/apps/workshop/projects/'+project.id+'/assembly',member,{method:'PUT',body:{expectedRevision:project.revision,assembly}});
  expect(saved.status).toBe(200);
  return project;
 }
 try{
  const arm=item('Arm'),shaft=item('Shaft','cots'),moving=usage(shaft.id);
  const root=await create('Source',{rootId:arm.id,items:[{...arm,uses:[moving,usage(shaft.id)],driveMotion:{version:1,viewRootIds:[arm.id],z:{
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
  await page.goto(origin+'/projects/'+projectSlug(consumer)+'/assembly');
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
 }finally{await page.unrouteAll({behavior:'ignoreErrors'});await app.dispose();}
});
