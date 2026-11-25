import {verifyArchive} from './lib/sdk-archives.mjs';
import {readdirSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
// Run after workflow builds so generated definition exports must also be present.
for(const directory of readdirSync('packages')) {
 const path=join('packages',directory);
 const pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
 const [archive]=JSON.parse(execFileSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{cwd:path,encoding:'utf8',stdio:['ignore','pipe','inherit']}));
 verifyArchive(pkg,archive);
 console.log(`${pkg.name}: archive exports verified`);
}
