import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
// Run after workflow builds so generated definition exports must also be present.
for(const directory of readdirSync('packages')) {
 const path=join('packages',directory);
 const pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
 const [archive]=JSON.parse(execFileSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{cwd:path,encoding:'utf8',stdio:['ignore','pipe','inherit']}));
 const files=new Set(archive.files.map(f=>f.path));
 for(const target of Object.values({...pkg.exports,...pkg.bin})) {
  if(typeof target!=='string' || target.includes('*')) continue;
  assert.ok(files.has(target.replace(/^\.\//,'')),`${pkg.name}: exported ${target} absent from archive`);
 }
 assert.ok(files.has('LICENSE'),`${pkg.name}: license absent from archive`);
 console.log(`${pkg.name}: archive exports verified`);
}
