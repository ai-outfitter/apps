import { randomUUID } from "node:crypto";
import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import { projectSlug } from "../src/lib/sections";

// Tier 2: a field researcher inspects the second of two sensor cartridges.
test("keyboard inspection bookmarks one occurrence and restores its parent", async ({ page }) => {
  test.setTimeout(120000);
  const app = await appWorker("workshop",appArtifact(new URL("..",import.meta.url),"operational"),"field");
  const member = {userId:"researcher",organizationId:"field",role:"member"};
  const origin = "https://workshop.outfitter.example";
  try {
    const project = await (await app.call("/api/apps/workshop/projects",member,{
      method:"POST",body:{name:"Field sensor",example:"cube"}
    })).json() as {id:string;revision:number;name:string;cadPlan:unknown};
    const [root,unit,sensor,left,right,leaf] = Array.from({length:6},()=>randomUUID());
    const item = (id:string,name:string) => ({id,name,number:name,revision:"A",kind:"assembly"});
    const use = (id:string,itemId:string) => ({id,itemId,quantity:1});
    const assembly = {rootId:root,items:[
      {...item(root,"Field rig"),uses:[{...use(left,unit),position:[-40,0,0]}, {...use(right,unit),position:[40,0,0],rotation:90}]},
      {...item(unit,"Cartridge"),uses:[use(leaf,sensor)]},
      {...item(sensor,"Sensor"),kind:"cots",geometry:project.cadPlan}
    ]};
    const saved = await app.call("/api/apps/workshop/projects/"+project.id+"/assembly",member,{method:"PUT",body:{expectedRevision:project.revision,assembly}});
    expect(saved.status).toBe(200);
    const writes:string[] = [];
    await page.route(origin+"/**",async route=>{
      if (await fulfillPlatformIdentity(route)) return;
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== "GET") writes.push(request.method()+" "+url.pathname);
      await fulfillFrom(route,await app.call(url.pathname+url.search,member));
    });
    await page.setViewportSize({width:375,height:667});
    await page.goto(origin+"/projects/"+projectSlug(project));
    await expect(page.locator("#assembly-viewer")).toHaveAttribute("data-ready","true",{timeout:60000});
    await page.getByRole("button",{name:"Explode 0%"}).click();
    const range=page.getByRole("slider",{name:"Explode amount"});
    await range.focus(); await range.press("End");
    await expect(range).toHaveAttribute("aria-valuetext","100 percent exploded");
    await page.getByText("Components in this level",{exact:true}).click();
    const second=page.getByRole("button",{name:"Cartridge · instance 2",exact:true});
    await second.focus(); await second.press("Enter");
    await expect(second).toHaveAttribute("aria-pressed","true");
    await page.locator("#selected-body").getByRole("button",{name:"Inspect Cartridge · instance 2"}).click();
    await expect(page.locator("#occurrence-heading")).toBeFocused();
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(right+"#0")));
    await expect(range).toHaveValue("0");
    await range.focus(); await range.press("PageUp");
    await page.getByRole("button",{name:"Back",exact:true}).click();
    await expect(second).toBeFocused();
    await expect(range).toHaveValue("100");
    await page.getByRole("button",{name:"Set to assembled"}).click();
    await expect(page.getByRole("button",{name:"Explode 0%"})).toBeFocused();
    expect(new URL(page.url()).searchParams.has("explode")).toBe(false);
    expect(writes).toEqual([]);
  } finally {
    await page.unrouteAll({behavior:"ignoreErrors"});
    await app.dispose();
  }
});
