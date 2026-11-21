import { routeReadOnly } from '@ai-outfitter/app-test/playwright';
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
  await page.goto(origin+'/projects/node-000000000106/models');
  await expect(page.locator('.model-card')).toHaveCount(13);
  await page.getByLabel('Search models').fill('ESP32');
  await expect(page.locator('.model-card')).toHaveCount(1);
  await page.locator('.model-card').getByRole('link',{name:'View model',exact:true}).click();
  await expect(page).toHaveURL(/\/projects\/node-000000000106\?item=/);
  await expect(page.getByRole('tab',{name:'Selected'})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#project-name')).toContainText('ESP32');
  await expect(page.locator('#assembly-viewer')).toHaveAttribute('data-ready','true',{timeout:60000});
  await expect(page.locator('#assembly-status')).toContainText('1 solids from 1 items');
  const perspective = await page.locator('#assembly-viewer').screenshot();
  await page.getByRole('button',{name:'Top view',exact:true}).click();
  expect(await page.locator('#assembly-viewer').screenshot()).not.toEqual(perspective);
  await page.getByRole('button',{name:'Show all',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Selected'})).toHaveCount(0);
  await page.locator('#assembly-viewer').click();
  await expect(page.getByRole('tab',{name:'Selected'})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#item-details')).toContainText('ESP32');
  await page.locator('#browse-models').click();
  await page.getByLabel('Search models').fill('SNY-C008');
  await expect(page.locator('.model-card')).toContainText('Qty 4');
  await page.locator('.model-card a').click();
  await expect(page.locator('#assembly-status')).toContainText('No geometry');
  await expect(page.locator('#item-details')).toContainText('SNY-C008');
  await page.locator('#full-assembly').click();
  await expect(page.locator('#assembly-viewer')).toHaveAttribute('data-ready','true',{timeout:60000});
  await expect(page.locator('#project-name')).toHaveText('SNY-1 soil sensor node');
  // The SNY-1 root places seven immediate component definitions.
  const components = page.locator('#inspection-tree > ul > li');
  await page.getByRole('tab',{name:'Components'}).click();
  await expect(components).toHaveCount(7);
  await page.locator('#inspection-tree').getByRole('button',{name:'Electronics sub-assembly',exact:true}).click();
  await page.locator('#item-details').getByRole('link',{name:/Open model/}).click();
  await expect(page.locator('#assembly-breadcrumbs')).toContainText('Project overview');
  await expect(page.locator('#assembly-parents a').first()).toBeVisible();
  await page.locator('#assembly-parents a').first().click();
  await expect(page.locator('#project-name')).toHaveText('SNY-1 soil sensor node');
  await expect(components).toHaveCount(7);
  await page.locator('#browse-models').click();
  await page.setViewportSize({width:390,height:844});
  await page.getByLabel('Search models').fill('no-such-part');
  await expect(page.locator('#models-empty')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 } finally { await page.unrouteAll({behavior:'ignoreErrors'});await app.dispose(); }
});
