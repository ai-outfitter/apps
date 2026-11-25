import assert from "node:assert/strict";
import test from "node:test";
import { compileAuthoredGraphs, type AuthoredGraph } from "../src/graph-authoring";

const core: AuthoredGraph = {
  namespace: "onto",
  types: [
    { category: "node", name: "Person", aliases: ["Human"], title: "Person", body: "A person." },
    { category: "node", name: "Organization", title: "Organization", body: "An organization." },
  ],
};
const sample: AuthoredGraph = {
  namespace: "example",
  types: [{
    category: "edge", name: "organizes", title: "Organizes", body: "The person organizes the group.",
    ontology: { version: 2, endpoints: { from: ["onto:Human"], to: ["onto:Organization"] } },
  }],
  nodes: [
    { id: "79f00000-0000-4000-8000-000000000001", typeId: "onto:Person", slug: "ada", aliases: ["a"], title: "Ada" },
    { typeId: "onto:Organization", slug: "group", title: "The Group" },
  ],
  edges: [{ key: "ada-group", typeId: "example:organizes", fromId: "example:Person:a", toId: "example:Organization:group" }],
};

test("authored graph aliases resolve to directed endpoints and retain stable identities", async () => {
  const output = await compileAuthoredGraphs([sample, core]);
  assert.deepEqual(output, await compileAuthoredGraphs([sample, core]));
  assert.deepEqual(output, (await compileAuthoredGraphs([core, sample])).reverse());
  const [graph, foundation] = output;
  assert.equal(graph.nodes[0].id, sample.nodes![0].id);
  assert.equal(graph.nodes[0].typeId, foundation.types[0].id);
  assert.equal(graph.edges[0].fromId, graph.nodes[0].id);
  assert.equal(graph.edges[0].toId, graph.nodes[1].id);
  assert.equal(graph.edges[0].typeId, graph.types[0].id);
  assert.ok(!("aliases" in graph.nodes[0]));
});

test("authored graphs reject collisions, unresolved references and invalid directed endpoints", async () => {
  await assert.rejects(compileAuthoredGraphs([core, { ...core, namespace: "other" }]), /Duplicate public type name/);
  await assert.rejects(compileAuthoredGraphs([{ ...core, types: [core.types![0], { ...core.types![1], aliases: ["Human"] }] }]), /Duplicate type address or alias/);
  await assert.rejects(compileAuthoredGraphs([core, { ...sample, nodes: sample.nodes!.map(node => ({ ...node, id: sample.nodes![0].id })) }]), /Duplicate record identity/);
  await assert.rejects(compileAuthoredGraphs([core, { ...sample, edges: [{ ...sample.edges![0], toId: "example:Organization:missing" }] }]), /Unresolved directed endpoint/);
  await assert.rejects(compileAuthoredGraphs([core, { ...sample, edges: [{ ...sample.edges![0], fromId: "example:Organization:group", toId: "example:Person:ada" }] }]), /Invalid directed endpoints/);
  await assert.rejects(compileAuthoredGraphs([sample]), /Unresolved node type/);
  await assert.rejects(compileAuthoredGraphs([core, {
    ...sample, edges: [...sample.edges!, { ...sample.edges![0], key: "duplicate" }],
  }]), /Duplicate directed relationship identity/);
  await assert.rejects(compileAuthoredGraphs([core, {
    ...sample, nodes: [...sample.nodes!, { typeId: "onto:Person", slug: "a", title: "Alias collision" }],
  }]), /Duplicate node address/);
});
