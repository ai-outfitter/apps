import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepare, typeContext } from './fixture.mjs';
import { gradeProposal } from './evals/connected-discovery/EVAL.ts';

const fixture = name => fileURLToPath(new URL(`./evals/${name}/`, import.meta.url));
const read = async (name, file) => readFile(join(fixture(name), file), 'utf8');
const schema = JSON.parse(await read('connected-discovery', 'schema-authored.json'));
const existing = JSON.parse(await readFile(new URL('./records.json', import.meta.url), 'utf8')).map(record => record.id);
const cases = ['connected-discovery', 'workspace-activity', 'developer-attribution'];

for (const name of cases) {
  test(`${name} changes authored context only and keeps expected answers outside inference`, async () => {
    const prompt = await read(name, 'PROMPT.md');
    const baseline = await prepare('baseline', fixture(name), prompt);
    const candidate = await prepare('candidate', fixture(name), prompt);
    assert.deepEqual(baseline.inputs, candidate.inputs);
    assert.deepEqual(baseline.messages[1], candidate.messages[1]);
    assert.notDeepEqual(baseline.messages[0], candidate.messages[0]);
    assert.deepEqual(baseline.tools, candidate.tools);
    for (const type of schema.types) {
      assert.ok(baseline.messages[0].content.includes(type.baseline.description));
      assert.ok(candidate.messages[0].content.includes(type.candidate.description));
    }
    const publicInput = JSON.stringify(candidate.messages);
    assert.doesNotMatch(publicInput, /g-101|g-227|g-537|g-280|g-380|onlySupportedEdges|expected\.json/);
    for (const [query, ids] of [
      ['Mika Vale', ['g-280', 'g-101']], ['Tideglass Collective LLC', ['g-537', 'g-227']],
    ]) {
      const args = JSON.stringify({ query });
      const matches = baseline.execute('lookup_graph', args);
      assert.deepEqual(matches, candidate.execute('lookup_graph', args));
      assert.deepEqual(matches.map(match => match.id), ids);
    }
  });
}

test('the grader evaluates arm-specific names, alternative supporting citations and unsupported edges', async () => {
  const expected = JSON.parse(await read('connected-discovery', 'expected.json'));
  for (const arm of ['baseline', 'candidate']) {
    const { names } = typeContext(schema, arm);
    const proposal = {
      nodes: [
        { id: 'desk', type: names.product, name: 'Tideglass Desk', evidence: ['E4'] },
        { id: 'dispatch', type: names.newsletter, name: 'Tideglass Dispatch', evidence: ['E3'] },
      ],
      edges: [
        { type: names.sign_in, from: 'g-101', to: 'desk', evidence: ['E1'] },
        { type: names.operator, from: 'desk', to: 'g-227', evidence: ['E2'] },
        { type: names.recipient, from: 'g-101', to: 'dispatch', evidence: ['E3'] },
        { type: names.publisher, from: 'dispatch', to: 'g-227', evidence: ['E3'] },
      ],
      decisions: [
        { question: 'product_use', action: 'defer', evidence: ['E1'], reason: 'The security log records authentication.' },
        { question: 'product_developer', action: 'defer', evidence: ['E2'], reason: 'The terms identify the operator.' },
      ],
    };
    const grade = value => gradeProposal(JSON.stringify(value), names, expected, existing);
    assert.equal(grade(proposal).passed, true);
    const other = typeContext(schema, arm === 'baseline' ? 'candidate' : 'baseline');
    assert.equal(gradeProposal(JSON.stringify(proposal), other.names, expected, existing).passed, false);

    const wrong = structuredClone(proposal);
    wrong.edges[0].evidence = ['E4'];
    wrong.edges[1].to = 'g-537';
    [wrong.edges[2].from, wrong.edges[2].to] = [wrong.edges[2].to, wrong.edges[2].from];
    wrong.nodes[1].id = wrong.nodes[0].id;
    wrong.decisions[1].action = 'record';
    wrong.edges.push({ type: names.use, from: 'g-101', to: 'desk', evidence: ['E1'] });
    const { checks } = grade(wrong);
    assert.equal(checks.grounding.sign_in, false);
    assert.equal(checks.canonicalReuse.onlyNewRecords, false);
    assert.equal(checks.canonicalReuse.sharedOperatorPublisher, false);
    assert.equal(checks.directedRelationships.recipient, false);
    assert.equal(checks.directedRelationships.onlySupportedEdges, false);
    assert.equal(checks.decisionEvidence.product_developer, false);
    assert.equal(gradeProposal('unparseable', names, expected, existing).passed, false);
    for (const name of ['workspace-activity', 'developer-attribution']) {
      const positive = JSON.parse(await read(name, 'expected.json'));
      assert.equal(gradeProposal(JSON.stringify(proposal), names, positive, existing).passed, false);
      const corrected = structuredClone(proposal);
      const use = name === 'workspace-activity';
      corrected.edges.push({ type: names[use ? 'use' : 'developer'],
        from: use ? 'g-101' : 'desk', to: use ? 'desk' : 'g-380', evidence: ['E5'] });
      const decision = corrected.decisions[use ? 0 : 1];
      decision.action = 'record';
      decision.reason = 'The published record supports the additional relationship.';
      assert.equal(gradeProposal(JSON.stringify(corrected), names, positive, existing).passed, false);
      decision.evidence.push('E5');
      assert.equal(gradeProposal(JSON.stringify(corrected), names, positive, existing).passed, true);
    }
  }
});

test('the retained Spark pair replays the public input, tool lookups and each grade', async () => {
  const { runs } = JSON.parse(await readFile(new URL('./receipts/spark-authored-cases.json', import.meta.url), 'utf8'));
  for (const [arm, receipts] of Object.entries(runs)) {
    assert.deepEqual(receipts.map(receipt => receipt.inputs.fixture).sort(), cases.slice().sort());
    for (const receipt of receipts) {
      const name = receipt.inputs.fixture;
      const prepared = await prepare(arm, fixture(name), await read(name, 'PROMPT.md'));
      assert.deepEqual(receipt.inputs, prepared.inputs);
      assert.deepEqual(receipt.initialMessages, prepared.messages);
      assert.deepEqual(receipt.tools, prepared.tools);
      assert.deepEqual(receipt.grade, prepared.grade(receipt.output));
      for (const turn of receipt.turns) {
        for (const [index, call] of (turn.message.tool_calls ?? []).entries()) {
          const replay = prepared.execute(call.function.name, call.function.arguments);
          assert.deepEqual(JSON.parse(turn.toolResults[index].content), replay);
        }
      }
    }
  }
});
