// Shared build contract for an Outfitter installation's isolated source workspace.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,writeFileSync,lstatSync} from 'node:fs';
import {resolve,dirname,basename,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverApps,loadConfig,checkApp} from './apps.mjs';
export function repositoryMetadata(directory, manifest) {
  const paths = ['graph/schema.graphql', 'graph/documents.json', 'graph/wiki-views.json'];
  if (manifest.catalog?.cover) paths.push(manifest.catalog.cover);
  let total = 0;
  const files = [];
  for (const path of new Set(paths)) {
    assert.ok(typeof path === 'string' && /^[\w./-]+$/.test(path) && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe metadata path');
    let current = directory;
    for (const part of path.split('/')) {
      current = join(current, part);
      if (existsSync(current)) assert.ok(!lstatSync(current).isSymbolicLink(), 'Metadata symlinks are not allowed');
    }
    if (!existsSync(current)) {
      assert.notEqual(path, manifest.catalog?.cover, 'Declared catalog cover is missing');
      continue;
    }
    const stat = lstatSync(current);
    assert.ok(stat.isFile() && stat.size <= 5 * 1024 * 1024, 'Metadata must be a bounded regular file');
    const bytes = readFileSync(current);
    total += bytes.length;
    assert.ok(total <= 10 * 1024 * 1024, 'Metadata exceeds size limit');
    const contentType = {'.graphql': 'application/graphql', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml'}[extname(path)];
    assert.ok(contentType, 'Unsupported metadata content type');
    files.push({path, contentType, base64: bytes.toString('base64')});
  }
  return {schema: 1, manifest, files};
}

export function buildRepository(source,slug,output,{mode='operational',metadataOutput,run=(args,cwd)=>execFileSync('npm',args,{cwd,stdio:'inherit'})}={}) {
  assert.ok(['demo', 'operational'].includes(mode), 'Invalid build mode');
  source=resolve(source);
  const config=loadConfig(source);
  const matches=discoverApps(source,config).filter(app=>(app.manifest?.slug || app.manifest?.catalog?.operational?.slug || app.manifest?.catalog?.demo?.slug || basename(app.slug))===slug);
  assert.equal(matches.length,1,'Expected exactly one selected app');
  const selected=matches[0];
  checkApp(selected.slug,source,config);
  assert.ok(existsSync(join(source,'package-lock.json')),'Repository builds require a committed npm lockfile');
  const directory=resolve(source,selected.slug);
  const metadata = repositoryMetadata(directory, selected.manifest);
  if (selected.manifest?.modes) assert.ok(Object.hasOwn(selected.manifest.modes, mode), 'App does not support this mode');
  const commands=['check',...(selected.pkg.scripts?.test ? ['test'] : []),'build'];
  if(existsSync(join(directory,'tests'))) assert.ok(selected.pkg.scripts?.test,'App tests require a test script');
  for(const command of commands) assert.ok(selected.pkg.scripts?.[command],`Missing ${command}`);
  run(['ci'],source);
  if (selected.pkg.outfitter?.browserTests) run(['exec','--','playwright','install','chromium'], source);
  for(const command of commands) run(['run',command],directory);
  const bytes=readFileSync(join(directory,`.outfitter/packages/${mode}.json`));
  const built=JSON.parse(bytes);
  assert.equal(built.manifest?.mode,mode,'Build did not produce the requested package mode');
  if (selected.manifest.id) assert.equal(built.manifest.id, selected.manifest.id, 'Built app identity differs from source');
  if (selected.manifest.version) assert.equal(built.manifest.version, selected.manifest.version, 'Built app version differs from source');
  assert.ok(built.artifact?.modules && built.artifact?.assets,'Missing build artifact');
  mkdirSync(dirname(resolve(output)),{recursive:true});
  writeFileSync(output,bytes);
  if (metadataOutput) {
    mkdirSync(dirname(resolve(metadataOutput)), {recursive:true});
    writeFileSync(metadataOutput, JSON.stringify(metadata));
  }
  return selected;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [source,slug,output,...flags]=process.argv.slice(2);
  assert.ok(source && slug && output,'Usage: repository-build.mjs SOURCE APP_SLUG OUTPUT [--mode demo|operational] [--metadata-output FILE]');
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    assert.ok(['--mode', '--metadata-output'].includes(flags[i]) && flags[i + 1] && !flags[i + 1].startsWith('--'), 'Invalid build option');
    const key = flags[i] === '--mode' ? 'mode' : 'metadataOutput';
    assert.ok(!Object.hasOwn(options, key), 'Duplicate build option');
    options[key] = flags[i + 1];
  }
  buildRepository(source,slug,output,options);
}
