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

test('validation covers only apps with files changed in their own directory',async t=>{
 const source=await readFile(new URL('../../.github/workflows/check.yml',import.meta.url),'utf8');
 const script=source.match(/- id: catalog[\s\S]+?<<'NODE'\n([\s\S]+?)          NODE/)[1].replace(/^          /gm,'');
 const root=await mkdtemp(join(tmpdir(),'catalog-direct-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 const {mkdir,writeFile}=await import('node:fs/promises');
 git('init','-q');git('config','user.email','ci@example.com');git('config','user.name','ci');
 for(const dir of ['apps/onto','apps/planning','packages/app-sdk']) await mkdir(join(root,dir),{recursive:true});
 await writeFile(join(root,'package-lock.json'),'{}');await writeFile(join(root,'apps/onto/a.ts'),'');await writeFile(join(root,'apps/planning/a.ts'),'');
 git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
 await writeFile(join(root,'package-lock.json'),'{"x":1}');await writeFile(join(root,'packages/app-sdk/a.ts'),'');await writeFile(join(root,'apps/planning/a.ts'),'x');
 git('add','.');git('commit','-qm','head');const head=git('rev-parse','HEAD');
 const output=join(root,'out');
 execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env:{...process.env,SELECTED_APPS:'["apps/onto","apps/planning"]',CATALOG_APPS:'["apps/onto","apps/planning"]',APP_SET:'catalog',BASE_SHA:base,HEAD_SHA:head,GITHUB_OUTPUT:output}});
 const lines=(await readFile(output,'utf8')).trim().split('\n');
 assert.ok(lines.includes('selected=["apps/planning"]'));assert.ok(lines.includes('apps=["apps/planning"]'));
});
