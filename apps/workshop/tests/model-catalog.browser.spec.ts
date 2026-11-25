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
  await expect(page.locator('#detail-context')).toHaveText('Selected component');
  await expect(page.locator('#project-name')).toContainText('ESP32');
  await expect(page.locator('#assembly-viewer')).toHaveAttribute('data-ready','true',{timeout:60000});
  await expect(page.locator('#assembly-status')).toContainText('1 solids from 1 items');
  const perspective = await page.locator('#assembly-viewer').screenshot();
  await page.getByRole('button',{name:'Top view',exact:true}).click();
  expect(await page.locator('#assembly-viewer').screenshot()).not.toEqual(perspective);
  await page.getByRole('button',{name:'Show all',exact:true}).click();
  await expect(page.locator('#detail-context')).toHaveText('Part model');
  await page.locator('#assembly-viewer').click();
  await expect(page.locator('#detail-context')).toHaveText('Selected component');
  await expect(page.locator('.inspector-header')).toContainText('ESP32');
  await page.locator('#browse-models').click();
  await page.getByLabel('Search models').fill('SNY-C008');
  await expect(page.locator('.model-card')).toContainText('Qty 4');
  await page.locator('.model-card a').click();
  await expect(page.locator('#assembly-status')).toContainText('No geometry');
  await expect(page.locator('.inspector-header')).toContainText('SNY-C008');
  await page.locator('#full-assembly').click();
  await expect(page.locator('#assembly-viewer')).toHaveAttribute('data-ready','true',{timeout:60000});
  await expect(page.locator('#project-name')).toHaveText('SNY-1 soil sensor node');
  // The public SNY-1 demo has stable occurrence addresses across fresh documents.
  const tree = page.getByRole('tree', {name:'Installed components'});
  const electronics = tree.getByRole('treeitem', {name:'Electronics sub-assembly', exact:true});
  const open = electronics.getByRole('link', {name:'Inspect Electronics sub-assembly'});
  const address = await open.getAttribute('href');
  expect(address).toMatch(/\/projects\/node-000000000106\/inspect\/[\w-]+~0$/);
  await open.click();
  await expect(page).toHaveURL(origin+address);
  await expect(page.locator('#project-name')).toHaveText('Electronics sub-assembly');
  const selectedLink = await electronics.getByRole('link', {name:/^Electronics sub-assembly/}).getAttribute('href');
  await page.reload();
  await expect(open).toHaveAttribute('href',address!);
  await expect(electronics.getByRole('link', {name:/^Electronics sub-assembly/})).toHaveAttribute('href',selectedLink!);
  await expect(tree.getByRole('treeitem', {name:/ESP32/})).toBeVisible();
  await page.getByRole('navigation',{name:'Assembly hierarchy'}).getByRole('link',{name:'SNY-1 soil sensor node'}).click();
  await expect(page.locator('#project-name')).toHaveText('SNY-1 soil sensor node');
  await expect(tree.getByRole('treeitem', {name:/ESP32/})).toBeVisible();
  await page.locator('#browse-models').click();
  await page.setViewportSize({width:390,height:844});
  await page.getByLabel('Search models').fill('no-such-part');
  await expect(page.locator('#models-empty')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 } finally { await page.unrouteAll({behavior:'ignoreErrors'});await app.dispose(); }
});
