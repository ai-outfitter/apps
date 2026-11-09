import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {buildApp} from '../src/build.mjs';

test('packages both modes outside dist, preserves migrations, and produces a read-only demo',async()=>{
 const root=await mkdtemp(join(tmpdir(),'public-app-build-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({name:'independent-scope',version:'0.1.0',type:'module'}));
  await mkdir(join(root,'node_modules/@ai-outfitter'),{recursive:true});
  await symlink(resolve('../ui'),join(root,'node_modules/@ai-outfitter/ui'),'dir');
  await writeFile(join(root,'app.json'),JSON.stringify({id:'example/portable',version:'0.1.0',source:'single-html',runtime:'cloudflare-worker',dataLocation:'installation-database',modes:{demo:{capabilities:[]},operational:{capabilities:['database','graph.serve']}}}));
  await writeFile(join(root,'index.html'),'<h1>Portable</h1>');
  await mkdir(join(root,'migrations'));await writeFile(join(root,'migrations/0000.sql'),'CREATE TABLE sample (id TEXT);');
  await mkdir(join(root,'graph'));
 await writeFile(join(root,'graph/schema.graphql'),'type Query { sample: String }');
 await writeFile(join(root,'graph/documents.json'),JSON.stringify([{name:'PortableSample',story:'As an owner, I want to read sample data, so that I can check the portable package.',query:'query PortableSample { sample }',mcp:{description:'Read portable sample data.'}}]));
 const paths=await buildApp(root);
  assert.equal(paths.length,2);
  const demo=JSON.parse(await readFile(paths[0],'utf8')),operational=JSON.parse(await readFile(paths[1],'utf8'));
  assert.equal(demo.manifest.mode,'demo');assert.deepEqual(demo.manifest.capabilities,[]);
  assert.equal(demo.manifest.graph,undefined);assert.equal(operational.manifest.graph.documents[0].name,'PortableSample');assert.equal(operational.manifest.graph.documents[0].mcp.description,'Read portable sample data.');assert.match(operational.manifest.graph.documents[0].hash,/^[a-f0-9]{64}$/);
  assert.equal(demo.manifest.database,undefined);assert.equal(operational.manifest.database.migrations[0].name,'0000');
  assert.match(demo.artifact.modules[demo.artifact.mainModule],/Portable/);
  assert.ok(demo.artifact.assets['/_astro/tokens.css']);
  const [preview]=await buildApp(root,{mode:'demo',output:'dist/preview.json'});
  assert.equal(JSON.parse(await readFile(preview,'utf8')).manifest.mode,'demo');
  await assert.rejects(buildApp(root,{mode:'invalid'}),/supported app modes/);
 } finally {await rm(root,{recursive:true,force:true});}
});
