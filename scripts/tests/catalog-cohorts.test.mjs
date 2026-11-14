import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('actual reusable workflow selection isolates catalog publication from unrelated source app checks',async t=>{
 const source=await readFile(new URL('../../.github/workflows/check.yml',import.meta.url),'utf8');
 const script=source.match(/- id: catalog[\s\S]+?<<'NODE'\n([\s\S]+?)          NODE/)[1].replace(/^          /gm,'');
 const root=await mkdtemp(join(tmpdir(),'catalog-cohorts-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [cohort,selected] of [['all',['apps/onto','apps/planning']],['catalog',['apps/onto']],['source',['apps/planning']]]) {
  const path=join(root,cohort);
  execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,SELECTED_APPS:'["apps/onto","apps/planning"]',CATALOG_APPS:'["apps/onto"]',APP_SET:cohort,GITHUB_OUTPUT:path}});
  const output=Object.fromEntries((await readFile(path,'utf8')).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  assert.deepEqual(JSON.parse(output.selected),selected);assert.equal(output.has_apps,'true');
  assert.deepEqual(JSON.parse(output.apps),selected.filter(path=>path==='apps/onto'));
 }
 const ci=await readFile(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
 assert.match(ci,/deploy:\n    needs: apps/);
 assert.match(ci,/deploy-source-apps:\n    needs: source-apps/);
});

test('both cohorts retain validation evidence under distinct names in the same run',async()=>{
 const source=await readFile(new URL('../../.github/workflows/check.yml',import.meta.url),'utf8');
 const template=source.match(/name: (app-validation-[^\n]+)/)[1];
 function name(cohort) {
  const values={'inputs.app-set':cohort,'strategy.job-index':'0','github.run_id':'123','github.run_attempt':'1'};
  return template.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g,(_,key)=>values[key.trim()]);
 }
 assert.notEqual(name('catalog'),name('source'));
 assert.equal(name('catalog'),'app-validation-catalog-0-123-1');
});
