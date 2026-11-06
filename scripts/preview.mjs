import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {checkApp,loadConfig} from './apps.mjs';
const shaPattern=/^[a-f0-9]{40}$/;
// Match the Workers static asset limit, including decompressed WASM.
const maxAssetBytes=25*1024*1024;
const run=(command,args,cwd=process.cwd())=>execFileSync(command,args,{cwd,stdio:'inherit'});
const read=path=>JSON.parse(readFileSync(path,'utf8'));
export async function planPreview(env=process.env,fetcher=fetch) {
  const repository=env.GITHUB_REPOSITORY;
  assert.match(repository || '',/^[\w.-]+\/[\w.-]+$/);
  assert.match(env.PR_NUMBER || '',/^[1-9]\d*$/);
  assert.ok(env.GH_TOKEN,'Missing repository metadata token');
  const response=await fetcher(`https://api.github.com/repos/${repository}/pulls/${env.PR_NUMBER}`,{
    headers:{Authorization:`Bearer ${env.GH_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30_000)});
  assert.ok(response.ok,`Cannot resolve PR source (${response.status})`);
  const pr=await response.json();
  assert.equal(pr.head.repo?.full_name?.toLowerCase(),repository.toLowerCase(),'Fork previews require a separate reviewed import');
  assert.match(pr.head.sha,shaPattern);assert.match(pr.base.sha,shaPattern);
  const mode=env.PREVIEW_BUILD_MODE || 'package';assert.ok(['package','toolchain'].includes(mode));
  const closed=pr.state==='closed';let privateAuthorized=false;
  if(mode==='toolchain' && !closed) {
    assert.match(env.TOOLCHAIN_SHA || '',shaPattern,'Private SDK requires a pinned toolchain');
    const trusted=JSON.parse(env.TRUSTED_BUILD_ACTORS || '[]');
    assert.ok(Array.isArray(trusted) && trusted.every(actor=>typeof actor==='string' && actor.length),'Invalid trusted build actor list');
    const allowed=actor=>typeof actor==='string' && trusted.some(name=>name.toLowerCase()===actor.toLowerCase());
    privateAuthorized=env.GITHUB_EVENT_NAME==='workflow_dispatch' ||
      (env.GITHUB_EVENT_NAME==='pull_request' && allowed(env.GITHUB_ACTOR) && allowed(pr.user?.login));
    assert.ok(privateAuthorized,'Private SDK preview requires a reviewed dispatch or an explicitly trusted PR author and triggering actor');
  }
  const outputs={sha:pr.head.sha,base:pr.base.sha,closed:String(closed),private_authorized:String(privateAuthorized)};
  if(env.GITHUB_OUTPUT) for(const [key,value] of Object.entries(outputs)) appendFileSync(env.GITHUB_OUTPUT,`${key}=${value}\n`);
  return outputs;
}
export function previewIdentity(repositoryId,number,app) {
  assert.match(String(repositoryId),/^[1-9]\d*$/); assert.match(String(number),/^[1-9]\d*$/);
  assert.ok(typeof app==='string' && app.length && app.length<256);
  const prefix=`ofpr-${repositoryId}-${number}-`;
  const suffix=createHash('sha256').update(app).digest('hex').slice(0,12);
  assert.ok(prefix.length+suffix.length<=63);
  return {prefix,name:`${prefix}${suffix}`};
}
export function validateBundle(bundle,expected) {
  assert.equal(bundle.schema,1); assert.deepEqual(bundle.source,expected,'Preview source provenance mismatch');
  assert.equal(bundle.manifest?.mode,'demo','Only demo packages may be previewed');
  assert.ok(Array.isArray(bundle.manifest.capabilities) && bundle.manifest.capabilities.length===0,'Preview has capabilities');
  assert.ok(!bundle.manifest.database && !bundle.manifest.storage,'Preview cannot bind installed data');
  const artifact=bundle.artifact;
  assert.ok(artifact && typeof artifact.modules==='object' && typeof artifact.assets==='object');
  const path=value=>{
    assert.ok(typeof value==='string' && value.length>0 && value.length<240);
    assert.ok(!value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(p=>p && p!=='.' && p!=='..'),'Unsafe artifact path');
  };
  path(artifact.mainModule);assert.ok(Object.hasOwn(artifact.modules,artifact.mainModule));
  assert.match(artifact.compatibilityDate || '',/^\d{4}-\d{2}-\d{2}$/);
  assert.ok((artifact.compatibilityFlags || []).every(flag=>['nodejs_compat','nodejs_als'].includes(flag)),'Unsupported compatibility flag');
  let bytes=0;
  assert.ok(Object.keys(artifact.modules).length+Object.keys(artifact.assets).length<=4000,'Too many preview files');
  for(const [name,source] of Object.entries(artifact.modules)) {
    path(name);assert.match(name,/\.(mjs|js)$/);assert.equal(typeof source,'string');bytes+=Buffer.byteLength(source);
  }
  for(const [name,value] of Object.entries(artifact.assets)) {
    assert.ok(name.startsWith('/'));path(name.slice(1));
    assert.equal(typeof value.content,'string');assert.ok(value.content.length<=Math.ceil(maxAssetBytes/3)*4);
    assert.ok(value.encoding===undefined || value.encoding==='gzip');
    const data=Buffer.from(value.content,'base64');
    const size=(value.encoding==='gzip'?gunzipSync(data,{maxOutputLength:maxAssetBytes}):data).length;
    assert.ok(size<=maxAssetBytes,'Preview asset exceeds size limit');bytes+=size;
  }
  assert.ok(bytes<=100*1024*1024,'Preview artifact exceeds size limit');
  return bundle;
}
export function previewWorker(main,source) {
  return `import app from ${JSON.stringify(`./app/${main}`)};
const source=${JSON.stringify(source)};
export default {async fetch(request,env,context){
 const url=new URL(request.url);
 if(!['GET','HEAD'].includes(request.method)) return new Response('Read-only app preview',{status:405,headers:{Allow:'GET, HEAD'}});
 if(url.pathname==='/api/health') return Response.json({status:'ok',mode:'demo',...source});
 if(url.pathname.startsWith('/api/')) return new Response('No platform API in this preview',{status:404});
 const headers=new Headers(request.headers);headers.delete('cookie');headers.delete('authorization');
 for(const key of [...headers.keys()]) if(key.startsWith('x-outfitter-') || key.startsWith('x-user-')) headers.delete(key);
 const response=url.pathname.startsWith('/_astro/')?await env.ASSETS.fetch(new Request(request,{headers})):await app.fetch(new Request(request,{headers}),{ASSETS:env.ASSETS},context);
 const result=new Response(response.body,response);result.headers.delete('Set-Cookie');
 result.headers.set('Cache-Control','no-store');result.headers.set('X-Outfitter-Preview-SHA',source.sha);result.headers.set('X-Robots-Tag','noindex, nofollow');return result;
}};`;
}
export function buildPreview(app,env=process.env) {
  const config=loadConfig(), selected=checkApp(app,process.cwd(),config);
  const sha=env.SOURCE_SHA || env.GITHUB_SHA;
  assert.match(sha || '',shaPattern);assert.match(env.SOURCE_REPOSITORY || env.GITHUB_REPOSITORY || '',/^[\w.-]+\/[\w.-]+$/);
  const source={repository:env.SOURCE_REPOSITORY || env.GITHUB_REPOSITORY,sha,app};
  let packagePath;
  if(env.PREVIEW_BUILD_MODE==='toolchain') {
    assert.ok(env.GITHUB_EVENT_NAME==='workflow_dispatch' || (env.GITHUB_EVENT_NAME==='pull_request' && env.PRIVATE_PREVIEW_AUTHORIZED==='true'),'Private SDK build was not authorized by the trusted preview planner');
    const toolchain=resolve(env.TOOLCHAIN_PATH || '');assert.ok(existsSync(join(toolchain,'scripts/build-app-repository.mjs')),'Missing private toolchain');
    const slug=selected.manifest?.catalog?.demo?.slug || app.split('/').at(-1);
    assert.match(slug,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const temporary=mkdtempSync(join(tmpdir(),'outfitter-preview-source-'));
    try {
      const archive=join(temporary,'source.tar.gz');
      run('git',['archive','--format=tar.gz','--prefix=source/',`--output=${archive}`,sha]);
      run(process.execPath,['scripts/build-app-repository.mjs',archive,slug],toolchain);
      run(process.execPath,['--import','tsx','scripts/build-apps.mjs',slug,'--mode','demo'],toolchain);
      packagePath=join(toolchain,`src/generated/apps/${slug}.demo.json`);
    } finally {rmSync(temporary,{recursive:true,force:true});}
  } else {
    assert.ok(existsSync('package-lock.json'),'Preview builds require a root npm lockfile');
    assert.ok(selected.pkg.scripts?.['preview:build'],'App must declare preview:build');
    run('npm',['ci']);
    for(const command of (config.preview?.commands ?? config.commands.filter(c=>c!=='build'))) run('npm',['run',command],resolve(app));
    run('npm',['run','preview:build'],resolve(app));
    const output=config.preview?.output || 'dist/preview.json';
    assert.ok(!output.startsWith('/') && !output.split('/').includes('..'));
    packagePath=resolve(app,output);
  }
  const bundle=validateBundle({...read(packagePath),schema:1,source},source);
  mkdirSync('.outfitter-preview',{recursive:true});writeFileSync('.outfitter-preview/bundle.json',JSON.stringify(bundle));
  console.log(`Built read-only preview: ${app} at ${sha}`);
  return bundle;
}
async function cloudflare(path,options={},env=process.env) {
  assert.match(env.CLOUDFLARE_ACCOUNT_ID || '',/^[a-f0-9]{32}$/);assert.ok(env.CLOUDFLARE_API_TOKEN,'Missing preview publication credential');
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/${path}`,{
    ...options,headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,...options.headers},signal:AbortSignal.timeout(60_000)});
  const json=await response.json();assert.ok(response.ok && json.success,`Preview provider request failed (${response.status})`);return json.result;
}
export async function publishPreview(env=process.env) {
  const source={repository:env.SOURCE_REPOSITORY || env.GITHUB_REPOSITORY,sha:env.SOURCE_SHA,app:env.APP};
  assert.match(source.sha || '',shaPattern);
  const bundle=validateBundle(read(env.PREVIEW_BUNDLE || '.outfitter-preview/bundle.json'),source);
  const {name}=previewIdentity(env.GITHUB_REPOSITORY_ID,env.PR_NUMBER,source.app);
  const subdomain=(await cloudflare('workers/subdomain',{},env)).subdomain;
  assert.match(subdomain,/^[a-z0-9-]+$/);
  const url=`https://${name}.${subdomain}.workers.dev`;
  const temporary=mkdtempSync(join(tmpdir(),'outfitter-preview-publish-'));
  try {
    const put=(path,content)=>{const dest=join(temporary,path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,content);};
    for(const [path,source] of Object.entries(bundle.artifact.modules)) put(`app/${path}`,source);
    for(const [path,value] of Object.entries(bundle.artifact.assets)) {
      const bytes=Buffer.from(value.content,'base64');put(`assets/${path.slice(1)}`,value.encoding==='gzip'?gunzipSync(bytes,{maxOutputLength:maxAssetBytes}):bytes);
    }
    mkdirSync(join(temporary,'assets'),{recursive:true});
    put('entry.mjs',previewWorker(bundle.artifact.mainModule,source));
    put('wrangler.json',JSON.stringify({name,account_id:env.CLOUDFLARE_ACCOUNT_ID,main:'entry.mjs',
      compatibility_date:bundle.artifact.compatibilityDate,compatibility_flags:bundle.artifact.compatibilityFlags || [],
      workers_dev:true,preview_urls:false,assets:{directory:'./assets',binding:'ASSETS',run_worker_first:true},
      rules:[{type:'ESModule',globs:['**/*.mjs','**/*.js'],fallthrough:true}]}));
    // A pinned provider CLI, outside the source checkout. No bundling or execution
    // of source code, caller configuration, package hooks, or operational bindings.
    run('npm',['exec','--yes','--package=wrangler@4.143.0','--','wrangler','deploy','--no-bundle','--config',join(temporary,'wrangler.json')],temporary);
    let healthy=false;
    for(let attempt=0;attempt<30;attempt++) {
      const health=await fetch(`${url}/api/health`,{signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():null).catch(()=>null);
      if(health?.sha===source.sha && health?.app===source.app && health?.repository===source.repository && health?.mode==='demo'){healthy=true;break;}
      await new Promise(r=>setTimeout(r,2000));
    }
    assert.ok(healthy,'Preview does not serve the requested source revision');
    if(env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT,`url=${url}\n`);
    if(env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,`Read-only app preview: [${source.app}](${url})\n\nSource: ${source.repository}@${source.sha}\n`);
    console.log(`Verified preview: ${url} (${source.sha})`);return url;
  } finally {rmSync(temporary,{recursive:true,force:true});}
}
export async function cleanupPreviews(env=process.env) {
  const {prefix}=previewIdentity(env.GITHUB_REPOSITORY_ID,env.PR_NUMBER,'cleanup');
  const scripts=await cloudflare('workers/scripts',{},env);
  for(const {id} of scripts.filter(s=>s.id.startsWith(prefix) && /^[a-f0-9]{12}$/.test(s.id.slice(prefix.length)))) {
    await cloudflare(`workers/scripts/${encodeURIComponent(id)}`,{method:'DELETE'},env);console.log(`Removed preview: ${id}`);
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [command,app]=process.argv.slice(2);
  if(command==='plan') await planPreview();
  else if(command==='build') buildPreview(app);
  else if(command==='publish') await publishPreview();
  else if(command==='cleanup') await cleanupPreviews();
  else throw Error('Usage: preview.mjs build APP|publish|cleanup');
}
