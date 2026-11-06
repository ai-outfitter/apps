import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {releaseEvents, validateRelease, notifyRelease} from '../releases.mjs';

const commit = 'a'.repeat(40);
const release = {app: 'example', tag: 'example-v1.2.3', commit, targets: [{target: 'personal/example'}]};
const env = {GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example.invalid/token?request=1'};
const json = (body, status = 200) => new Response(JSON.stringify(body), {status});
const receipt = {releaseId: 'release-id', sourceCommit: commit, requests: [{id: 'request-id', target: 'personal/example', status: 'pending'}]};

for (const path of ['example', 'apps/example']) test(`release-please outputs select ${path} without building or name assumptions`, () => {
  const root = mkdtempSync(join(tmpdir(), 'release-events-'));
  const put = (file, value) => {mkdirSync(join(root, file, '..'), {recursive: true}); writeFileSync(join(root, file), JSON.stringify(value));};
  try {
    put('package.json', {workspaces: ['apps/*']});
    put(`${path}/package.json`, {name: '@someone/any-name', version: '1.2.3', scripts: {check: 'check', test: 'test', build: 'build'}});
    put(`${path}/app.json`, {version: '1.2.3', catalog: {operational: {slug: 'example'}}});
    const outputs = {paths_released: JSON.stringify([path]), [`${path}--tag_name`]: release.tag, [`${path}--sha`]: commit};
    const options = {root, config: {appGlobs: ['*'], commands: ['check', 'test', 'build'], releaseTargets: {[path]: release.targets}}};
    assert.deepEqual(releaseEvents(outputs, options), [release]);
    assert.deepEqual(releaseEvents({}, options), []);
    assert.deepEqual(releaseEvents(outputs, {...options, config: {...options.config, releaseTargets: {}}})[0].targets, []);
    assert.throws(() => releaseEvents({...outputs, [`${path}--sha`]: ''}, options), /immutable commit/);
    assert.throws(() => releaseEvents({...outputs, [`${path}--tag_name`]: ''}, options), /return a tag/);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('release notification obtains audience-bound OIDC and returns durable update receipts', async () => {
  const calls = [];
  assert.deepEqual(await notifyRelease(release, {env, fetcher: async (url, init) => {
    calls.push({url: String(url), init});
    return calls.length === 1 ? json({value: 'identity-token'}) : json(receipt, 202);
  }}), receipt);
  assert.equal(new URL(calls[0].url).searchParams.get('audience'), 'https://ai-outfitter.com');
  assert.equal(calls[1].url, 'https://ai-outfitter.com/api/app-repositories/releases');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer identity-token');
  assert.deepEqual(JSON.parse(calls[1].init.body), release);
  assert.equal(calls.length, 2);
});

test('registration only requires no installation and works at self-hosted origin', async () => {
  let calls = 0;
  await notifyRelease({...release, targets: []}, {env: {...env, OUTFITTER_URL: 'https://outfitter.example.org'}, fetcher: async (url, init) => {
    if (++calls === 1) {assert.equal(new URL(url).searchParams.get('audience'), 'https://outfitter.example.org'); return json({value: 'token'});}
    assert.equal(url, 'https://outfitter.example.org/api/app-repositories/releases');
    assert.deepEqual(JSON.parse(init.body).targets, []);
    return json({...receipt, requests: []}, 202);
  }});
});

test('untrusted events, missing credentials and invalid destinations never send requests', async () => {
  for (const overrides of [{GITHUB_EVENT_NAME: 'pull_request'}, {GITHUB_EVENT_NAME: 'pull_request_target'}, {GITHUB_REF: 'refs/heads/other'}, {GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/other'}, {ACTIONS_ID_TOKEN_REQUEST_TOKEN: ''}, {OUTFITTER_URL: 'http://example.org'}, {OUTFITTER_URL: 'https://user:secret@example.org'}, {OUTFITTER_URL: 'https://example.org/path'}]) {
    await assert.rejects(notifyRelease(release, {env: {...env, ...overrides}, fetcher: () => {throw Error('must not fetch');}}));
  }
});

test('release validation rejects malformed identity and mismatched or duplicate targets', () => {
  for (const overrides of [{commit: 'main'}, {tag: '../secret'}, {app: '../example'}, {targets: [{target: 'user/example'}]}, {targets: [{target: 'platform/some-other-app'}]}, {targets: [{target: 'org/example', repositoryId: '../other'}]}, {targets: [release.targets[0], release.targets[0]]}])
    assert.throws(() => validateRelease({...release, ...overrides}));
  assert.deepEqual(validateRelease({...release, targets: [{target: 'org/example', repositoryId: 'binding-id'}]}).targets, [{target: 'org/example', repositoryId: 'binding-id'}]);
});

test('HTTP failures, malformed receipts and mismatched commits/targets fail rather than claiming activation', async () => {
  for (const response of [json({}, 401), json({}, 404), json({}, 503), json({}), json({...receipt, sourceCommit: 'b'.repeat(40)}), json({...receipt, requests: []}), json({...receipt, requests: [{id: 'id', target: 'platform/example', status: 'pending'}]})]) {
    let calls = 0;
    await assert.rejects(notifyRelease(release, {env, fetcher: async () => ++calls === 1 ? json({value: 'token'}) : response}));
    assert.equal(calls, 2);
  }
});
