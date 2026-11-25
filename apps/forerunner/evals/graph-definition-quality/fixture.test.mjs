import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepare, typeContext } from './fixture.mjs';
import { gradeProposal } from './evals/connected-discovery/EVAL.ts';

const fixture = fileURLToPath(new URL('./evals/connected-discovery/', import.meta.url));
const schema = JSON.parse(await readFile(new URL('./evals/connected-discovery/schema.json', import.meta.url), 'utf8'));
const prompt = await readFile(new URL('./evals/connected-discovery/PROMPT.md', import.meta.url), 'utf8');

test('arms hold the public prompt, evidence, tools, and rubric fixed', async () => {
  const baseline = await prepare('baseline', fixture, prompt);
  const candidate = await prepare('candidate', fixture, prompt);
  assert.deepEqual(baseline.inputs, candidate.inputs);
  assert.deepEqual(baseline.messages[1], candidate.messages[1]);
  assert.notDeepEqual(baseline.messages[0], candidate.messages[0]);
  assert.deepEqual(baseline.tools, candidate.tools);
  for (const query of ['Mika Vale', 'TC-801', 'tideglass', 'Cirrus']) {
    const args = JSON.stringify({ query });
    assert.deepEqual(baseline.execute('lookup_graph', args), candidate.execute('lookup_graph', args));
  }
  assert.deepEqual(baseline.execute('lookup_graph', '{"query":"Mika Vale"}').map(({ id }) => id), ['g-101', 'g-280']);
});

for (const arm of ['baseline', 'candidate']) {
  test(`${arm} scorer catches citation substitution, reverse edges, duplicate IDs and unsupported decisions`, () => {
    const { names } = typeContext(schema, arm);
    const proposal = {
      nodes: [
        { id: 'desk', type: names.product, name: 'Tideglass Desk', evidence: ['E1'] },
        { id: 'dispatch', type: names.newsletter, name: 'Tideglass Dispatch', evidence: ['E3'] },
      ],
      edges: [
        { type: names.sign_in, from: 'g-101', to: 'desk', evidence: ['E1'] },
        { type: names.operator, from: 'desk', to: 'g-227', evidence: ['E2'] },
        { type: names.recipient, from: 'g-101', to: 'dispatch', evidence: ['E3'] },
        { type: names.publisher, from: 'dispatch', to: 'g-227', evidence: ['E3'] },
      ],
      decisions: [
        { question: 'product_use', action: 'defer', evidence: ['E1', 'E4'], reason: 'No activity follows the sign-in.' },
        { question: 'product_developer', action: 'defer', evidence: ['E2', 'E4'], reason: 'Neither source names a developer.' },
      ],
    };
    const grade = (value) => gradeProposal(JSON.stringify(value), names);
    assert.equal(grade(proposal).passed, true);

    const wrong = structuredClone(proposal);
    wrong.edges[0].evidence = ['E4'];
    [wrong.edges[2].from, wrong.edges[2].to] = [wrong.edges[2].to, wrong.edges[2].from];
    wrong.nodes[1].id = wrong.nodes[0].id;
    wrong.decisions[1].action = 'record';
    const { checks } = grade(wrong);
    assert.equal(checks.grounding.signIn, false);
    assert.equal(checks.canonicalReuse.onlyNewRecords, false);
    assert.equal(checks.directedRelationships.recipient, false);
    assert.equal(checks.decisionEvidence.developer, false);
    assert.equal(gradeProposal('unparseable', names).passed, false);
  });
}

for (const [name, file] of [['instruction', 'schema.json'], ['authored', 'schema-authored.json']]) {
  test(`the ${name} receipt matches the frozen inputs and replays both grades`, async () => {
    const { runs } = JSON.parse(await readFile(new URL(`./receipts/spark-${name}-pair.json`, import.meta.url), 'utf8'));
    for (const [arm, [receipt]] of Object.entries(runs)) {
      const prepared = await prepare(arm, fixture, prompt, join(fixture, file));
      assert.deepEqual(receipt.inputs, prepared.inputs);
      assert.deepEqual(receipt.initialMessages, prepared.messages);
      assert.deepEqual(receipt.tools, prepared.tools);
      assert.deepEqual(receipt.grade, prepared.grade(receipt.output));
    }
  });
}
