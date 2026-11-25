import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {packArchive,verifyArchive} from '../lib/sdk-archives.mjs';
test('workflow build output cannot corrupt npm archive metadata',()=>{
 const root=mkdtempSync(join(tmpdir(),'sdk-pack-'));
 try {
  const destination=join(root,'archives');mkdirSync(destination);
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@example/workflow',version:'0.1.0',files:['dist'],scripts:{
   build:`node -e "console.log('@example/workflow: fixtures verified');require('node:fs').mkdirSync('dist');require('node:fs').writeFileSync('dist/workflow.json','{}')"`,
   prepack:'exit 93',
  }}));
  const packed=packArchive(root,destination);
  assert.equal(packed.filename,'example-workflow-0.1.0.tgz');
  assert.ok(packed.files.some(file=>file.path==='dist/workflow.json'));
  assert.ok(existsSync(join(destination,packed.filename)));
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('SDK archive validation requires the GraphQL SDL and introspection declaration',()=>{
 const pkg={name:'@ai-outfitter/app-sdk',exports:{'./graph-graphql-typed':'./src/graph-graphql-typed.ts','./graph/standard-types.json':'./graph/standard-types.json'}};
 const files=['LICENSE','src/graph-graphql-typed.ts','graph/standard-types.json','graph/standard-schema.graphql','graph/standard-env.d.ts'];
 const archive=paths=>({files:paths.map(path=>({path}))});
 verifyArchive(pkg,archive(files));
 for (const missing of files.slice(-2)) {
  assert.throws(()=>verifyArchive(pkg,archive(files.filter(path=>path!==missing))),{message:`${pkg.name}: ${missing} absent from archive`});
 }
});
