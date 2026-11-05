import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const config=JSON.parse(readFileSync('release-please-config.json','utf8'));
const paths=JSON.parse(process.env.RELEASE_PATHS || '[]');
for(const path of paths) {
 assert.ok(Object.hasOwn(config.packages,path) && /^packages\/[a-z0-9-]+$/.test(path));
 const pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
 const destination=mkdtempSync(join(tmpdir(),'outfitter-sdk-release-'));
 try {
  const packed=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',destination],{cwd:path,encoding:'utf8'}));
  const tag=`${config.packages[path].component}-v${pkg.version}`;
  execFileSync('gh',['release','upload',tag,join(destination,packed[0].filename),'--repo',process.env.GITHUB_REPOSITORY],{stdio:'inherit'});
 } finally {rmSync(destination,{recursive:true,force:true});}
}
