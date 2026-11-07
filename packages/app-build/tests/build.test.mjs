import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {buildApp} from '../src/build.mjs';
import {createHash} from 'node:crypto';

test('packages both modes outside dist, preserves migrations, and produces a read-only demo',async()=>{
 const root=await mkdtemp(join(tmpdir(),'public-app-build-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({name:'independent-scope',version:'0.1.0',type:'module'}));
  await mkdir(join(root,'node_modules/@ai-outfitter'),{recursive:true});
  await symlink(resolve('../ui'),join(root,'node_modules/@ai-outfitter/ui'),'dir');
  await writeFile(join(root,'app.json'),JSON.stringify({id:'example/portable',version:'0.1.0',source:'single-html',runtime:'cloudflare-worker',dataLocation:'installation-database',modes:{demo:{capabilities:[]},operational:{capabilities:['database']}}}));
  await writeFile(join(root,'index.html'),'<h1>Portable</h1>');
  await mkdir(join(root,'migrations'));await writeFile(join(root,'migrations/0000_sample.sql'),'CREATE TABLE sample (id TEXT);');
  const paths=await buildApp(root);
  assert.equal(paths.length,2);
  const demo=JSON.parse(await readFile(paths[0],'utf8')),operational=JSON.parse(await readFile(paths[1],'utf8'));
  assert.equal(demo.manifest.mode,'demo');assert.deepEqual(demo.manifest.capabilities,[]);
  assert.equal(demo.manifest.database,undefined);assert.equal(operational.manifest.database.migrations[0].name,'0000_sample');
  assert.match(demo.artifact.modules[demo.artifact.mainModule],/Portable/);
  assert.match(demo.artifact.modules[demo.artifact.mainModule],/const app = "portable"/);
  assert.ok(demo.artifact.assets['/_astro/tokens.css']);
  const [preview]=await buildApp(root,{mode:'demo',output:'dist/preview.json'});
  assert.equal(JSON.parse(await readFile(preview,'utf8')).manifest.mode,'demo');
  await mkdir(join(root,'migrations/baselines'));
  const baselineSql='CREATE TABLE sample (id TEXT);';
  await writeFile(join(root,'migrations/baselines/v1.sql'),baselineSql);
  await writeFile(join(root,'migration-baseline.json'),JSON.stringify({version:1,baselines:[{name:'0000_sample_baseline',file:'migrations/baselines/v1.sql',sha256:createHash('sha256').update(baselineSql).digest('hex'),replaces:['0000_sample']}]}));
  const [freshPackage]=await buildApp(root,{mode:'operational'});
  const fresh=JSON.parse(await readFile(freshPackage,'utf8'));
  assert.deepEqual(fresh.manifest.database.migrations,operational.manifest.database.migrations);
  assert.deepEqual(fresh.manifest.database.baselines,[{name:'0000_sample_baseline',sql:baselineSql,replaces:['0000_sample']}]);
  await assert.rejects(buildApp(root,{mode:'invalid'}),/supported app modes/);
 } finally {await rm(root,{recursive:true,force:true});}
});
