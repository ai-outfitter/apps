import { routeReadOnly } from '@ai-outfitter/app-test/playwright';
import { appArtifact } from '@ai-outfitter/app-test/prepare';
import { appWorker } from '@ai-outfitter/app-test/worker';
import { expect,test } from '@playwright/test';
const origin='https://workshop.outfitter.example';
test("inspect an assembly and open its BOM",async({page})=>{
 test.setTimeout(120000);const app=await appWorker('workshop',appArtifact(new URL('..',import.meta.url),'demo'));
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{await page.setViewportSize({width:390,height:900});await routeReadOnly(page,origin,app,{});await page.goto(origin+'/');
 const row=page.locator('.project-row').filter({hasText:'Sensor mount study'});
 await expect(row).toContainText('Hold a small sensor');
 await expect(row.locator('svg.thumb polygon').first()).toBeVisible();
 await row.getByRole('link').click();await expect(page.locator('#assembly-viewer')).toHaveAttribute('data-ready','true',{timeout:60000});
 const canvas=page.locator('#assembly-viewer');const before=await canvas.screenshot();const box=(await canvas.boundingBox())!;await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.75,box.y+box.height*.65,{steps:12});await page.mouse.up();await page.waitForTimeout(300);expect(Buffer.compare(before,await canvas.screenshot())).not.toBe(0);
 const model = await canvas.elementHandle();
 const frame = await canvas.boundingBox();
 await expect(page.getByRole('tab',{name:'Power'})).toHaveCount(0);
 await expect(page.getByRole('tab',{name:'Description'})).toHaveAttribute('aria-selected','true');
 await expect(page.locator('#project-brief')).toBeVisible();
 await page.getByRole('tab',{name:'BOM'}).click();
 expect(await model!.evaluate(el => el === document.querySelector("#assembly-viewer"))).toBe(true);
 expect(await canvas.boundingBox()).toEqual(frame);
 await expect(page.locator('.bom-row')).toContainText('M3 mounting screws');
 await expect(page.locator('#bom-price')).toBeHidden();
 await page.getByText('Pricing',{exact:true}).click();
 await expect(page.locator('#bom-price')).toHaveText('One-build price $1.40');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 }finally{await page.unrouteAll({behavior:'ignoreErrors'});await app.dispose();}
});

test("seeded BOM keeps supplier links and scopes prices and power to the selected assembly", async ({page}) => {
 const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "demo"));
 try {
  await routeReadOnly(page, origin, app, {});
  await page.goto(origin + "/projects/node-000000000106/parts");
  const rows = page.locator("#bom-rows");
  await expect(rows.getByRole("link", {name: "Open part source at adafruit.com"}))
   .toHaveAttribute("href", "https://www.adafruit.com/product/3809");
  await rows.getByRole("link", {name: "Electronics sub-assembly"}).click();
  await page.locator("#project-bom").click();
  await page.waitForURL(url => url.pathname.endsWith("/parts") && url.searchParams.has("item"));
  await page.reload();
  await expect(page.getByRole("heading", {name: "Bill of materials · Electronics sub-assembly"})).toBeVisible();
  await page.locator("#pricing summary").click();
  await expect(page.locator("#bom-price")).toContainText("$44.49 estimated");
  await page.locator("#project-power").click();
  await expect(page.getByRole("heading", {name: "Power · Electronics sub-assembly"})).toBeVisible();
 } finally {
  await page.unrouteAll({behavior: "ignoreErrors"});
  await app.dispose();
 }
});

test("project tabs keep a selected subassembly in view", async ({page}) => {
 const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "demo"));
 try {
  await routeReadOnly(page, origin, app, {});
  await page.goto(origin + "/projects/node-000000000106");
  await page.getByRole("tab", {name:"Components"}).click();
  await page.getByRole("button", {name:"Electronics sub-assembly", exact:true}).click();
  await expect(page.getByRole("tab", {name:"Selected"})).toHaveAttribute("aria-selected","true");
  await page.getByRole("tab", {name:"BOM"}).click();
  await page.locator("#pricing summary").click();
  await expect(page.locator("#bom-price")).toContainText("$44.49 estimated");
  await page.getByRole("tab", {name:"Power"}).click();
  await expect(page.locator("#power-panel h2")).toContainText("Electronics sub-assembly");
  await page.setViewportSize({width:320,height:844});
  const budgets = page.locator("#power-panel .power-scroll");
  await expect(budgets).toHaveCount(2);
  for (const budget of await budgets.all()) {
   await expect(budget.locator(".power-field-label").first()).toBeVisible();
   expect(await budget.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.getByRole("tab", {name:"Selected"}).click();
  await expect(page.locator("#item-details h3")).toHaveText("Electronics sub-assembly");
  await page.getByRole("tab",{name:"Components"}).click();
  await expect(page.getByRole("tab",{name:"Components"})).toBeFocused();
  await page.getByRole("tab", {name:"Selected"}).click();
  await page.locator("#item-details").getByRole("button", {name:/ESP32/}).click();
  await expect(page.getByRole("tab", {name:"BOM"})).toHaveCount(0);
  await page.getByRole("tab", {name:"Power"}).click();
  await expect(page.locator("#power-panel h2")).toContainText("ESP32");
  await page.getByRole("button", {name:"Clear selection",exact:true}).click();
  await expect(page.getByRole("tab", {name:"Selected"})).toHaveCount(0);
  await page.getByRole("tab", {name:"BOM"}).click();
  await expect(page.locator("#bom-price")).toContainText("$70.85 estimated");
  const canvas = await page.locator("#assembly-viewer").elementHandle();
  await page.locator("#bom-rows").getByRole("link", {name:"Electronics sub-assembly"}).click();
  await expect(page.getByRole("tab", {name:"Selected"})).toHaveAttribute("aria-selected","true");
  expect(await canvas!.evaluate(el => document.querySelector("#assembly-viewer") === el)).toBe(true);
  await page.setViewportSize({width:1440,height:900});
  await page.goto(origin + "/projects/node-000000000106/power");
  await expect(page.locator(".power-table th").first()).toBeVisible();
  await expect(page.locator(".power-field-label").first()).toBeHidden();
 } finally {
  await page.unrouteAll({behavior:"ignoreErrors"});
  await app.dispose();
 }
});
