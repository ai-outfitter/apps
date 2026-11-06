import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildRepository,repositoryMetadata} from '../repository-build.mjs';
test('hosted repository builds use the locked public workspace and only selected app gates',()=>{
 const source=mkdtempSync(join(tmpdir(),'hosted-repo-'));
 const put=(path,value)=>{mkdirSync(join(source,path,'..'),{recursive:true});writeFileSync(join(source,path),JSON.stringify(value));};
 try {
  put('package.json',{private:true,workspaces:['apps/*']});put('package-lock.json',{});
  put('apps/example/package.json',{name:'@any/example',version:'0.1.0',scripts:{check:'check',test:'test',build:'build'}});
  put('apps/example/app.json',{version:'0.1.0',catalog:{operational:{slug:'selected-app'}}});
  put('apps/sibling/package.json',{name:'@any/sibling',version:'0.1.0'});
  const calls=[];const output=join(source,'built.json');
  const run=(args,cwd)=>{calls.push([args,cwd]);if(args[1]==='build') put('apps/example/.outfitter/packages/operational.json',{manifest:{version:'0.1.0',mode:'operational'},artifact:{modules:{},assets:{}}});};
  buildRepository(source,'selected-app',output,{run});
  assert.deepEqual(calls.map(([args])=>args),[['ci'],['run','check'],['run','test'],['run','build']]);
  assert.equal(calls[0][1],source);assert.ok(calls.slice(1).every(([,cwd])=>cwd===join(source,'apps/example')));
  assert.equal(JSON.parse(readFileSync(output,'utf8')).manifest.mode,'operational');
  assert.throws(()=>buildRepository(source,'absent',output,{run}),/exactly one/);
  assert.throws(()=>buildRepository(source,'selected-app',output,{run:()=>{throw Error('gate failed');}}),/gate failed/);
 } finally {rmSync(source,{recursive:true,force:true});}
});

test('hosted demo builds retain pinned source metadata before executing app scripts',()=>{
 const source=mkdtempSync(join(tmpdir(),'hosted-metadata-'));
 const put=(path,value)=>{mkdirSync(join(source,path,'..'),{recursive:true});writeFileSync(join(source,path),typeof value==='string'?value:JSON.stringify(value));};
 try {
  put('package.json',{workspaces:['apps/*']});put('package-lock.json',{});
  put('apps/example/package.json',{name:'example',version:'0.1.0',scripts:{check:'check',test:'test',build:'build'},outfitter:{browserTests:true}});
  const manifest={id:'outfitter/example',version:'0.1.0',modes:{demo:{}},catalog:{demo:{slug:'example'},cover:'catalog/cover.webp'}};
  put('apps/example/app.json',manifest);put('apps/example/graph/schema.graphql','type Query { hello: String }');
  put('apps/example/graph/documents.json',{queries:[]});put('apps/example/catalog/cover.webp','image-bytes');
  const calls=[];
  buildRepository(source,'example',join(source,'built.json'),{mode:'demo',metadataOutput:join(source,'metadata.json'),run:(args)=>{
   calls.push(args);
   if(args[1]==='build') {
    put('apps/example/graph/schema.graphql','tampered during build');
    put('apps/example/.outfitter/packages/demo.json',{manifest:{id:manifest.id,version:manifest.version,mode:'demo'},artifact:{modules:{},assets:{}}});
   }
  }});
  assert.deepEqual(calls,[['ci'],['exec','--','playwright','install','--with-deps','chromium'],['run','check'],['run','test'],['run','build']]);
  const metadata=JSON.parse(readFileSync(join(source,'metadata.json'),'utf8'));
  assert.deepEqual(metadata.manifest,manifest);
  assert.equal(metadata.schema,1);
  assert.equal(Buffer.from(metadata.files[0].base64,'base64').toString(),'type Query { hello: String }');
  assert.equal(metadata.files.find(file=>file.path==='catalog/cover.webp').contentType,'image/webp');
  assert.throws(()=>buildRepository(source,'example',join(source,'bad.json'),{mode:'operational',run:()=>{throw Error('must not run');}}),/does not support/);
 } finally {rmSync(source,{recursive:true,force:true});}
});

test('catalog metadata rejects missing covers, unsafe paths, symlinks and oversized files',()=>{
 const directory=mkdtempSync(join(tmpdir(),'metadata-security-'));
 try {
  assert.throws(()=>repositoryMetadata(directory,{catalog:{cover:'../secret.webp'}}),/Unsafe metadata path/);
  assert.throws(()=>repositoryMetadata(directory,{catalog:{cover:'cover.webp'}}),/missing/);
  writeFileSync(join(directory,'outside.webp'),'secret');mkdirSync(join(directory,'graph'));
  symlinkSync(join(directory,'outside.webp'),join(directory,'graph','documents.json'));
  assert.throws(()=>repositoryMetadata(directory,{}),/symlinks/);
  rmSync(join(directory,'graph','documents.json'));
  writeFileSync(join(directory,'graph','documents.json'),Buffer.alloc(5*1024*1024+1));
  assert.throws(()=>repositoryMetadata(directory,{}),/bounded regular file/);
 } finally {rmSync(directory,{recursive:true,force:true});}
});
