import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
const read = (root, path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const deps = pkg => Object.keys({...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies});
export function loadConfig(root = process.cwd(), path = process.env.CONFIG_PATH || '.outfitter/apps.json') {
  const config = existsSync(resolve(root, path)) ? read(root, path) : {};
  if (config.releaseManifest !== undefined) assert.ok(typeof config.releaseManifest === 'string' && /^[\w./-]+$/.test(config.releaseManifest) && !config.releaseManifest.split('/').includes('..') && !config.releaseManifest.startsWith('/'), 'Invalid releaseManifest');
  if (config.sdkSha !== undefined) assert.match(config.sdkSha, /^[a-f0-9]{40}$/, 'sdkSha must pin a public SDK commit');
  for (const key of ['appGlobs','sharedInputs','commands'])
    if (config[key] !== undefined) assert.ok(Array.isArray(config[key]) && config[key].every(x => typeof x === 'string' && x.length), `Invalid ${key}`);
  for (const command of config.commands || []) assert.match(command, /^[\w:.-]+$/, 'Commands must name package scripts');
  if (config.preview?.commands !== undefined) {
    assert.ok(Array.isArray(config.preview.commands) && config.preview.commands.every(command => typeof command === 'string' && /^[\w:.-]+$/.test(command)), 'Invalid preview commands');
    assert.ok(config.preview.commands.every(command => (config.commands || ['check','test','build']).includes(command) && command !== 'build'), 'Preview commands must be validation commands');
  }
  assert.ok(['metadata','scripts'].includes(config.validation || 'metadata'), 'Invalid validation');
  return {appGlobs:['*'], sharedInputs:[], commands:['check','test','build'], validation:'metadata', ...config};
}
export function discoverApps(root = process.cwd(), config = loadConfig(root)) {
  const pkg = existsSync(resolve(root, 'package.json')) ? read(root, 'package.json') : {};
  const workspaceGlobs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages || [];
  const packages = [];
  function walk(directory = '') {
    for (const entry of readdirSync(resolve(root, directory), {withFileTypes:true})) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ['node_modules','dist','build','coverage'].includes(entry.name)) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (existsSync(resolve(root,path,'package.json'))) {
        const pkg = read(root,`${path}/package.json`);
        const hasManifest = existsSync(resolve(root,path,'app.json'));
        packages.push({slug:path, pkg, manifest:hasManifest ? read(root,`${path}/app.json`) : undefined,
          app: (hasManifest || pkg.outfitter?.kind === 'app') && [...config.appGlobs,...workspaceGlobs].some(glob => matchesGlob(path,glob))});
      }
      walk(path);
    }
  }
  walk();
  const names = new Set();
  for (const {pkg,slug} of packages) {
    assert.ok(pkg.name, `${slug}: missing package name`);
    assert.ok(!names.has(pkg.name), `Duplicate package name: ${pkg.name}`);names.add(pkg.name);
  }
  const apps = packages.filter(p=>p.app).sort((a,b)=>a.slug.localeCompare(b.slug));
  // Keep non-app workspaces and owned workflows in the graph for transitive selection.
  Object.defineProperty(apps,'packages',{value:packages});
  return apps;
}
export function affectedApps(apps, paths, config = {sharedInputs:[]}) {
  if (paths === null) return apps.map(a=>a.slug);
  const packages = apps.packages || apps;
  const affected = new Set();
  for (const path of paths) {
    if ((config.sharedInputs || []).some(glob=>matchesGlob(path,glob))) {
      packages.forEach(p=>affected.add(p.pkg.name));continue;
    }
    const owners = packages.filter(p=>path.startsWith(`${p.slug}/`));
    if (owners.length) owners.forEach(p=>affected.add(p.pkg.name));
    else if (!/^(README\.md|AGENTS\.md|LICENSE(?:\.[^/]*)?)$|^docs\//.test(path)) packages.forEach(p=>affected.add(p.pkg.name));
  }
  let changed;
  do {
    changed = false;
    for (const p of packages) if (!affected.has(p.pkg.name) && deps(p.pkg).some(name=>affected.has(name))) {
      affected.add(p.pkg.name);changed=true;
    }
  } while(changed);
  return apps.filter(p=>affected.has(p.pkg.name)).map(a=>a.slug);
}
export function changedFiles(root = process.cwd(), env = process.env) {
  const base=env.BASE_SHA, head=env.HEAD_SHA || 'HEAD';
  if (!base || /^0+$/.test(base) || !/^[a-f0-9]{40}$/.test(base) || !/^(HEAD|[a-f0-9]{40})$/.test(head)) return null;
  try {return execFileSync('git',['diff','--no-renames','--name-only','-z',base,head,'--'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean);} catch {return null;}
}
export function checkApp(slug, root = process.cwd(), config = loadConfig(root)) {
  const app=discoverApps(root,config).find(a=>a.slug===slug);
  assert.ok(app,`Unknown app: ${slug}`);
  const {pkg,manifest}=app;
  if (pkg.outfitter?.browserTests !== undefined) assert.equal(typeof pkg.outfitter.browserTests, 'boolean', `${slug}: browserTests must be boolean`);
  assert.match(pkg.version || '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, `${slug}: invalid version`);
  if (manifest?.version !== undefined) assert.equal(pkg.version,manifest.version,`${slug}: package/app versions differ`);
  for (const command of config.commands) assert.ok(pkg.scripts?.[command],`${slug}: missing ${command}`);
  const releaseFile=config.releaseManifest || '.release-please-manifest.json';
  const releasePath=resolve(root,releaseFile);
  if (existsSync(releasePath)) {
    const versions=read(root,releaseFile);
    if (versions[slug] !== undefined) assert.equal(pkg.version,versions[slug],`${slug}: release version differs`);
  }
  return app;
}
export function runApp(slug, root=process.cwd(), config=loadConfig(root), {execute=execFileSync, env=process.env}={}) {
  const app=checkApp(slug,root,config);
  assert.equal(config.validation,'scripts','Script execution must be enabled explicitly');
  assert.ok(existsSync(resolve(root,'package-lock.json')), 'Script validation requires a caller-owned package-lock.json');
  execute('npm',['ci'],{cwd:root,stdio:'inherit'});
  if (env.CI && app.pkg.outfitter?.browserTests) execute('npm',['exec','--','playwright','install','--with-deps','chromium'],{cwd:root,stdio:'inherit'});
  for (const command of config.commands) execute('npm',['run',command],{cwd:resolve(root,slug),stdio:'inherit'});
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [command,slug]=process.argv.slice(2), config=loadConfig(), apps=discoverApps(process.cwd(),config);
  assert.ok(apps.length,'No apps discovered');
  if (command==='plan') {
    const selected=affectedApps(apps,changedFiles(),config);
    const outputs={apps:JSON.stringify(selected),has_apps:String(selected.length>0),validation:config.validation,sdk_sha:config.sdkSha || ''};
    console.log(JSON.stringify(outputs));
    if(process.env.GITHUB_OUTPUT) for(const [k,v] of Object.entries(outputs)) appendFileSync(process.env.GITHUB_OUTPUT,`${k}=${v}\n`);
  } else if(command==='check' || command==='run') {
    for(const name of slug ? [slug] : apps.map(a=>a.slug)) {
      (command==='run'?runApp:checkApp)(name,process.cwd(),config);console.log(`Validated ${config.validation}: ${name}`);
    }
  } else throw Error('Usage: apps.mjs plan|check|run [APP_PATH]');
}
