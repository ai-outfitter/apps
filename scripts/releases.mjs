import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkApp, loadConfig} from './apps.mjs';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function releaseEvents(outputs, {root = process.cwd(), config = loadConfig(root)} = {}) {
  const paths = JSON.parse(outputs.paths_released || '[]');
  assert.ok(Array.isArray(paths) && paths.every(path => typeof path === 'string'), 'Invalid released paths');
  return paths.map(path => {
    const selected = checkApp(path, root, config);
    const app = selected.manifest?.slug || selected.manifest?.catalog?.operational?.slug || selected.manifest?.catalog?.demo?.slug || path.split('/').at(-1);
    assert.match(app, slugPattern, 'Invalid app slug');
    const prefix = path === '.' ? '' : `${path}--`;
    const tag = outputs[`${prefix}tag_name`];
    const commit = outputs[`${prefix}sha`];
    assert.ok(typeof tag === 'string' && tag.length > 0, `${path}: release-please did not return a tag`);
    assert.match(commit || '', /^[a-f0-9]{40}$/, `${path}: release-please did not return an immutable commit`);
    const targets = config.releaseTargets?.[path] ?? config.releaseTargets?.[app] ?? [];
    return validateRelease({app, tag, commit, targets});
  });
}

export function validateRelease(release) {
  assert.ok(release && typeof release === 'object', 'Expected release');
  assert.match(release.app || '', slugPattern, 'Invalid app slug');
  assert.ok(typeof release.tag === 'string' && /^[\w][\w./+-]{0,199}$/.test(release.tag) && !release.tag.includes('..'), 'Invalid release tag');
  assert.match(release.commit || '', /^[a-f0-9]{40}$/, 'Release must pin an immutable commit');
  const targets = release.targets ?? [];
  assert.ok(Array.isArray(targets) && targets.length <= 10, 'Invalid release targets');
  const seen = new Set();
  for (const target of targets) {
    assert.ok(target && typeof target === 'object' && Object.keys(target).every(key => ['target', 'repositoryId'].includes(key)), 'Invalid release target');
    assert.ok(typeof target.target === 'string' && ['personal', 'platform', 'org'].some(scope => target.target === `${scope}/${release.app}`), 'Target must name this app and an allowed scope');
    assert.ok(target.repositoryId === undefined || typeof target.repositoryId === 'string' && /^[\w-]{1,128}$/.test(target.repositoryId), 'Invalid repository binding');
    const key = JSON.stringify([target.target, target.repositoryId ?? null]);
    assert.ok(!seen.has(key), 'Duplicate release target');
    seen.add(key);
  }
  return {app: release.app, tag: release.tag, commit: release.commit, targets};
}

export async function notifyRelease(input, {env = process.env, fetcher = fetch} = {}) {
  const release = validateRelease(input);
  assert.ok(['push', 'release', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'Release notifications require a trusted release workflow');
  if (env.GITHUB_EVENT_NAME === 'push' || env.GITHUB_EVENT_NAME === 'workflow_dispatch')
    assert.equal(env.GITHUB_REF, `refs/heads/${env.DEPLOY_BRANCH || 'main'}`, 'Notify only from the configured branch');
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && env.ACTIONS_ID_TOKEN_REQUEST_URL, 'GitHub OIDC permission is required');
  const destination = new URL(env.OUTFITTER_URL || 'https://ai-outfitter.com');
  assert.ok(destination.protocol === 'https:' && !destination.username && !destination.password && destination.pathname === '/' && !destination.search && !destination.hash, 'Destination must be an HTTPS origin');
  const tokenUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  tokenUrl.searchParams.set('audience', destination.origin);
  const tokenResponse = await fetcher(tokenUrl, {
    headers: {Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(tokenResponse.ok, `OIDC request failed (${tokenResponse.status})`);
  const {value: token} = await tokenResponse.json();
  assert.ok(typeof token === 'string' && token.length > 0, 'OIDC token is absent');
  const response = await fetcher(new URL('/api/app-repositories/releases', destination).href, {
    method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(release), signal: AbortSignal.timeout(60_000),
  });
  assert.ok(response.ok, `Release notification failed (${response.status}); retry this release notification after correcting the failure`);
  const receipt = await response.json();
  assert.ok(typeof receipt.releaseId === 'string' && receipt.releaseId.length > 0, 'Missing release receipt');
  assert.equal(receipt.sourceCommit, release.commit, 'Receipt commit differs from the released source');
  assert.ok(Array.isArray(receipt.requests) && receipt.requests.every(request => typeof request.id === 'string' && typeof request.target === 'string' && typeof request.status === 'string'), 'Invalid update receipts');
  assert.equal(receipt.requests.length, release.targets.length, 'Missing update receipts');
  assert.deepEqual(receipt.requests.map(request => request.target).sort(), release.targets.map(target => target.target).sort(), 'Update receipt targets differ');
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'events') {
    let releases;
    if (process.env.RECOVERY_RELEASES) {
      assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Release recovery requires manual dispatch');
      const requested = JSON.parse(process.env.RECOVERY_RELEASES);
      assert.ok(Array.isArray(requested) && requested.length <= 100, 'Invalid recovery releases');
      releases = requested.map(validateRelease);
    } else releases = releaseEvents(JSON.parse(process.env.RELEASE_OUTPUTS || '{}'));
    const value = JSON.stringify(releases);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `releases=${value}\nhas_releases=${releases.length > 0}\n`);
    console.log(`${releases.length} app release notifications selected`);
  } else if (process.argv[2] === 'notify') {
    const release = validateRelease(JSON.parse(process.env.RELEASE || '{}'));
    const receipt = await notifyRelease(release);
    const summary = `${release.app} ${release.tag}: release ${receipt.releaseId} recorded; ${receipt.requests.length} update requests recorded for Outfitter's scheduled tick. This is not completed build or activation.\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `receipt=${JSON.stringify(receipt)}\n`);
  } else throw Error('Usage: releases.mjs events|notify');
}
