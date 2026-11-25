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
const ownerFiles = { onto: [ontoPath, 'apps/onto/seeds/artifacts-v1.json'], forerunner: ['apps/forerunner/seeds/discovery-graph-v1.json'], planning: ['apps/planning/seeds/work-graph-v1.json'] };
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
const authored = Object.entries(ownerFiles).flatMap(([owner, paths]) => paths.flatMap((path) => {
  const source = read(candidate, path);
  return (Array.isArray(source) ? source : source.types).map((type) => ({ ...type, address: `${owner}:${type.name}` }));
}));
const unique = (rows, predicate, label) => {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) throw new Error(`Expected one graph type for ${label}`);
  return matches[0];
};
const spec = JSON.parse(readFileSync(new URL('./evals/connected-discovery/schema.json', import.meta.url)));
function endpoints(type, side, resolve) {
  const directed = type.ontology?.endpoints?.[side];
  if (directed === 'any') return 'any';
  if (!Array.isArray(directed)) throw new Error(`Expected an explicit ${side} for ${type.name}`);
  return directed.map(resolve);
}

const types = spec.types.map(({ key, name }) => {
  const previous = unique(installed, (type) => type.name === name, name);
  const current = unique(authored, (type) => type.id === previous.id, previous.id);
  const generated = unique(compiled, (type) => type.id === previous.id, previous.id);
  if ([current, generated].some((type) => type.name !== previous.name || type.category !== previous.category)) {
    throw new Error(`Type changed identity: ${name}`);
  }
  const baseline = { name: previous.name, description: previous.body };
  const candidate = { name: current.address, description: current.body };
  if (previous.category === 'edge') {
    for (const side of ['from', 'to']) {
      const authoredIds = endpoints(current, side, (address) => unique(authored, (row) => row.address === address, address).id);
      const canonicalIds = endpoints(generated, side, (id) => id);
      const beforeIds = endpoints(previous, side, (id) => id);
      const sorted = (ids) => JSON.stringify(ids === 'any' ? ids : ids.slice().sort());
      if (sorted(authoredIds) !== sorted(canonicalIds) || sorted(beforeIds) !== sorted(canonicalIds))
        throw new Error(`Authored, compiled and baseline directions differ: ${current.address} ${side}`);
      baseline[side] = endpoints(previous, side, (id) => unique(installed, (row) => row.id === id, id).name);
      candidate[side] = current.ontology.endpoints[side];
    }
  }
  return { key, stableId: previous.id, baseline, candidate };
});
const source = {
  baseline: { commit: baseline, files: [ontoPath] },
  candidate: {
    commit: candidate, files: Object.values(ownerFiles).flat(), generated: compiledPath,
    generatedSha256: createHash('sha256').update(generated).digest('hex'),
  },
};
console.log(JSON.stringify({ source, types }, null, 2));
