import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepare,publish} from '../official-app-artifact.mjs';

test('release artifact binds the validated demo to the source commit and rejects tampering',()=>{
 const root=mkdtempSync(join(tmpdir(),'official-release-')), original=process.cwd();
 try {
  process.chdir(root);
  mkdirSync('apps/hr/.outfitter/packages',{recursive:true});
  writeFileSync('.release-please-apps.json',JSON.stringify({packages:{'apps/hr':{component:'hr'}}}));
  writeFileSync('apps/hr/package.json',JSON.stringify({version:'0.1.1'}));
  writeFileSync('apps/hr/app.json',JSON.stringify({id:'outfitter/hr',version:'0.1.1'}));
  writeFileSync('apps/hr/.outfitter/packages/demo.json',JSON.stringify({manifest:{id:'outfitter/hr',version:'0.1.1',mode:'demo',capabilities:[]},artifact:{mainModule:'entry.mjs',modules:{'entry.mjs':'export default {}'},assets:{'/a.css':{content:'eA=='}}}}));
  const env={GITHUB_SHA:'a'.repeat(40),GITHUB_REPOSITORY:'ai-outfitter/apps'};
  prepare('apps/hr','release',env);
  const proof=JSON.parse(readFileSync('release/hr.provenance.json','utf8'));
  assert.equal(proof.sourceCommit,env.GITHUB_SHA);assert.match(proof.packageSha256,/^[a-f0-9]{64}$/);
  const calls=[];
  const execute=(program,args)=>{calls.push([program,...args]);if(args[0]==='api')return JSON.stringify({sha:env.GITHUB_SHA});if(args[0]==='release' && args[1]==='view')return JSON.stringify({assets:[]});return '';};
  publish('apps/hr','release',env,execute);
  assert.equal(calls.filter(call=>call[1]==='release' && call[2]==='upload').length,3);
  writeFileSync('release/hr.demo.json','{}');
  assert.throws(()=>publish('apps/hr','release',env,execute),/strictly equal/);
  assert.throws(()=>prepare('../hr','release',env),/Invalid app path/);
 } finally {process.chdir(original);rmSync(root,{recursive:true,force:true});}
});
