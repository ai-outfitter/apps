import { fulfillFrom, routeReadOnly } from '@ai-outfitter/app-test/playwright';
import { appArtifact } from '@ai-outfitter/app-test/prepare';
import { appWorker } from '@ai-outfitter/app-test/worker';
import { expect, test } from '@playwright/test';

// Tier 2/4 browsing: a researcher inspects COTS parts inside a larger instrument.
test('models catalog opens a part, an unmodeled item and the full assembly', async ({page}) => {
 test.setTimeout(120000);
 const app=await appWorker('workshop',appArtifact(new URL('..',import.meta.url),'demo'));
 const origin='https://workshop.outfitter.example';
 try {
  await routeReadOnly(page,origin,app,{});
  for (const path of ['assembly','assembly/','overview']) {
   const response = await app.fetch(origin+'/projects/node-000000000106/'+path);
   expect(response.status).toBe(404);
  }
  await page.route(origin+'/apps/workshop/**', async route => {
   const request = route.request(), url = new URL(request.url());
   expect(request.method()).toBe('GET');
   await fulfillFrom(route, await app.fetch(origin+url.pathname.slice('/apps/workshop'.length)+url.search));
  });
  await page.goto(origin+'/projects/node-000000000106/models');
  await expect(page.locator('.model-card')).toHaveCount(13);
  await page.getByLabel('Search models').fill('ESP32');
  await expect(page.locator('.model-card')).toHaveCount(1);
  await page.locator('.model-card').getByRole('link',{name:'View model',exact:true}).click();
  await expect(page).toHaveURL(/\/projects\/node-000000000106\?item=/);
  await expect(page.getByRole('tab',{name:'Overview'})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#project-name')).toContainText('ESP32');
  await expect(page.locator('#assembly-viewer')).toHaveAttribute('data-ready','true',{timeout:60000});
  await expect(page.locator('#assembly-status')).toContainText('1 solids from 1 items');
  const perspective = await page.locator('#assembly-viewer').screenshot();
  await page.getByRole('button',{name:'Top view',exact:true}).click();
  expect(await page.locator('#assembly-viewer').screenshot()).not.toEqual(perspective);
  await expect(page.locator('#selected-name')).toContainText('ESP32');
  await expect(page.locator('#detail-scope')).toHaveText('Open level');
  await page.locator('#browse-models').click();
  await page.getByLabel('Search models').fill('SNY-C008');
  await expect(page.locator('.model-card')).toContainText('Qty 4');
  await page.locator('.model-card a').click();
  await expect(page.locator('#assembly-status')).toContainText('No geometry');
  await expect(page.locator('#selected-meta')).toContainText('SNY-C008');
  await page.locator('#product-home').click();
  await expect(page.locator('#assembly-viewer')).toHaveAttribute('data-ready','true',{timeout:60000});
  await expect(page.locator('#project-name')).toHaveText('SNY-1 soil sensor node');
  const components = page.locator('#occurrence-list [role=listitem]');
  await expect(components).toHaveCount(10);
  const inspect = page.getByRole('link',{name:'Inspect Electronics sub-assembly',exact:true});
  const path = '/projects/node-000000000106/assembly/00000000-0000-4000-8000-000000002003~0';
  await expect(inspect).toHaveAttribute('href',origin+path);
  expect((await app.fetch(origin+path)).status).toBe(200);
  await inspect.click();
  await expect(page.locator('#project-name')).toHaveText('Electronics sub-assembly');
  await expect(components).toHaveCount(5);
  const controller = page.getByRole('link',{name:'ESP32-S3-DevKitC-1-N8R8 · U1',exact:true});
  const controllerHref = await controller.getAttribute('href');
  await page.reload();
  await expect(controller).toHaveAttribute('href',controllerHref!);
  await page.goto(controllerHref!);
  await expect(page.locator('#selected-name')).toHaveText('ESP32-S3-DevKitC-1-N8R8 · U1');
  await page.getByRole('navigation',{name:'Assembly hierarchy'}).getByRole('link',{name:'SNY-1 soil sensor node'}).click();
  await expect(components).toHaveCount(10);
  await page.goto(origin+'/apps/workshop'+path);
  await expect(page.locator('#project-name')).toHaveText('Electronics sub-assembly');
  await expect(page.getByRole('navigation',{name:'Assembly hierarchy'}).getByRole('link',{name:'SNY-1 soil sensor node'}))
   .toHaveAttribute('href',origin+'/apps/workshop/projects/node-000000000106');
  await page.locator('#browse-models').click();
  await page.setViewportSize({width:390,height:844});
  await page.getByLabel('Search models').fill('no-such-part');
  await expect(page.locator('#models-empty')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 } finally { await page.unrouteAll({behavior:'ignoreErrors'});await app.dispose(); }
});
