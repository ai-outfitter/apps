import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {catalogContract,catalogContractModule} from '../../packages/app-build/src/catalog-metadata.mjs';
import {catalogPublication,publishCatalog} from '../catalog-publication.mjs';
const sha='a'.repeat(40);
const env={GITHUB_REPOSITORY:'ai-outfitter/apps',GITHUB_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'push',ACTIONS_ID_TOKEN_REQUEST_URL:'https://oidc.example/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'private'};
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'catalog-publish-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'apps/test/.outfitter/packages'),{recursive:true});
  await mkdir(join(root,'.outfitter'));
  await mkdir(join(root,'apps/test/graph'));
  await writeFile(join(root,'.outfitter/apps.json'),JSON.stringify({appGlobs:['apps/*']}));
  await writeFile(join(root,'package.json'),JSON.stringify({workspaces:['apps/*']}));
  const app={id:'outfitter/test',version:'0.1.0',runtime:'cloudflare-worker',dataLocation:'installation-database',modes:{demo:{capabilities:[]},operational:{capabilities:['database']}},catalog:{access:'public',demo:{slug:'test',name:'Test',description:'Synthetic'},operational:{slug:'test',name:'Test',description:'Synthetic'}}};
  await writeFile(join(root,'apps/test/package.json'),JSON.stringify({name:'@test/app',version:'0.1.0',scripts:{check:'true',test:'true',build:'true'},outfitter:{kind:'app'}}));
  await writeFile(join(root,'apps/test/app.json'),JSON.stringify(app));
  for(const mode of ['demo','operational']) await writeFile(join(root,`apps/test/.outfitter/packages/${mode}.json`),JSON.stringify({manifest:{id:app.id,version:app.version,mode,capabilities:app.modes[mode].capabilities},artifact:{mainModule:'index.js',modules:{'index.js':'export default {}',[catalogContractModule]:catalogContract({documents:[{name:'Test'}]})},assets:{'/index.html':'synthetic'}}}));
  await writeFile(join(root,'apps/test/graph/documents.json'),'[{"name":"Test"}]');
  return root;
}
test('retains checked bytes for both modes with same-run source and metadata',async t=>{
  const root=await fixture(t);
  const bundle=await catalogPublication('apps/test',{root,env});
  assert.equal(bundle.sourceCommit,sha);assert.equal(bundle.sourceRunId,'123');
  assert.deepEqual(Object.keys(bundle.packages),['demo','operational']);
  assert.deepEqual(bundle.metadata.documents,[{name:'Test'}]);
  assert.equal(bundle.metadata.graph,undefined);
  assert.equal(bundle.packages.operational.manifest.mode,'operational');
});
test('does not accept missing or mismatched build outputs or foreign repository',async t=>{
  const root=await fixture(t);
  await assert.rejects(catalogPublication('apps/test',{root,env:{...env,GITHUB_REPOSITORY:'other/apps'}}),/official/);
  await writeFile(join(root,'apps/test/.outfitter/packages/demo.json'),JSON.stringify({manifest:{id:'outfitter/other'}}));
  await assert.rejects(catalogPublication('apps/test',{root,env}));
});
test('publication obtains OIDC for exact destination and submits immutable bundle',async()=>{
  const bundle={sourceCommit:sha,sourceRunId:'123'};const calls=[];
  const result=await publishCatalog(bundle,{env,fetcher:async(url,options)=>{
    calls.push([String(url),options]);
    return calls.length===1?Response.json({value:'verified-token'}):Response.json({sha256:'b'.repeat(64)});
  }});
  assert.equal(result.sha256,'b'.repeat(64));
  assert.equal(new URL(calls[0][0]).searchParams.get('audience'),'https://ai-outfitter.com');
  assert.equal(calls[1][0],'https://ai-outfitter.com/api/app-repositories/catalog');
  assert.equal(calls[1][1].headers.Authorization,'Bearer verified-token');
  assert.deepEqual(JSON.parse(calls[1][1].body),bundle);
});
test('rejects wrong branch, source/run substitution and insecure destination before requests',async()=>{
  const bundle={sourceCommit:sha,sourceRunId:'123'};
  for(const bad of [{GITHUB_REF:'refs/pull/1/merge'},{GITHUB_SHA:'b'.repeat(40)},{GITHUB_RUN_ID:'999'},{OUTFITTER_URL:'http://localhost'}])
    await assert.rejects(publishCatalog(bundle,{env:{...env,...bad},fetcher:()=>{throw Error('must not fetch')}}));
});

