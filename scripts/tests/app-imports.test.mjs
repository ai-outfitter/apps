import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Only tracked sources are checked, so local build output cannot change the result.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const files=execFileSync('git',['ls-files','-z','--','apps'],{cwd:root,encoding:'utf8'}).split('\0').filter(file=>/\.(?:[cm]?[jt]sx?|astro)$/.test(file));
const specifiers=source=>[...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map(match=>match[1]);

test('apps import other apps and packages only through public entry points',()=>{
 const violations=[];
 for(const file of files) {
  const app=file.split('/').slice(0,2).join('/')+'/';
  for(const specifier of specifiers(readFileSync(join(root,file),'utf8'))) {
   const target=specifier.startsWith('.')?relative(root,resolve(root,dirname(file),specifier)):null;
   const escapes=target!==null&&(target.startsWith('packages/')||target.startsWith('apps/')&&!target.startsWith(app));
   if(escapes||/^@ai-outfitter\/[^/]+\/src(?:\/|$)/.test(specifier)) violations.push(`${file}: ${specifier}`);
  }
 }
 assert.deepEqual(violations,[]);
});
