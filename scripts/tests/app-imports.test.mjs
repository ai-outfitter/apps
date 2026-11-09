import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync,readFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Apps import packages only through their public entry points, never another
// app's or a package's source by path.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const skip=new Set(['node_modules','dist','test-results','.outfitter','.astro','.wrangler']);
const files=directory=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>skip.has(entry.name)?[]:
 entry.isDirectory()?files(join(directory,entry.name)):/\.(?:[cm]?[jt]sx?|astro)$/.test(entry.name)?[join(directory,entry.name)]:[]);
const specifiers=source=>[...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map(match=>match[1]);

test('apps import other apps and packages only through public entry points',()=>{
 const violations=[];
 for(const app of readdirSync(join(root,'apps'),{withFileTypes:true}).filter(entry=>entry.isDirectory())) {
  const appRoot=join(root,'apps',app.name);
  for(const file of files(appRoot)) for(const specifier of specifiers(readFileSync(file,'utf8'))) {
   const target=specifier.startsWith('.')?relative(root,resolve(dirname(file),specifier)):null;
   const escapes=target!==null&&(target.startsWith('packages/')||target.startsWith('apps/')&&!target.startsWith(`apps/${app.name}/`));
   if(escapes||/^@ai-outfitter\/[^/]+\/src(?:\/|$)/.test(specifier)) violations.push(`${relative(root,file)}: ${specifier}`);
  }
 }
 assert.deepEqual(violations,[]);
});
