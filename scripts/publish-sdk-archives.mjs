import assert from 'node:assert/strict';
import {packArchive} from './lib/sdk-archives.mjs';
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
  const tag=`${config.packages[path].component}-v${pkg.version}`;
  const repository=process.env.GITHUB_REPOSITORY;
  assert.ok(repository,'Missing release repository');
  const {assets}=JSON.parse(execFileSync('gh',['release','view',tag,'--repo',repository,'--json','assets'],{encoding:'utf8'}));
  const filename=`${pkg.name.replace(/^@/,'').replace('/','-')}-${pkg.version}.tgz`;
  if(assets.some(asset=>asset.name===filename)) {
    console.log(`${tag}: archive already published`);
    continue;
  }
  // Recovery must publish the released package source, never newer package edits.
  execFileSync('git',['diff','--exit-code',tag,'--',path],{stdio:'inherit'});
  const packed=packArchive(path,destination);
  execFileSync('gh',['release','upload',tag,join(destination,packed.filename),'--repo',repository],{stdio:'inherit'});
 } finally {rmSync(destination,{recursive:true,force:true});}
}
