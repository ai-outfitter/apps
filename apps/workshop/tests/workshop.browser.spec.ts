import { routeReadOnly } from '@ai-outfitter/app-test/playwright';
import { appArtifact } from '@ai-outfitter/app-test/prepare';
import { appWorker } from '@ai-outfitter/app-test/worker';
import { expect,test } from '@playwright/test';
const origin='https://workshop.outfitter.example';
test("inspect an assembly and open its BOM",async({page})=>{
 test.setTimeout(120000);const app=await appWorker('workshop',appArtifact(new URL('..',import.meta.url),'demo'));
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{await page.setViewportSize({width:390,height:900});await routeReadOnly(page,origin,app,{});await page.goto(origin+'/projects/sensor-mount-study-000000000101/assembly');await expect(page.locator('#assembly-viewer')).toHaveAttribute('data-ready','true',{timeout:60000});
 const canvas=page.locator('#assembly-viewer');const before=await canvas.screenshot();const box=(await canvas.boundingBox())!;await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.75,box.y+box.height*.65,{steps:12});await page.mouse.up();await page.waitForTimeout(300);expect(Buffer.compare(before,await canvas.screenshot())).not.toBe(0);
 if(await page.getByRole('button',{name:'Open navigation',exact:true}).isVisible())await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await page.locator('#sidebar').getByRole('link',{name:'BOM',exact:true}).click();await expect(page.locator('.bom-row')).toHaveCount(2);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 }finally{await page.unrouteAll({behavior:'ignoreErrors'});await app.dispose();}
});
