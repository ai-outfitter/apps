// Publish verified app packages built without release credentials.
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
/** The commit the release is built from: the checked-out tag when recovering, else the pushed commit. */
const sourceCommit=(env)=>env.SOURCE_COMMIT || env.GITHUB_SHA;
export function prepare(path, output, env=process.env) {
  const name=component(path);
  assert.match(sourceCommit(env) || '',/^[a-f0-9]{40}$/,'Source commit required');
  assert.equal(env.GITHUB_REPOSITORY,'ai-outfitter/apps','Unexpected release repository');
  const pkg=json(join(path,'package.json')), appBytes=readFileSync(join(path,'app.json'));
  const app=JSON.parse(appBytes);
  assert.equal(pkg.version,app.version,'App version mismatch');
  const modes=Object.keys(app.modes || {demo:{}});
  assert.ok(modes.length && modes.every(mode=>['demo','operational'].includes(mode)),'Invalid package modes');
  const hashes={};
  mkdirSync(output,{recursive:true});
  writeFileSync(join(output,`${name}.app.json`),appBytes);
  for (const mode of modes) {
    const bytes=readFileSync(join(path,`.outfitter/packages/${mode}.json`)), built=JSON.parse(bytes);
    assert.equal(built.manifest.id,app.id,'Package identity mismatch');
    assert.equal(built.manifest.version,app.version,'Package version mismatch');
    assert.equal(built.manifest.mode,mode,'Package mode mismatch');
    if(mode==='demo') assert.deepEqual(built.manifest.capabilities,[],'Demo package must not have capabilities');
    assert.ok(built.artifact.modules[built.artifact.mainModule] && Object.keys(built.artifact.assets).length,'Incomplete package');
    hashes[mode]=digest(bytes);
    writeFileSync(join(output,`${name}.${mode}.json`),bytes);
  }
  const proof={schema:2,sourceRepository:env.GITHUB_REPOSITORY,sourceCommit:sourceCommit(env),appPath:path,version:app.version,appSha256:digest(appBytes),packages:hashes};
  writeFileSync(join(output,`${name}.provenance.json`),JSON.stringify(proof,null,2)+'\n');
}
export function publish(path,input,env=process.env,execute=execFileSync) {
  const name=component(path), appBytes=readFileSync(join(input,`${name}.app.json`));
  const proof=json(join(input,`${name}.provenance.json`));
  assert.equal(proof.schema,2);
  assert.equal(proof.sourceRepository,'ai-outfitter/apps');
  assert.equal(proof.sourceCommit,sourceCommit(env),'Release artifacts do not match this workflow');
  assert.equal(proof.appPath,path);assert.equal(proof.appSha256,digest(appBytes));
  const app=JSON.parse(appBytes), modes=Object.keys(app.modes || {demo:{}});
  assert.ok(modes.length && modes.every(mode=>['demo','operational'].includes(mode)));
  assert.deepEqual(Object.keys(proof.packages).sort(),modes.sort());
  assert.equal(app.version,proof.version);
  for (const mode of modes) {
    const bytes=readFileSync(join(input,`${name}.${mode}.json`)), pack=JSON.parse(bytes);
    assert.equal(proof.packages[mode],digest(bytes));
    assert.equal(pack.manifest.version,app.version);assert.equal(pack.manifest.id,app.id);assert.equal(pack.manifest.mode,mode);
    if(mode==='demo') assert.deepEqual(pack.manifest.capabilities,[]);
  }
  const tag=`${name}-v${app.version}`, repo=proof.sourceRepository;
  const ref=JSON.parse(execute('gh',['api',`repos/${repo}/commits/${tag}`,'--jq','{sha:.sha}'],{encoding:'utf8'}));
  assert.equal(ref.sha,proof.sourceCommit,'Release tag is not the validated source commit');
  const release=JSON.parse(execute('gh',['release','view',tag,'--repo',repo,'--json','assets'],{encoding:'utf8'}));
  for(const filename of [`${name}.app.json`,...modes.map(mode=>`${name}.${mode}.json`),`${name}.provenance.json`]) {
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
