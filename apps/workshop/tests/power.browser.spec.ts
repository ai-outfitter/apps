import {fulfillFrom,fulfillPlatformIdentity} from '@ai-outfitter/app-test/playwright';
import {appArtifact} from '@ai-outfitter/app-test/prepare';
import {appWorker} from '@ai-outfitter/app-test/worker';
import {expect,test} from '@playwright/test';
import {projectSlug} from '../src/lib/sections';

// Tier 4: prototype builder edits a nested device's scenario and inspects an unbuilt revision.
test('power scenario stays selected after save; empty historical builds never show current power',async({page})=>{
 test.setTimeout(120000);
 const app=await appWorker('workshop',appArtifact(new URL('..',import.meta.url),'operational'),'power-browser');
 const member={userId:'builder',organizationId:'power-browser',role:'member'},origin='https://workshop.outfitter.example';
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  let p=await(await app.call('/api/apps/workshop/projects',member,{method:'POST',body:{example:'cube'}})).json() as any;
  const id='10000000-0000-4000-8000-000000000001';
  const assembly={rootId:id,power:{version:1,notes:'Fixture',scenarios:[{id:'low',name:'Low',notes:''},{id:'high',name:'High',notes:''}],rails:[{id:'dc',name:'Input',voltage:24,kind:'dc',efficiency:1,notes:''}]},items:[{id,number:'CTRL',revision:'A',kind:'assembly',name:'Controls',power:{loads:[{id:'input',name:'Input',rail:'dc',evidence:'assumed',source:'Fixture',notes:'',scenarios:{low:{averageW:1,operatingW:2,peakW:3},high:{averageW:3,operatingW:4,peakW:6}}}]}}]};
  const path=`/api/apps/workshop/projects/${p.id}`;
  p=await(await app.call(path,member,{method:'PUT',body:{...p,assembly}})).json();
  // A legitimately queued request has no saved assembly yet.
  p=await(await app.call(path+'/builds',member,{method:'POST',body:{id:p.id,revision:p.revision,repository:'example/fixture',sourceCommit:'a'.repeat(40),instructions:'Fixture build',parameters:{},runner:'container:test'}})).json();
  await page.route(origin+'/**',async route=>{
   if(await fulfillPlatformIdentity(route))return;
   const req=route.request(),url=new URL(req.url());
   await fulfillFrom(route,await app.call(url.pathname+url.search,member,{method:req.method(),...(req.postData()?{body:req.postDataJSON()}:{})}));
  });
  await page.goto(origin+`/projects/${projectSlug(p)}/assembly`);
  await page.selectOption('#power-scenario','high');
  await page.getByRole('spinbutton',{name:'CTRL Input peakW',exact:true}).fill('7');
  await page.getByRole('button',{name:'Save power values'}).click();
  await expect(page.locator('#workspace-notice')).toContainText('Power values saved');
  await expect(page.locator('#power-scenario')).toHaveValue('high');
  await expect(page.locator('#power-summary')).toContainText('7 W simultaneous');
  await page.reload();await page.selectOption('#power-scenario','high');
  await expect(page.getByRole('spinbutton',{name:'CTRL Input peakW',exact:true})).toHaveValue('7');
  await page.goto(origin+`/projects/${projectSlug(p)}/assembly?build=${p.workspace.requests[0].id}`);
  await expect(page.locator('#workspace-notice')).toContainText('no saved assembly');
  await expect(page.locator('#power-panel')).toContainText('No power budget');
  await expect(page.locator('#component-tree .component-row')).toHaveCount(0);
  expect(errors).toEqual([]);
 }finally{await page.unrouteAll({behavior:'ignoreErrors'});await app.dispose();}
});
