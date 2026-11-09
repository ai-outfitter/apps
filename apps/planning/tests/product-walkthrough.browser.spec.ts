import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import fixture from "../fixtures/product-evidence.json" with { type: "json" };

const product = "99000000-0000-4000-8000-000000000011";
const revision = "99000000-0000-4000-8000-000000000001";
const bundle = "99000000-0000-4000-8000-000000000005";
const old = "99000000-0000-4000-8000-000000000006";
const origin = "https://planning.example";
const wiki = {installationId: "wiki", hostname: "wiki.example", writable: false};
const owner = {userId:"owner",organizationId:"org",role:"owner"};

for (const mount of ["", "/o/example/planning", "/apps/planning-installation", "/o/products/planning", "/o/projects/planning"])
test(`explore a product revision as a visual walkthrough at ${mount || "root"}`, async ({page}, info) => {
  const app = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "operational"), "planning", {workflowHost: () => ({call: async () => ({ok:false,status:503,message:"No provider calls expected for context"})})});
  const graph = structuredClone(fixture);
  const current = graph.nodes.find(node=>node.title==="Current workspace demonstration");
  const source = graph.nodes.find(node=>node.title==="Source receipt");
  if (!current || !source) throw new Error("Missing synthetic evidence");
  const receipt = JSON.parse(source.body);
  receipt.assets.push({path:"demo/workspace-mobile.svg",route:"/",finalRoute:"/",pageTitle:"Your workspace",viewport:"mobile",state:"sidebar-open"});
  source.body = JSON.stringify(receipt);
  const demonstration = JSON.parse(current.body);
  demonstration.media.splice(1,0,"/demo/workspace-mobile.svg");
  current.body = JSON.stringify(demonstration);
  current.body = current.body.replaceAll('"/demo/', `"${mount}/demo/`);
  const requests: string[] = [], errors: string[] = [];
  let contextReads = 0;
  page.on("request", request=>requests.push(request.url()));
  page.on("pageerror", error=>errors.push(error.message));
  await page.route(`${origin}/**`, async route=>{
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/graphql") {
      const input=request.postDataJSON();const slug=mount.split("/")[2];
      expect(input.operationName).toBe("Products");expect(input.variables.organizations).toEqual([slug]);
      return route.fulfill({json:{data:{viewer:{orgs:[{slug,weeklyProductRoadmap:{name:"Example products",slug,organizationSlug:slug,periodStart:"2026-11-02",periodEnd:"2026-11-09",report:null,markdown:""},products:[{id:product,title:"Example Web App",summary:"",revision:1,revisions:[{id:revision,title:"Example Alpha",revision:1}],projects:[]}]}]}}}});
    }
    if (url.pathname.endsWith("/api/apps/planning/product-report")) return route.fulfill({json:{productReportSchedule:{enabled:false},productReportRuns:[]}});
    if (url.pathname.endsWith("/api/apps/planning/products")) return route.fulfill({json:{wiki,graph}});
    if (url.pathname.endsWith("/api/apps/planning/use-cases/context")) return route.fulfill({json:wiki});
    if (url.pathname.includes("/demo/")) return route.fulfill({contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><rect width="1200" height="760" fill="#f6f6f4"/><rect width="220" height="760" fill="#e9e9e6"/><text x="275" y="100" font-family="sans-serif" font-size="32">Example workspace</text><rect x="275" y="150" width="850" height="450" fill="white" stroke="#ccc"/></svg>'});
    const path = mount && url.pathname.startsWith(`${mount}/`) ? url.pathname.slice(mount.length) : url.pathname;
    return fulfillFrom(route, await app.call(path+url.search,owner));
  });
  await page.route("**/api/platform/threads**", route => route.fulfill({json:{thread:null,entries:[],before:null}}));
  await page.route("**/api/apps/planning/agent/context?*", async route => {
    contextReads++;
    const response = await app.call(`/api/apps/planning/agent/context${new URL(route.request().url()).search}`,owner,{workflowHost:{organizationId:"org",installationId:"planning",userId:"owner",packageHash:"fixture",phase:"interactive",expiresAt:Date.now()+60000}});
    expect(await response.clone().json()).toMatchObject({context:{type:"planning.products"},privateOnly:true,actions:[]});
    return fulfillFrom(route,response);
  });
  await page.route("https://old.example/**", route=>route.fulfill({contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><title>Old synthetic capture</title><rect width="120" height="80" fill="gray"/></svg>'}));
  try {
    await page.setViewportSize({width:1440,height:1100});
    await page.goto(`${origin}${mount}/products`);
    await page.getByRole("link",{name:/Example Alpha/}).click();
    await expect(page).toHaveURL(`${origin}${mount}/products/${product}/revisions/${revision}`);
    await expect(page.getByRole("navigation",{name:"Revision views"}).getByRole("button",{name:"Walkthrough",exact:true})).toHaveAttribute("aria-pressed","true");
    const stage = page.locator(".walkthrough-stage");
    const announcement = await page.locator(".walkthrough-status").elementHandle();
    await expect(stage.getByRole("heading",{name:"Navigate the workspace",exact:true})).toBeVisible();
    await expect(stage.locator("figcaption")).toContainText("Your workspace");
    await expect(stage.locator("figcaption code")).toHaveText("/");
    await expect(stage.locator("img")).toBeVisible();
    expect(await stage.locator("img").evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
    // The route is ready before its cross-fade finishes; capture the settled page.
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    });
    await page.screenshot({path:info.outputPath("experience-walkthrough-desktop.png"),fullPage:true});
    if (mount === "/o/example/planning") {
      expect(contextReads).toBe(0);
      await page.locator("[data-agent-sidebar-toggle]").click();
      const panel = page.locator("#planning-agent");
      await expect(panel.getByRole("textbox")).toBeEnabled();
      await expect.poll(() => contextReads).toBeGreaterThan(0);
      await expect(panel.getByLabel("Share with the organization (cannot be changed later)")).toHaveCount(0);
      await page.locator("[data-agent-sidebar-toggle]").click();
    }
    const pages = page.getByRole("navigation",{name:"Pages in this chapter"});
    await pages.scrollIntoViewIfNeeded();
    const scrollPosition = () => pages.evaluate(element => {
      let parent = element.parentElement;
      while (parent && !/auto|scroll/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
      return parent?.scrollTop ?? window.scrollY;
    });
    const beforeSelection = await scrollPosition();
    expect(beforeSelection).toBeGreaterThan(0);
    const appsPage = pages.getByRole("button",{name:"2. /apps",exact:true});
    await appsPage.focus();
    await page.keyboard.press("Enter");
    await expect(appsPage).toBeFocused();
    await expect(stage.locator("figcaption code")).toHaveText("/apps");
    await expect(stage.locator("img")).toHaveJSProperty("naturalWidth",1200);
    expect(Math.abs(await scrollPosition()-beforeSelection)).toBeLessThanOrEqual(1);
    await expect(page.locator(".walkthrough-status")).toHaveText("Chapter 1 of 2, page 2 of 2");
    expect(await page.locator(".walkthrough-status").evaluate((node, previous)=>node===previous, announcement)).toBe(true);
    const next = page.getByRole("navigation",{name:"Walkthrough navigation"}).getByRole("button",{name:"Next →",exact:true});
    await expect(next).not.toHaveAttribute("aria-pressed");
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button",{name:"← Previous",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(stage.locator("figcaption code")).toHaveText("/apps");
    await page.getByRole("button",{name:"Next →",exact:true}).click();
    await expect(stage).toContainText("This part of the experience has not been captured yet.");
    await page.getByRole("navigation",{name:"Walkthrough navigation"}).getByRole("button",{name:"← Previous",exact:true}).click();
    await expect(stage.locator("figcaption code")).toHaveText("/apps");
    await page.getByRole("navigation",{name:"Walkthrough navigation"}).getByRole("button",{name:"← Previous",exact:true}).click();
    await page.getByRole("group",{name:"Screenshot viewport"}).getByRole("button",{name:"mobile",exact:true}).click();
    await expect(stage.locator("img")).toHaveAttribute("alt",/mobile, sidebar-open/);
    await page.setViewportSize({width:390,height:844});
    const chapterNav = page.getByRole("navigation",{name:"Walkthrough chapters"});
    await chapterNav.getByRole("button",{name:/Generate evidence/}).click();
    expect(await chapterNav.evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);
    const selectedChapter = chapterNav.locator('[aria-current="step"]');
    expect(await selectedChapter.evaluate(element=>{
      const bounds=element.parentElement?.getBoundingClientRect(), current=element.getBoundingClientRect();
      return !!bounds && current.left>=bounds.left-1 && current.right<=bounds.right+1;
    })).toBe(true);
    await chapterNav.getByRole("button",{name:/Navigate the workspace/}).click();
    await page.screenshot({path:info.outputPath("experience-walkthrough-mobile.png"),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.emulateMedia({colorScheme:"dark"});
    await page.screenshot({path:info.outputPath("experience-walkthrough-dark.png"),fullPage:true});
    const reviewTab = page.getByRole("button",{name:"Evidence & review",exact:true});
    await reviewTab.focus();
    await page.keyboard.press("Enter");
    await expect(reviewTab).toBeFocused();
    await expect(page.locator(".product-evidence")).toContainText("blocked");
    await expect(page.locator(".product-evidence")).toContainText("No independent review");
    await expect(page.locator(".product-evidence")).toContainText("a".repeat(40));
    await page.getByLabel("Evidence snapshot").selectOption(old);
    await expect(page).toHaveURL(new RegExp(`bundle=${old}`));
    await expect(page.getByRole("button",{name:"Load screenshots from this location"})).toBeVisible();
    expect(requests.some(url=>url.includes("old.example"))).toBe(false);
    const placeholderHeight = await page.locator(".walkthrough-load").evaluate(element=>element.clientHeight);
    await page.getByRole("button",{name:"Load screenshots from this location"}).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".walkthrough-stage h2")).toBeFocused();
    await expect(page.locator(".walkthrough-capture img")).toHaveJSProperty("naturalWidth",120);
    expect(Math.abs(await page.locator(".walkthrough-image").evaluate(element=>element.clientHeight)-placeholderHeight)).toBeLessThanOrEqual(1);
    await page.goto(`${origin}${mount}/products/${product}/revisions/${revision}?bundle=missing`);
    await expect(page.getByRole("alert")).toContainText("snapshot is unavailable");
    await expect(page.getByLabel("Evidence snapshot")).toHaveValue("");
    await page.getByLabel("Evidence snapshot").selectOption(bundle);
    await expect(page).toHaveURL(new RegExp(`bundle=${bundle}`));
    await expect(page.locator(".walkthrough-capture img")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    // Let in-flight routed requests (prefetches) finish before the Worker goes away.
    await page.unrouteAll({behavior:"wait"});
    await app.dispose();
  }
});

test("demo has a complete synthetic walkthrough with working images", async ({page})=>{
  const app=await appWorker("planning",appArtifact(new URL("..",import.meta.url),"demo"));
  await page.route(`${origin}/**`,async route=>fulfillFrom(route,await app.call(new URL(route.request().url()).pathname)));
  try {
    await page.goto(`${origin}/products/${product}/revisions/${revision}`);
    const image=page.locator(".walkthrough-capture img");
    await expect(image).toBeVisible();
    await expect(image).toHaveJSProperty("naturalWidth",1200);
  } finally {await app.dispose();}
});

test("failed screenshots retain the viewer and show an explanation without throwing", async ({page})=>{
  const app=await appWorker("planning",appArtifact(new URL("..",import.meta.url),"operational"));
  const graph=structuredClone(fixture);
  const demo=graph.nodes.find(node=>node.title==="Current workspace demonstration");
  const source=graph.nodes.find(node=>node.title==="Source receipt");
  if(!demo||!source) throw new Error("Missing synthetic capture");
  demo.body=JSON.stringify({...JSON.parse(demo.body),media:["/demo/missing.svg"]});
  const receipt=JSON.parse(source.body);
  receipt.assets=[{path:"demo/missing.svg",route:"/missing",pageTitle:"Missing capture",viewport:"desktop",state:"page"}];
  source.body=JSON.stringify(receipt);
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.route(`${origin}/**`,async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==="/api/apps/planning/products")return route.fulfill({json:{graph,wiki}});
    if(path==="/api/apps/planning/use-cases/context")return route.fulfill({json:wiki});
    if(path==="/demo/missing.svg")return route.fulfill({status:404,body:""});
    return fulfillFrom(route,await app.call(path,owner));
  });
  try{
    await page.goto(`${origin}/products/${product}/revisions/${revision}`);
    await expect(page.locator(".walkthrough-capture").getByRole("status")).toContainText("Screenshot unavailable");
    await expect(page.locator(".walkthrough-capture figcaption code")).toHaveText("/missing");
    expect(await page.locator(".walkthrough-image").evaluate(element=>element.clientHeight)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  }finally{await app.dispose();}
});