test('reconciliation advances bounded batches using registry digest, refuses failed or stalled activation',async()=>{
  const {reconcileCatalog}=await import('../catalog-publication.mjs');
  const bundle={slug:'test',sourceCommit:sha,sourceRunId:'123'};let batches=0;
  const calls=[];
  const fetcher=async(url,options)=>{
    if(String(url).startsWith('https://oidc.example')) return Response.json({value:'token'});
    calls.push(JSON.parse(options.body));batches++;
    return Response.json({processed:3,remaining:batches===1?3:0,failed:0,deferred:0});
  };
  assert.equal((await reconcileCatalog(bundle,'b'.repeat(64),{env,fetcher})).remaining,0);
  assert.deepEqual(calls,[{slug:'test',sha256:'b'.repeat(64)},{slug:'test',sha256:'b'.repeat(64)}]);
  for(const result of [{processed:0,remaining:1,failed:0,deferred:1},{processed:1,remaining:0,failed:1,deferred:0}])
    await assert.rejects(reconcileCatalog(bundle,'b'.repeat(64),{env,fetcher:async url=>String(url).startsWith('https://oidc.example')?Response.json({value:'token'}):Response.json(result)}));
});

test('failed-job reruns select newest retained attempt and refuse missing or foreign artifacts',async t=>{
  const {selectCatalogArtifacts}=await import('../catalog-publication.mjs');
  const root=await fixture(t);const directory=join(root,'retained');await mkdir(directory);
  const bundle=await catalogPublication('apps/test',{root,env});
  for(const attempt of [1,2]) {
    const folder=join(directory,`catalog-0-123-${attempt}`);await mkdir(folder);
    await writeFile(join(folder,'bundle.json'),JSON.stringify({...bundle,app:{...bundle.app,version:`attempt-${attempt}`}}));
  }
  const [selected]=await selectCatalogArtifacts(directory,['apps/test'],{root,env});
  assert.equal(selected.app.version,'attempt-2');
  await rm(join(directory,'catalog-0-123-2'),{recursive:true});
  assert.equal((await selectCatalogArtifacts(directory,['apps/test'],{root,env}))[0].app.version,'attempt-1');
  await assert.rejects(selectCatalogArtifacts(directory,['apps/test'],{root,env:{...env,GITHUB_SHA:'b'.repeat(40)}}));
  await rm(join(directory,'catalog-0-123-1'),{recursive:true});
  await assert.rejects(selectCatalogArtifacts(directory,['apps/test'],{root,env}),/Missing checked/);
});

test('dependency publication failure skips dependents while independent apps still reconcile',async()=>{
  const {publishCatalogSet}=await import('../catalog-publication.mjs');
  const bundles=[{slug:'onto',app:{}},{slug:'wiki-map',app:{dependencies:['onto']}},{slug:'html-starter',app:{}}];
  const published=[],reconciled=[];
  await assert.rejects(publishCatalogSet(bundles,{
    publish:async bundle=>{published.push(bundle.slug);if(bundle.slug==='onto')throw Error('source superseded');return {sha256:'b'.repeat(64)};},
    reconcile:async bundle=>{reconciled.push(bundle.slug);return {remaining:0};},report:()=>{},
  }),/publication or dependency failed/);
  assert.deepEqual(published.sort(),['html-starter','onto']);
  assert.deepEqual(reconciled,['html-starter']);
});

test('accepted publication reports per-owner activation pending without failing source CI',async()=>{
  const {publishCatalogSet}=await import('../catalog-publication.mjs');
  const reported=[];
  const result=await publishCatalogSet([{slug:'onto',app:{}}],{
    publish:async()=>({sha256:'b'.repeat(64)}),
    reconcile:async()=>{throw Object.assign(Error('Busy owner workflow'),{deployment:{processed:0,remaining:2,failed:0,deferred:2}});},
    report:status=>reported.push(status),
  });
  assert.equal(result.length,1);assert.equal(result[0].status,'activation-pending');
  assert.equal(result[0].remaining,2);assert.equal(result[0].deferred,2);
  assert.deepEqual(reported,result);
});

test('transport errors after durable publication are reported as unverified, never completed activation',async()=>{
 const {publishCatalogSet}=await import('../catalog-publication.mjs');
 const [status]=await publishCatalogSet([{slug:'onto',app:{}}],{
  publish:async()=>({sha256:'b'.repeat(64)}),reconcile:async()=>{throw Error('OIDC service unavailable');},report:()=>{},
 });
 assert.equal(status.status,'activation-unverified');assert.equal(status.remaining,undefined);
 assert.equal(status.message,'OIDC service unavailable');
});
