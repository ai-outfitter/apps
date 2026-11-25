// Grade the recorded run independently of the agent prompt.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const load = file => JSON.parse(readFileSync(join(process.argv[2], file), "utf8"));
const plan = load("plan.json");
const trace = load("trace.json");
const calls = trace.turns.flatMap(t => t.calls);
const reads = new Set(calls.filter(c => c.name === "read_file" && typeof c.result === "string").map(c => {
  const { repository, path } = JSON.parse(c.arguments);
  return repository + ":" + path;
}));
const scope = new Set(trace.tools[0].function.parameters.properties.repository.enum);
assert.deepEqual(new Set([...reads].map(key => key.split(":")[0])), scope);
assert.ok(plan.citations.length && plan.citations.every(c => reads.has(c)), "all citations were actually read");
const byKey = new Map(plan.requirements.map(r => [r.key, r]));
assert.equal(byKey.size, plan.requirements.length);
const visited = new Set();
function visit(key, ancestors) {
  assert.ok(byKey.has(key) && !ancestors.has(key), "unknown or cyclic dependency: " + key);
  if (visited.has(key)) return;
  const row = byKey.get(key);
  assert.ok(scope.has(row.target.repository) && row.acceptanceCriteria.length);
  for (const parent of row.dependsOn) visit(parent, new Set([...ancestors, key]));
  visited.add(key);
}
for (const key of byKey.keys()) visit(key, new Set());
assert.ok(plan.milestones.length && plan.milestones.every(m => m.title && m.keys.length));
assert.deepEqual(new Set(plan.milestones.flatMap(m => m.keys)), new Set(byKey.keys()));
console.log(JSON.stringify({ model: trace.model, toolCalls: calls.length, successfulFileReads: reads.size,
  requirements: byKey.size, dependencies: plan.requirements.flatMap(r => r.dependsOn).length,
  milestones: plan.milestones.length, wallSeconds: trace.wallSeconds }, null, 2));
