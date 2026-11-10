// Package the exact outputs of the app validation job; never rebuild in the
// credential-bearing publication job. The platform verifies workload identity
// and takes the digests of the bytes it accepts.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkApp} from './apps.mjs';
import {catalogMetadata,catalogContract,catalogContractModule} from '../packages/app-build/src/catalog-metadata.mjs';

export async function catalogPublication(appPath,{root=process.cwd(),env=process.env}={}) {
  assert.equal(env.GITHUB_REPOSITORY,'ai-outfitter/apps','Only official apps publish the platform catalog');
  assert.match(env.GITHUB_SHA || '',/^[a-f0-9]{40}$/,'Expected immutable source SHA');
  assert.match(env.GITHUB_RUN_ID || '',/^\d+$/,'Expected workflow run identity');
  const selected=checkApp(appPath,root);
  const directory=resolve(root,selected.slug);
  const app=selected.manifest;
  const slug=app.catalog?.demo?.slug;
  assert.match(slug || '',/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(app.id,`outfitter/${slug}`);
  // Catalog cover serving retains the reviewed raster-only contract. The
  // general app builder also supports SVG for non-catalog apps.
  if(app.catalog.cover) assert.match(app.catalog.cover,/^catalog\/[a-zA-Z0-9_-]+\.(?:png|webp|jpg|jpeg)$/);
  const metadata=await catalogMetadata(directory,app);
  const packages={};
  for(const mode of Object.keys(app.modes)) {
    assert.ok(['demo','operational'].includes(mode));
    const pack=JSON.parse(await readFile(join(directory,`.outfitter/packages/${mode}.json`),'utf8'));
    assert.equal(pack.manifest.id,app.id);
    assert.equal(pack.manifest.version,app.version);
    assert.equal(pack.manifest.mode,mode);
    assert.deepEqual(pack.manifest.capabilities,app.modes[mode].capabilities);
    if(mode==='demo') assert.deepEqual(pack.manifest.capabilities,[],'Demos must remain read-only');
    assert.ok(pack.artifact.modules?.[pack.artifact.mainModule]);
    assert.equal(pack.artifact.modules[catalogContractModule],catalogContract(metadata),
      'Build output does not bind its published catalog metadata; rebuild with the current app builder');
    packages[mode]=pack;
  }
  assert.ok(packages.demo,'Catalog publication requires the checked demo package');
  return {slug,sourceCommit:env.GITHUB_SHA,sourceRunId:env.GITHUB_RUN_ID,app,metadata,packages};
}

function publicationContext(bundle,env) {
  assert.equal(env.GITHUB_REPOSITORY,'ai-outfitter/apps');
  assert.equal(env.GITHUB_REF,`refs/heads/${env.DEPLOY_BRANCH || 'main'}`);
  assert.ok(['push','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  assert.equal(bundle.sourceCommit,env.GITHUB_SHA);
  assert.equal(bundle.sourceRunId,env.GITHUB_RUN_ID);
  const destination=new URL(env.OUTFITTER_URL || 'https://ai-outfitter.com');
  assert.ok(destination.protocol==='https:' && destination.pathname==='/' && !destination.username && !destination.password && !destination.search && !destination.hash,'Expected HTTPS origin');
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,'GitHub OIDC permission is required');
  return destination;
}
async function catalogRequest(path,body,bundle,{env,fetcher}) {
  const destination=publicationContext(bundle,env);
  // Obtain fresh short-lived workload proof for each bounded batch.
  const url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience',destination.origin);
  const identity=await fetcher(url,{headers:{Authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},signal:AbortSignal.timeout(30000),redirect:'error'});
  assert.ok(identity.ok,`OIDC request failed (${identity.status})`);
  const {value:token}=await identity.json();
  assert.ok(typeof token==='string' && token.length>0,'OIDC token is absent');
  // No blind retry: a timeout may already have committed a registry pointer or
  // started an installation operation. The platform records reconciliation.
  const response=await fetcher(new URL(path,destination),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000),redirect:'error'});
  const text=await response.text();
  assert.ok(response.ok,`Catalog request failed (${response.status}): ${text.slice(0,500)}`);
  return JSON.parse(text);
}
export async function publishCatalog(bundle,{env=process.env,fetcher=fetch}={}) {
  return catalogRequest('/api/app-repositories/catalog',bundle,bundle,{env,fetcher});
}
export async function reconcileCatalog(bundle,sha256,{env=process.env,fetcher=fetch}={}) {
  assert.match(sha256,/^[a-f0-9]{64}$/);
  for(let batch=0;batch<20;batch++) {
    const result=await catalogRequest('/api/app-repositories/catalog/deploy',{slug:bundle.slug,sha256},bundle,{env,fetcher});
    for(const key of ['processed','remaining','failed','deferred']) assert.ok(Number.isInteger(result[key]) && result[key]>=0,`Invalid ${key} count`);
    assert.equal(result.failed,0,`${bundle.slug}: deployment failures; inspect installation history`);
    if(result.remaining===0) return result;
    // Busy workflows are durable pending work, not successful activation.
    // A later reconciliation resumes; avoid spinning with no progress.
    if(result.processed===0) throw Error(`${bundle.slug}: ${result.remaining} installations pending (${result.deferred} deferred); inspect deployment status`);
  }
  throw Error(`${bundle.slug}: reconciliation batch limit reached; inspect deployment status`);
}

