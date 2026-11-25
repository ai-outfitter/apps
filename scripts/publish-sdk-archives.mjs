import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {packArchive, verifyArchive} from './lib/sdk-archives.mjs';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const config = readJson('release-please-config.json');
const paths = JSON.parse(process.env.RELEASE_PATHS || '[]');
const releaseOutputs = JSON.parse(process.env.RELEASE_OUTPUTS || '{}');
const recoveryTags = JSON.parse(process.env.RECOVERY_TAGS || '{}');
const {GH_TOKEN, GITHUB_TOKEN, ...buildEnv} = process.env;
const releases = new Map();
const destination = mkdtempSync(join(tmpdir(), 'outfitter-sdk-release-'));

try {
  for (const path of paths) {
    assert.ok(Object.hasOwn(config.packages, path) && /^packages\/[a-z0-9-]+$/.test(path));
    const current = readJson(join(path, 'package.json'));
    const prefix = `${config.packages[path].component}-v`;
    const tag = releaseOutputs[`${path}--tag_name`] ?? recoveryTags[path] ?? `${prefix}${current.version}`;
    assert.ok(typeof tag === 'string' && tag.startsWith(prefix), `Invalid release tag for ${path}`);
    const version = tag.slice(prefix.length);
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    const name = current.name;
    const repository = process.env.GITHUB_REPOSITORY;
    assert.ok(repository, 'Missing release repository');
    const {assets} = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--repo', repository, '--json', 'assets'], {encoding: 'utf8'}));
    const filename = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
    if (assets.some(asset => asset.name === filename)) {
      console.log(`${tag}: archive already published`);
      continue;
    }

    // The tag supplies the package, its graph snapshots and its lockfile.
    const commit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], {encoding: 'utf8'}).trim();
    const releaseSha = releaseOutputs[`${path}--sha`];
    if (releaseSha) assert.equal(commit, releaseSha, `${tag}: release SHA differs from tag`);
    if (!releases.has(commit)) {
      const checkout = join(destination, commit);
      execFileSync('git', ['worktree', 'add', '--quiet', '--detach', checkout, commit], {stdio: 'inherit'});
      releases.set(commit, checkout);
      execFileSync('npm', ['ci'], {cwd: checkout, env: buildEnv, stdio: 'inherit'});
    }
    const packagePath = join(releases.get(commit), path);
    const pkg = readJson(join(packagePath, 'package.json'));
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, version);
    const packed = packArchive(packagePath, destination, buildEnv);
    verifyArchive(pkg, packed);
    assert.equal(packed.filename, filename);
    execFileSync('gh', ['release', 'upload', tag, join(destination, filename), '--repo', repository], {stdio: 'inherit'});
  }
} finally {
  for (const checkout of releases.values())
    execFileSync('git', ['worktree', 'remove', '--force', checkout], {stdio: 'inherit'});
  rmSync(destination, {recursive: true, force: true});
}
