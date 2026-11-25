// Project the case's type vocabulary from two pinned revisions. The output can
// be reviewed and rerun with the eval alone, including before the refactor merges.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [checkout, candidate] = process.argv.slice(2);
if (!checkout || !/^[a-f0-9]{40}$/.test(candidate ?? '')) {
  throw new Error('Usage: node project-schema.mjs <built candidate checkout with both commits> <candidate commit SHA>');
}

const baseline = '6aa42708d7f70feeec1541a35230a487d134f60c';
const ontoPath = 'apps/onto/seeds/types-v1.json';
const forerunnerPath = 'apps/forerunner/seeds/discovery-graph-v1.json';
const compiledPath = 'packages/app-sdk/graph/standard-types.json';
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
if (git('rev-parse', 'HEAD').trim() !== candidate || git('status', '--porcelain').trim()) {
  throw new Error('Use a clean checkout of the pinned candidate');
}
execFileSync('npm', ['run', 'graph:compose', '--', '--check'], { cwd: checkout, stdio: ['ignore', 2, 2] });
const read = (commit, path) => JSON.parse(git('show', `${commit}:${path}`));
const installed = read(baseline, ontoPath);
const generated = readFileSync(join(checkout, compiledPath));
const compiled = JSON.parse(generated);
const authored = [
  ...read(candidate, ontoPath).map((type) => ({ ...type, address: `onto:${type.name}` })),
  ...read(candidate, forerunnerPath).map((type) => ({ ...type, address: `forerunner:${type.name}` })),
];
const unique = (rows, predicate, label) => {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) throw new Error(`Expected one graph type for ${label}`);
  return matches[0];
};
const spec = JSON.parse(readFileSync(new URL('./evals/connected-discovery/schema.json', import.meta.url)));
const scope = spec.types.map(({ key, baseline: name, description, from, to }) => {
  const before = unique(installed, (type) => type.name === name, name);
  const after = unique(authored, (type) => type.id === before.id, before.id);
  const built = unique(compiled, (type) => type.id === before.id, before.id);
  if ([after, built].some((type) => type.name !== before.name || type.category !== before.category)) {
    throw new Error(`Type changed identity: ${name}`);
  }
  return { key, description, before, after, built, endpoints: { from, to } };
});
const idsByKey = new Map(scope.map(({ key, before }) => [key, before.id]));

function endpoints(type, side, resolve) {
  const directed = type.ontology?.endpoints?.[side];
  if (!Array.isArray(directed)) throw new Error(`Expected an explicit ${side} for ${type.name}`);
  return directed.map(resolve).sort();
}

const types = scope.map(({ key, description, before, after, built, endpoints: caseEndpoints }) => {
  const type = { key, baseline: before.name, candidate: after.address, description, stableId: before.id };
  if (before.category === 'node') return type;
  for (const side of ['from', 'to']) {
    const baselineIds = endpoints(before, side, (id) => unique(installed, (row) => row.id === id, id).id);
    const candidateIds = endpoints(after, side, (address) => unique(authored, (row) => row.address === address, address).id);
    const compiledIds = endpoints(built, side, (id) => unique(compiled, (row) => row.id === id, id).id);
    if ([candidateIds, compiledIds].some((ids) => JSON.stringify(baselineIds) !== JSON.stringify(ids))) {
      throw new Error(`Directed endpoint contract changed: ${after.address} ${side}`);
    }
    type[side] = caseEndpoints[side];
    if (!baselineIds.includes(idsByKey.get(type[side]))) {
      throw new Error(`Unsupported fixture ${side} endpoint: ${after.address} ${type[side]}`);
    }
  }
  return type;
});
const source = {
  baseline: { commit: baseline, files: [ontoPath] },
  candidate: {
    commit: candidate, files: [ontoPath, forerunnerPath], generated: compiledPath,
    generatedSha256: createHash('sha256').update(generated).digest('hex'),
  },
};
console.log(JSON.stringify({ source, types }, null, 2));
