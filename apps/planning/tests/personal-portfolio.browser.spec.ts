import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
const origin="https://planning.personal.localhost";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
for(const width of [1440,390])test(`personal project and organization drag order persists privately at ${width}px`,async({page})=>{
  const row=(n:number,name:string,organizationSlug:string|null)=>({id:id(n),name,revision:1,organizationSlug,slug:null,githubRepository:null,goals:"",openIssues:0,archived:false,state:"active",useCases:[],customerSegments:[],userStories:[],goalRecords:[],readiness:{stage:"frame",priority:0,missing:[],signals:[]}});
  const rows=[row(1,"First personal",null),row(2,"Second personal",null),row(1,"Alpha project","alpha"),row(3,"Beta project","beta")];
  const app=await appWorker("planning",appArtifact(new URL("..",import.meta.url),"operational"),"personal-planning",{workflowHost:()=>({call:async(operation,input)=>{
    if(operation==="platform.document"){
      const request=input as {document:string;query?:string;scopes?:string[]};
      if(request.document==="Viewer")return {ok:true,value:{viewer:{personal:{accessible:true,appSlugs:["planning"]},organizations:[{slug:"alpha",appSlugs:["planning"]},{slug:"beta",appSlugs:["planning"]}],orgs:[{slug:"alpha",name:"Alpha"},{slug:"beta",name:"Beta"},{slug:"unseen",name:"Unseen organization"}]}}};
      if(request.document==="Projects" || request.document==="PortfolioProjects")return {ok:true,value:{data:{projects:rows.filter(row=>!request.scopes || request.scopes.includes(row.organizationSlug??"personal"))}}};
      if(request.document==="OrganizationGoals")return {ok:true,value:{data:{organizationGoals:[]}}};
    }
    if(operation==="entities.types")return {ok:true,value:[]};
    return {ok:false,status:503,message:"Unavailable fixture source"};
  }})});
  const writes:{kind:string;items:string[];revision:number}[]=[];
  await page.setViewportSize({width,height:1000});
  await page.route(`${origin}/**`,async route=>{
    if(await fulfillPlatformIdentity(route))return;
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path.endsWith("/readiness"))return route.fulfill({json:{projects:[]}});
    if(path.endsWith("/portfolio-order") && request.method()==="POST")writes.push(request.postDataJSON());
    await fulfillFrom(route,await app.dispatch("",new Request(request.url(),{method:request.method(),headers:{...request.headers(),"x-outfitter-user":"alice","x-outfitter-owner":"user:alice","x-outfitter-organization":"","x-outfitter-installation":"personal-planning","x-outfitter-role":"owner"},...(request.postData()?{body:request.postData()}: {})}),{workflowHost:{installationId:"personal-planning",userId:"alice",organizationId:null,packageHash:"fixture",phase:"interactive",expiresAt:Date.now()+60000}}));
  });
  try{
    await page.goto(`${origin}/projects`);
    await expect(page.locator("[data-portfolio-status]")).toHaveText("Your order applies only to you.");
    const first=page.locator(`[data-personal-kind="projects"][data-personal-id="personal:${id(1)}"]`);
    const second=page.locator(`[data-personal-kind="projects"][data-personal-id="personal:${id(2)}"]`);
    await second.dragTo(first);
    await expect(page.locator("[data-portfolio-status]")).toHaveText("Your order is saved.");
    expect(writes[0].kind).toBe("projects");expect(writes[0].items).toHaveLength(4);expect(writes[0].items).toContain(`alpha:${id(1)}`);
    const personal=page.locator('[data-organization-key=""] [data-order-row]');
    await expect(personal.first()).toContainText("Second personal");
    await page.locator('[data-personal-kind="organizations"][data-personal-id="beta"]').dragTo(page.locator('[data-personal-kind="organizations"][data-personal-id="alpha"]'));
    await expect.poll(()=>writes.length).toBe(2);expect(writes[1].items).toEqual(["beta","alpha","unseen"]);
    await page.reload();await expect(page.locator("[data-portfolio-status]")).toHaveText("Your order applies only to you.");
    await expect(personal.first()).toContainText("Second personal");
    await expect(page.locator(".planning-org-card").nth(1)).toHaveAttribute("data-organization-key","beta");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:test.info().outputPath(`personal-portfolio-${width}.png`),fullPage:true});
  }finally{await page.unrouteAll({behavior:"wait"});await app.dispose();}
});
