// Publish a released app's verified demo package, built without release credentials.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path,'utf8'));
function component(path) {
  assert.match(path,/^apps\/[a-z0-9]+(?:-[a-z0-9]+)*$/,'Invalid app path');
  const config=json('.release-please-apps.json');
  assert.ok(Object.hasOwn(config.packages,path),'App is not a release component');
  const name=config.packages[path].component;
  assert.match(name,/^[a-z0-9]+(?:-[a-z0-9]+)*$/,'Invalid release component');
  return name;
}
export function prepare(path, output, env=process.env) {
  const name=component(path);
  assert.match(env.GITHUB_SHA || '',/^[a-f0-9]{40}$/,'Source commit required');
  assert.equal(env.GITHUB_REPOSITORY,'ai-outfitter/apps','Unexpected release repository');
  const pkg=json(join(path,'package.json')), appBytes=readFileSync(join(path,'app.json'));
  const app=JSON.parse(appBytes), packageBytes=readFileSync(join(path,'.outfitter/packages/demo.json'));
  const built=JSON.parse(packageBytes);
  assert.equal(pkg.version,app.version,'App version mismatch');
  assert.equal(built.manifest.id,app.id,'Package identity mismatch');
  assert.equal(built.manifest.version,app.version,'Package version mismatch');
  assert.equal(built.manifest.mode,'demo','Only demo artifacts can be published');
  assert.deepEqual(built.manifest.capabilities,[],'Demo package must not have capabilities');
  assert.ok(built.artifact.modules[built.artifact.mainModule] && Object.keys(built.artifact.assets).length,'Incomplete package');
  mkdirSync(output,{recursive:true});
  writeFileSync(join(output,`${name}.app.json`),appBytes);
  writeFileSync(join(output,`${name}.demo.json`),packageBytes);
  writeFileSync(join(output,`${name}.provenance.json`),JSON.stringify({schema:1,sourceRepository:env.GITHUB_REPOSITORY,sourceCommit:env.GITHUB_SHA,appPath:path,version:app.version,appSha256:digest(appBytes),packageSha256:digest(packageBytes)},null,2)+'\n');
}
export function publish(path,input,env=process.env,execute=execFileSync) {
  const name=component(path), appBytes=readFileSync(join(input,`${name}.app.json`));
  const packageBytes=readFileSync(join(input,`${name}.demo.json`));
  const proof=json(join(input,`${name}.provenance.json`));
  assert.equal(proof.sourceRepository,'ai-outfitter/apps');
  assert.equal(proof.sourceCommit,env.GITHUB_SHA,'Release artifacts do not match this workflow');
  assert.equal(proof.appPath,path);assert.equal(proof.appSha256,digest(appBytes));assert.equal(proof.packageSha256,digest(packageBytes));
  const app=JSON.parse(appBytes), pack=JSON.parse(packageBytes);
  assert.equal(app.version,proof.version);assert.equal(pack.manifest.version,app.version);assert.equal(pack.manifest.id,app.id);assert.equal(pack.manifest.mode,'demo');
  const tag=`${name}-v${app.version}`, repo=proof.sourceRepository;
  const ref=JSON.parse(execute('gh',['api',`repos/${repo}/commits/${tag}`,'--jq','{sha:.sha}'],{encoding:'utf8'}));
  assert.equal(ref.sha,proof.sourceCommit,'Release tag is not the validated source commit');
  const release=JSON.parse(execute('gh',['release','view',tag,'--repo',repo,'--json','assets'],{encoding:'utf8'}));
  for(const filename of [`${name}.app.json`,`${name}.demo.json`,`${name}.provenance.json`]) {
    const local=join(input,filename);
    if(release.assets.some(asset=>asset.name===filename)) {
      const temporary=mkdtempSync(join(tmpdir(),'outfitter-app-asset-'));
      try {
        execute('gh',['release','download',tag,'--repo',repo,'--pattern',filename,'--dir',temporary],{stdio:'inherit'});
        assert.equal(digest(readFileSync(join(temporary,filename))),digest(readFileSync(local)),`Existing ${filename} differs`);
      } finally {rmSync(temporary,{recursive:true,force:true});}
    } else execute('gh',['release','upload',tag,local,'--repo',repo],{stdio:'inherit'});
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [operation,path,directory]=process.argv.slice(2);
  assert.ok(path && directory,'Usage: official-app-artifact.mjs prepare|publish APP DIRECTORY');
  if(operation==='prepare') prepare(path,directory);
  else if(operation==='publish') publish(path,directory);
  else throw Error('Unknown operation');
}
