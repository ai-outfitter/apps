// Shared build contract for an Outfitter installation's isolated source workspace.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname,basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverApps,loadConfig,checkApp} from './apps.mjs';
export function buildRepository(source,slug,output,{run=(args,cwd)=>execFileSync('npm',args,{cwd,stdio:'inherit'})}={}) {
  source=resolve(source);
  const config=loadConfig(source);
  const matches=discoverApps(source,config).filter(app=>(app.manifest?.slug || app.manifest?.catalog?.operational?.slug || basename(app.slug))===slug);
  assert.equal(matches.length,1,'Expected exactly one selected app');
  const selected=matches[0];
  checkApp(selected.slug,source,config);
  assert.ok(existsSync(join(source,'package-lock.json')),'Repository builds require a committed npm lockfile');
  const directory=resolve(source,selected.slug);
  const commands=['check',...(selected.pkg.scripts?.test ? ['test'] : []),'build'];
  if(existsSync(join(directory,'tests'))) assert.ok(selected.pkg.scripts?.test,'App tests require a test script');
  for(const command of commands) assert.ok(selected.pkg.scripts?.[command],`Missing ${command}`);
  run(['ci'],source);
  for(const command of commands) run(['run',command],directory);
  const bytes=readFileSync(join(directory,'.outfitter/packages/operational.json'));
  const built=JSON.parse(bytes);
  assert.equal(built.manifest?.mode,'operational','Build did not produce an operational package');
  assert.ok(built.artifact?.modules && built.artifact?.assets,'Missing build artifact');
  mkdirSync(dirname(resolve(output)),{recursive:true});
  writeFileSync(output,bytes);
  return selected;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [source,slug,output]=process.argv.slice(2);
  assert.ok(source && slug && output,'Usage: repository-build.mjs SOURCE APP_SLUG OUTPUT');
  buildRepository(source,slug,output);
}
