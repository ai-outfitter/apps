import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
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
});

test('a second push still requires SDK validation when the prior push left stale snapshots', async t => {
 const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
 const check = await readFile(new URL('../../.github/workflows/check.yml', import.meta.url), 'utf8');
 const baseline = ci.match(/id: baseline\n[\s\S]+?run: \|\n((?: {10}[^\n]*\n)+)/)[1];
 const paths = ci.match(/id: paths\n[\s\S]+?run: \|\n((?: {10}[^\n]*\n)+)/)[1];
 const appBaseline = check.match(/id: baseline\n[\s\S]+?run: \|\n((?: {10}[^\n]*\n)+)/)[1];
 const catalog = check.match(/- id: catalog[\s\S]+?run: \|\n((?: {10}[^\n]*\n)+)/)[1].replace(/^ {10}/gm, '');
 assert.match(ci, /BASE: \$\{\{ github.event.pull_request.base.sha \|\| steps.baseline.outputs.sha \}\}/);
 assert.match(ci, /push-baseline: \$\{\{ steps.baseline.outputs.sha \}\}/);
 assert.match(ci, /sdk:\n    needs: changes\n    if: needs.changes.outputs.sdk == 'true'/);
 assert.match(ci, /run: npm run graph:compose -- --check/);
 for (const [cohort, deploy, output] of [
  ['apps', 'deploy', 'catalog_apps'],
  ['source-apps', 'deploy-source-apps', 'non_catalog_apps'],
 ]) {
  const job = ci.split(`\n  ${cohort}:\n`)[1].split(/\n  [a-z][\w-]*:/)[0];
  assert.match(job, /needs: changes/);
  assert.match(job, /push-baseline: \$\{\{ needs.changes.outputs.push-baseline \}\}/);
  const publication = ci.split(`\n  ${deploy}:\n`)[1].split(/\n  [a-z][\w-]*:/)[0];
  assert.ok(publication.includes(`needs: [changes, sdk, ${cohort}]`));
  assert.ok(publication.includes(`needs.${cohort}.result == 'success'`));
  assert.ok(publication.includes("(needs.sdk.result == 'success' || (needs.sdk.result == 'skipped' && needs.changes.outputs.sdk == 'false'))"));
  assert.ok(publication.includes(`github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.${cohort}.outputs.${output} != '[]'`));
 }

 const root = await mkdtemp(join(tmpdir(), 'sdk-push-baseline-'));
 t.after(() => rm(root, {recursive: true, force: true}));
 const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
 git('init', '-q');
 git('config', 'user.email', 'ci@example.com');
 git('config', 'user.name', 'ci');
 async function commit(file, contents) {
  await writeFile(join(root, file), contents);
  git('add', file);
  git('commit', '-qm', file);
  return git('rev-parse', 'HEAD');
 }
 async function runStep(script, env) {
  const output = join(root, 'output');
  await writeFile(output, '');
  execFileSync('bash', ['-e', '-c', script], {
   cwd: root,
   env: {...process.env, ...env, RUNNER_TEMP: root, GITHUB_OUTPUT: output},
  });
  return (await readFile(output, 'utf8')).trim();
 }
 async function pushBaseline(successfulSha) {
  const output = await runStep(`
   gh() {
     [[ " $* " == *" -f event=push -f status=success "* ]] || exit 2
     printf '%s' "$SUCCESSFUL_SHA"
   }
   ${baseline}
  `, {SUCCESSFUL_SHA: successfulSha});
  assert.match(output, /^sha=/);
  return output.slice(4);
 }

 const configPath = '.outfitter/apps.json';
 await mkdir(join(root, '.outfitter'));
 const config = await readFile(new URL(`../../${configPath}`, import.meta.url), 'utf8');
 const lastSuccess = await commit(configPath, config);
 await mkdir(join(root, 'apps/planning/seeds'), {recursive: true});
 const firstPush = await commit('apps/planning/seeds/work-graph-v1.json', 'Changed contribution');
 assert.equal(await runStep(paths, {BASE: await pushBaseline(lastSuccess)}), 'sdk=true');
 // The SDK check fails on the first push, so GitHub still returns lastSuccess.
 const secondPush = await commit('README.md', 'Unrelated follow-up');
 const selectedBaseline = await pushBaseline(lastSuccess);
 assert.equal(selectedBaseline, lastSuccess);
 assert.equal(await runStep(appBaseline, {PUSH_BASELINE: selectedBaseline}), `sha=${lastSuccess}`);
 const apps = '["apps/onto","apps/planning"]';
 const selection = await runStep(catalog, {
  CONFIG_PATH: configPath,
  APP_SET: 'catalog',
  SELECTED_APPS: apps,
  CATALOG_APPS: apps,
  BASE_SHA: selectedBaseline,
  HEAD_SHA: secondPush,
 });
 assert.ok(selection.split('\n').includes(`apps=${apps}`));
 assert.equal(await runStep(paths, {BASE: selectedBaseline}), 'sdk=true');
 assert.equal(await runStep(paths, {BASE: firstPush}), 'sdk=false');
 assert.equal(await runStep(appBaseline, {PUSH_BASELINE: ''}), 'sha=');
 assert.equal(await runStep(paths, {BASE: await pushBaseline('')}), 'sdk=true');
 git('checkout', '--detach', '-q', firstPush);
 assert.equal(await pushBaseline(secondPush), '');
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

test('validation and previews include direct changes and their configured shared consumers',async t=>{
 const scripts=await Promise.all(['check','preview'].map(async workflow=>{
  const source=await readFile(new URL(`../../.github/workflows/${workflow}.yml`,import.meta.url),'utf8');
  return source.match(/- id: (?:catalog|direct)[\s\S]+?<<'NODE'\n([\s\S]+?)          NODE/)[1].replace(/^          /gm,'');
 }));
 const configPath='.outfitter/apps.json';
 const config=await readFile(new URL(`../../${configPath}`,import.meta.url),'utf8');
 const root=await mkdtemp(join(tmpdir(),'catalog-direct-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','ci@example.com');git('config','user.name','ci');
 for(const dir of ['.outfitter','apps/onto','apps/planning/seeds','apps/forerunner/seeds','apps/creative-team/seeds','apps/workshop/graph/nested','packages/app-sdk/src','scripts']) await mkdir(join(root,dir),{recursive:true});
 await writeFile(join(root,configPath),config);
 git('add','.');git('commit','-qm','base');
 const graphApps=['apps/creative-team','apps/forerunner','apps/onto','apps/planning','apps/video-production','apps/workshop'];
 const apps=JSON.stringify([...graphApps,'apps/wiki']);
 const cases=[
  ['apps/workshop/graph/nested/part.ts',graphApps],
  ['apps/planning/a.ts',['apps/planning']],
  ['packages/app-sdk/src/unrelated.ts',[]],
  ['apps/planning/seeds/work-graph-v1.json',graphApps],
  ['apps/forerunner/seeds/discovery-graph-v1.json',graphApps],
  ['apps/creative-team/seeds/creative-v1.json',graphApps],
  ['scripts/compose-graphs.ts',graphApps],
  ['packages/app-sdk/src/graph-authoring.ts',graphApps],
 ];
 for(const [changed,expected] of cases){
  const base=git('rev-parse','HEAD');
  await writeFile(join(root,changed),'example');
  git('add',changed);git('commit','-qm',changed);
  const head=git('rev-parse','HEAD');
  for(const [index,script] of scripts.entries()){
   const output=join(root,`${head}-${index}`);
   execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env:{...process.env,CONFIG_PATH:configPath,SELECTED_APPS:apps,CATALOG_APPS:apps,APP_SET:'catalog',BASE_SHA:base,HEAD_SHA:head,GITHUB_OUTPUT:output}});
   const lines=(await readFile(output,'utf8')).trim().split('\n');
   assert.ok(lines.includes(`apps=${JSON.stringify(expected)}`),`${changed}: ${lines.join(' ')}`);
  }
 }
});
