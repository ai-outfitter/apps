import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildRepository} from '../repository-build.mjs';
test('hosted repository builds use the locked public workspace and only selected app gates',()=>{
 const source=mkdtempSync(join(tmpdir(),'hosted-repo-'));
 const put=(path,value)=>{mkdirSync(join(source,path,'..'),{recursive:true});writeFileSync(join(source,path),JSON.stringify(value));};
 try {
  put('package.json',{private:true,workspaces:['apps/*']});put('package-lock.json',{});
  put('apps/example/package.json',{name:'@any/example',version:'0.1.0',scripts:{check:'check',test:'test',build:'build'}});
  put('apps/example/app.json',{version:'0.1.0',catalog:{operational:{slug:'selected-app'}}});
  put('apps/sibling/package.json',{name:'@any/sibling',version:'0.1.0'});
  const calls=[];const output=join(source,'built.json');
  const run=(args,cwd)=>{calls.push([args,cwd]);if(args[1]==='build') put('apps/example/.outfitter/packages/operational.json',{manifest:{mode:'operational'},artifact:{modules:{},assets:{}}});};
  buildRepository(source,'selected-app',output,{run});
  assert.deepEqual(calls.map(([args])=>args),[['ci'],['run','check'],['run','test'],['run','build']]);
  assert.equal(calls[0][1],source);assert.ok(calls.slice(1).every(([,cwd])=>cwd===join(source,'apps/example')));
  assert.equal(JSON.parse(readFileSync(output,'utf8')).manifest.mode,'operational');
  assert.throws(()=>buildRepository(source,'absent',output,{run}),/exactly one/);
  assert.throws(()=>buildRepository(source,'selected-app',output,{run:()=>{throw Error('gate failed');}}),/gate failed/);
 } finally {rmSync(source,{recursive:true,force:true});}
});
