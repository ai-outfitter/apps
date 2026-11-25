import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
export function packArchive(path,destination,env=process.env) {
  // Lifecycle output is human-readable; never mix it with npm's JSON result.
  execFileSync('npm',['run','build','--if-present'],{cwd:path,env,stdio:'inherit'});
  return JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',destination],{cwd:path,env,encoding:'utf8'}))[0];
}

export function verifyArchive(pkg, archive) {
  const files = new Set(archive.files.map(file => file.path));
  for (const target of Object.values({...pkg.exports, ...pkg.bin})) {
    if (typeof target !== 'string' || target.includes('*')) continue;
    assert.ok(files.has(target.replace(/^\.\//, '')), `${pkg.name}: exported ${target} absent from archive`);
  }
  if (pkg.exports?.['./graph-graphql-typed']) {
    for (const path of ['graph/standard-env.d.ts', 'graph/standard-schema.graphql']) {
      assert.ok(files.has(path), `${pkg.name}: ${path} absent from archive`);
    }
  }
  assert.ok(files.has('LICENSE'), `${pkg.name}: license absent from archive`);
}
