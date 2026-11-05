import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadConfig,discoverApps,affectedApps,checkApp,changedFiles,runApp} from '../apps.mjs';
function fixture(fn, workspace=false) {
 const root=mkdtempSync(join(tmpdir(),'apps-tooling-'));
 const put=(path,value)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),JSON.stringify(value));};
 try {
  put('package.json',workspace?{workspaces:['apps/*','packages/*']}:{private:true});
  const a=workspace?'apps/alpha':'alpha', b=workspace?'apps/beta':'beta';
  for(const [path,name,dependencies] of [[a,'@somebody/alpha',{'@else/shared':'*'}],[b,'beta',{'@somebody/alpha':'*'}],['packages/shared','@else/shared',{}]]) {
   put(`${path}/package.json`,{name,version:'2.3.4',dependencies,scripts:{check:'true',test:'true',build:'true'}});
   if(path!=='packages/shared') put(`${path}/app.json`,{version:'2.3.4'});
  }
  return fn({root,put,a,b});
 } finally {rmSync(root,{recursive:true,force:true});}
}
for(const workspace of [false,true]) test(`discovers and selects ${workspace?'workspace official':'flat personal'} layout without name/mode assumptions`,()=>fixture(({root,a,b})=>{
 const config=loadConfig(root),apps=discoverApps(root,config);
 assert.deepEqual(apps.map(x=>x.slug),[a,b]);
 assert.deepEqual(affectedApps(apps,[`${a}/src/a.ts`],config),[a,b]);
 assert.deepEqual(affectedApps(apps,[`${b}/src/b.ts`],config),[b]);
 assert.deepEqual(affectedApps(apps,['packages/shared/code.ts'],config),[a,b]);
 assert.deepEqual(affectedApps(apps,['README.md','docs/test.md'],config),[]);
 assert.deepEqual(affectedApps(apps,['deleted-package/code.ts'],config),[a,b]);
 assert.deepEqual(affectedApps(apps,null,config),[a,b]);
 for(const p of [a,b]) checkApp(p,root,config);
},workspace));
test('configured nested discovery and shared globs',()=>fixture(({root,put,a,b})=>{
 put('.outfitter/apps.json',{appGlobs:['apps/*'],sharedInputs:['shared/**'],commands:['test']});
 const c=loadConfig(root),apps=discoverApps(root,c);
 assert.deepEqual(affectedApps(apps,['shared/data.ts'],c),[a,b]);
 assert.equal(apps.length,2);
},true));
test('invalid config and manifest/release drift fail',()=>fixture(({root,put,a})=>{
 put('.outfitter/apps.json',{commands:['test;echo bad']});assert.throws(()=>loadConfig(root));
 put('.outfitter/apps.json',{});put(`${a}/app.json`,{version:'9.0.0'});assert.throws(()=>checkApp(a,root),/versions differ/);
 put(`${a}/app.json`,{version:'2.3.4'});put('.release-please-manifest.json',{[a]:'2.3.5'});assert.throws(()=>checkApp(a,root),/release version differs/);
}));
test('git diff includes deleted paths and both sides of renames; missing history fans out',()=>fixture(({root})=>{
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','--quiet');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');git('add','.');git('commit','--quiet','-m','initial');
 const base=git('rev-parse','HEAD');git('mv','alpha','renamed');git('commit','--quiet','-am','rename');
 const paths=changedFiles(root,{BASE_SHA:base});assert.ok(paths.includes('alpha/app.json'));assert.ok(paths.includes('renamed/app.json'));
 assert.equal(changedFiles(root,{}),null);assert.equal(changedFiles(root,{BASE_SHA:'f'.repeat(40)}),null);
}));

test('script validation requires the caller lockfile and executes caller commands',()=>fixture(({root,put,a})=>{
 const config={...loadConfig(root),validation:'scripts',commands:['test']};
 assert.throws(()=>runApp(a,root,config),/caller-owned package-lock/);
 put('package-lock.json',{lockfileVersion:3,requires:true,packages:{'':{}}});
 put(`${a}/package.json`,{name:'caller-app',version:'1.2.3',scripts:{test:`node -e "require('node:fs').writeFileSync('tested.txt','passed')"`}});
 put(`${a}/app.json`,{version:'1.2.3'});
 runApp(a,root,config);
 assert.ok(existsSync(join(root,a,'tested.txt')));
}));
