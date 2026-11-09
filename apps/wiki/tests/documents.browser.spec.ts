import {test,expect} from "@playwright/test";
import {appWorker} from "@ai-outfitter/app-test/worker";
import {fulfillFrom,fulfillPlatformIdentity,isPlatformIdentityRequest} from "@ai-outfitter/app-test/playwright";
import {identityHeaderValues,pageURLHeader} from "@ai-outfitter/app-sdk/server";
import {mkdir} from "node:fs/promises";

for(const mount of ["/apps/wiki-map/","/o/example/wiki-map/"])test(`read, edit and publish a document at ${mount}`,async({page})=>{
 const app=await appWorker("wiki-map",new URL("../.outfitter/packages/operational.json",import.meta.url));
 const owner={userId:"editor",organizationId:"example-org",role:"owner"};
 try{
  await app.call("/api/apps/wiki-map/documents",owner,{method:"POST",body:{operation:"SaveDocument",variables:{input:{title:"Project notebook",body:"Initial notes",slug:"project-notebook"}}}});
  await page.route("https://wiki.example/**",async route=>{
   const request=route.request(),url=new URL(request.url());
   if(isPlatformIdentityRequest(url)){await fulfillPlatformIdentity(route);return;}
   const path=url.pathname.startsWith(mount)?url.pathname.slice(mount.length):url.pathname.slice(1);
   const headers=new Headers(request.headers());for(const [key,value] of Object.entries(identityHeaderValues({...owner,installationId:"wiki-map-installation"})))headers.set(key,value);
   headers.set(pageURLHeader,request.url());
   const response=await app.dispatch("",new Request(`https://wiki.example/${path}${url.search}`,{method:request.method(),headers,body:request.postData(),redirect:"manual"}));
   await fulfillFrom(route,response);
  });
  await page.goto(`https://wiki.example${mount}`);
  await page.getByRole('link',{name:'Project notebook',exact:true}).click();
  await expect(page.getByRole('article')).toContainText('Initial notes');
  await page.getByRole('link',{name:'Edit draft',exact:true}).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.getByRole('heading',{name:'Edit Project notebook',exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Document',exact:true}).fill('Revised notes for the project.');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.getByRole('article')).toContainText('Revised notes');
  await page.getByRole('button',{name:'Publish revision 2'}).click();
  await expect(page.getByText('Revision 2 · Published',{exact:true})).toBeVisible();
  await page.getByText('Revision history',{exact:true}).click();
  await page.getByRole('link',{name:'Revision 1: Project notebook',exact:true}).click();
  await expect(page.getByRole('article')).toContainText('Initial notes');
  await page.evaluate(async()=>{await Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>undefined)));});
  const directory=process.env.WIKI_EVIDENCE_DIR;
  if(directory){await mkdir(directory,{recursive:true});await page.screenshot({path:`${directory}/${mount.includes('/o/')?'organization':'personal'}-desktop.png`,fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${directory}/${mount.includes('/o/')?'organization':'personal'}-mobile.png`,fullPage:true});}
 }finally{await app.dispose();}
});