/** Re-runs of failed publication jobs reuse the successful check jobs' earlier
 * attempts. Choose the newest retained attempt per expected app, never a subset. */
export async function selectCatalogArtifacts(directory,appPaths,{root=process.cwd(),env=process.env}={}) {
  assert.ok(Array.isArray(appPaths) && appPaths.length>0);
  const expected=new Set();
  for(const path of appPaths) {
    assert.match(path,/^apps\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const app=JSON.parse(await readFile(join(root,path,'app.json'),'utf8'));
    assert.ok(app.id?.startsWith('outfitter/'));
    expected.add(app.id.slice('outfitter/'.length));
  }
  const selected=new Map();
  for(const name of await readdir(directory)) {
    const match=/^catalog-[0-9]+-([0-9]+)-([0-9]+)$/.exec(name);
    assert.ok(match && match[1]===env.GITHUB_RUN_ID,'Unexpected catalog artifact identity');
    const bundle=JSON.parse(await readFile(join(directory,name,'bundle.json'),'utf8'));
    assert.ok(expected.has(bundle.slug),'Unexpected app in retained catalog artifact');
    assert.equal(bundle.sourceCommit,env.GITHUB_SHA);
    assert.equal(bundle.sourceRunId,env.GITHUB_RUN_ID);
    const previous=selected.get(bundle.slug);
    if(!previous || previous.attempt<Number(match[2])) selected.set(bundle.slug,{attempt:Number(match[2]),bundle});
  }
  assert.equal(selected.size,expected.size,'Missing checked catalog artifacts; rerun the affected check jobs');
  const ordered=[],visiting=new Set(),visited=new Set();
  function visit(slug) {
    if(visited.has(slug)) return;
    assert.ok(!visiting.has(slug),'Cyclic catalog dependencies');visiting.add(slug);
    const bundle=selected.get(slug).bundle;
    for(const dep of bundle.app.dependencies ?? []) if(selected.has(dep)) visit(dep);
    visiting.delete(slug);visited.add(slug);ordered.push(bundle);
  }
  for(const slug of expected) visit(slug);
  return ordered;
}

/** Publish dependency channels first. Activation failures remain per-owner work
 * in the platform queue, so one owner's busy dependency cannot block others. */
export async function publishCatalogSet(bundles,{publish=publishCatalog,reconcile=reconcileCatalog,report=value=>console.log(JSON.stringify(value))}={}) {
  const bySlug=new Map(bundles.map(bundle=>[bundle.slug,bundle]));
  const pending=new Map();
  function start(bundle) {
    if(pending.has(bundle.slug)) return pending.get(bundle.slug);
    const task=(async()=>{
      for(const dependency of bundle.app.dependencies ?? [])
        if(bySlug.has(dependency)) await start(bySlug.get(dependency));
      return publish(bundle);
    })();
    pending.set(bundle.slug,task);
    return task;
  }
  const published=await Promise.allSettled(bundles.map(start));
  const failures=[];
  for(const [index,result] of published.entries()) {
    const bundle=bundles[index];
    if(result.status==='rejected') { failures.push(`${bundle.slug}: publication or dependency failed: ${result.reason.message}`);continue; }
    try { report({slug:bundle.slug,...await reconcile(bundle,result.value.sha256)}); }
    catch(error) { failures.push(`${bundle.slug}: ${error.message}`); }
  }
  assert.equal(failures.length,0,failures.join('\n'));
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [command,input,output]=process.argv.slice(2);
  if(command==='prepare') {
    assert.ok(input && output,'prepare APP_PATH OUTPUT');
    const bundle=await catalogPublication(input);
    await mkdir(dirname(resolve(output)),{recursive:true});
    await writeFile(output,JSON.stringify(bundle));
  } else if(command==='publish') {
    assert.ok(input,'publish BUNDLE');
    const bundle=JSON.parse(await readFile(input,'utf8'));
    const result=await publishCatalog(bundle);
    console.log(JSON.stringify(result));
    console.log(JSON.stringify(await reconcileCatalog(bundle,result.sha256)));
  } else if(command==='publish-all') {
    const bundles=await selectCatalogArtifacts(input,JSON.parse(process.env.SELECTED_APPS));
    await publishCatalogSet(bundles);
  } else throw Error('Usage: catalog-publication.mjs prepare APP_PATH OUTPUT | publish BUNDLE | publish-all DIRECTORY');
}
