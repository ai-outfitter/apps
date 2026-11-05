import assert from 'node:assert/strict';
import test from 'node:test';
import {previewIdentity,validateBundle,previewWorker} from '../preview.mjs';
const source={repository:'owner/apps',sha:'a'.repeat(40),app:'apps/hello'};
const bundle=()=>({schema:1,source,manifest:{mode:'demo',capabilities:[]},artifact:{mainModule:'entry.mjs',compatibilityDate:'2026-09-29',modules:{'entry.mjs':'export default {}'},assets:{}}});
test('preview names isolate repository, PR and app without path/slug collisions',()=>{
 const a=previewIdentity('123',4,'apps/hello');assert.match(a.name,/^ofpr-123-4-[a-f0-9]{12}$/);
 assert.notEqual(a.name,previewIdentity('124',4,'apps/hello').name);assert.notEqual(a.name,previewIdentity('123',5,'apps/hello').name);
 assert.notEqual(a.name,previewIdentity('123',4,'apps-hello').name);assert.throws(()=>previewIdentity('../123',4,'hello'));
});
test('publisher rejects provenance drift, operational bindings, capability grants and traversal',()=>{
 validateBundle(bundle(),source);
 for(const mutate of [b=>{b.source={...source,sha:'b'.repeat(40)}},b=>{b.manifest.mode='operational'},b=>{b.manifest.capabilities=['database']},b=>{b.manifest.database={}},b=>{b.artifact.modules['../outside.mjs']='x'},b=>{b.artifact.assets['/../../secret']={content:''}},b=>{b.artifact.compatibilityFlags=['unsafe_eval']},b=>{b.artifact.mainModule='missing.mjs'}]) {
  const b=bundle();mutate(b);assert.throws(()=>validateBundle(b,source));
 }
});
test('preview worker serves exact provenance and denies writes/platform API while stripping identity',async()=>{
 const code=previewWorker('entry.mjs',source).replace(/^import app[^\n]*\n/,'const app={fetch:(request,env)=>Response.json({cookie:request.headers.get("cookie"),auth:request.headers.get("authorization"),keys:Object.keys(env)})};\n');
 const worker=(await import('data:text/javascript,'+encodeURIComponent(code))).default;
 const health=await worker.fetch(new Request('https://preview/api/health'),{},{});assert.equal((await health.json()).sha,source.sha);
 assert.equal((await worker.fetch(new Request('https://preview/',{method:'POST'}),{},{})).status,405);
 assert.equal((await worker.fetch(new Request('https://preview/api/customer'),{},{})).status,404);
 const response=await worker.fetch(new Request('https://preview/',{headers:{Cookie:'private',Authorization:'secret'}}),{DB:'customer',TOKEN:'secret',ASSETS:{}},{});
 assert.deepEqual(await response.json(),{cookie:null,auth:null,keys:['ASSETS']});assert.equal(response.headers.get('X-Outfitter-Preview-SHA'),source.sha);
});
