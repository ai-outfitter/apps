import assert from "node:assert/strict";
import test from "node:test";
import { renderKnowledgeGraphMarkdown } from "@ai-outfitter/app-sdk/graph-markdown";
import { knowledgeGraphSelectResult } from "@ai-outfitter/app-sdk/graph-selection";
import { knowledgeGraphRenderResult } from "@ai-outfitter/app-sdk/graph-templates";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { core } from "../src/lib/graph";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const reader = { ...owner, userId: "reader", role: "member" };
const path = "/api/internal/actions/v1/call";

test("saved and inline graph selections render stored facts without writes or private fields", async () => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    const create = (ref: string, type: string, attributes: object) => ({ operation: "create", ref, type, attributes });
    const response = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: {
      requestKey: "selection-render-fixture", operations: [
        create("$type", "graph-type", { category: "node", name: "SelectionFact", title: "Selection fact", body: "Synthetic facts." }),
        create("$relation", "graph-type", { category: "edge", name: "selection_link", title: "Selection link", body: "Synthetic link." }),
        create("$root", "graph-node", { typeId: "$type", title: "Root", body: "Authored **Markdown** stays unchanged." }),
        create("$child", "graph-node", { typeId: "$type", title: "Child" }),
        create("$other", "graph-node", { typeId: "$type", title: "Unrelated" }),
        create("$edge", "graph-edge", { typeId: "$relation", fromId: "$root", toId: "$child" }),
        create("$partial", "graph-node", { typeId: core.knowledgeGraph, title: "Optional vocabulary", properties: {
          root_type: "SelectionFact", pattern: JSON.stringify({ relationships: ["selection_link"], max_depth: 2 }),
        }, body: JSON.stringify({ name:"Optional vocabulary", purpose:"Stored facts with optional app types", rootTypes:["SelectionFact","FutureFeature"],
          selection:{relationships:["selection_link"],maxDepth:2,maxNodes:20} }) }),
        create("$lens", "graph-node", { typeId: core.knowledgeGraph, title: "Facts lens", properties: {
          root_type: "SelectionFact", pattern: JSON.stringify({ relationships: ["selection_link"], max_depth: 2 }),
        } }),
      ],
    } } });
    assert.equal(response.status, 200, await response.clone().text());
    const ids = await response.json() as Record<string, { id: string }>;
    await app.database.prepare("UPDATE graph_nodes SET privateData=? WHERE id=?").bind('{"secret":"never-export-this"}', ids.$root.id).run();
    const snapshot = () => app.database.prepare("SELECT id,revision,updatedAt FROM graph_nodes ORDER BY id").all();
    const before = await snapshot();
    // The selection knowledge-graph.render reads before it flattens (as Foundry calls it), answered alone.
    const bare = { version: 1, order: 0, name: "Bare", bindings: {}, sections: [{ heading: "Selection", fields: [] }] };
    const select = async (input: object) => {
      const response = await app.call(path, reader, { method: "POST", body: { action: "knowledge-graph.render", input: { ...input, templates: [bare] } } });
      return response.ok ? Response.json((await response.json() as { selection: unknown }).selection) : response;
    };
    const saved = await select({ definitionId: ids.$lens.id, rootIds: [ids.$root.id] });
    assert.equal(saved.status, 200, await saved.clone().text());
    const graph = knowledgeGraphSelectResult.parse(await saved.json());
    assert.deepEqual(graph.nodes.map(node => node.ref.id).sort(), [ids.$root.id, ids.$child.id].sort());
    assert.equal(graph.record?.ref.id, ids.$lens.id);
    assert.equal(graph.incomplete, false);
    assert.ok(!JSON.stringify(graph).includes("never-export-this"));
    const rendered = renderKnowledgeGraphMarkdown(graph);
    assert.ok(rendered.markdown.includes("Authored **Markdown** stays unchanged."));
    assert.ok(!rendered.markdown.includes("Unrelated"));
    assert.equal(rendered.complete, true);
    // The query the read ran comes back with its hash and variables schema: show it, pass it back, or edit it.
    assert.match(graph.query ?? "", /^query FactsLens\(\$rootIds: \[ID!\]!\) \{/);
    assert.match(graph.hash ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual((graph.variables as { required: string[] }).required, ["rootIds"]);
    const again = knowledgeGraphSelectResult.parse(await (await select({ query: graph.query, rootIds: [ids.$root.id] })).json());
    assert.deepEqual(again.nodes.map(node => node.ref.id).sort(), graph.nodes.map(node => node.ref.id).sort());
    assert.deepEqual(again.edges.map(edge => edge.ref.id), [ids.$edge.id]);
    assert.equal(again.hash, graph.hash);
    assert.equal(again.nodes.find(node => node.ref.id === ids.$root.id)?.attributes.body, "Authored **Markdown** stays unchanged.", "records come back as stored");
    const rootsOnly = knowledgeGraphSelectResult.parse(await (await select({ query: "query($rootIds: [ID!]!) { selectionFacts(ids: $rootIds) { nodes { id typeId title } } }", rootIds: [ids.$root.id] })).json());
    assert.deepEqual(rootsOnly.nodes.map(node => node.ref.id), [ids.$root.id]);
    assert.equal((await select({ query: "{ nope }", rootIds: [ids.$root.id] })).status, 400);
    const inline = await select({ definition: graph.definition, rootIds: [ids.$root.id] });
    assert.equal(inline.status, 200, await inline.clone().text());
    assert.equal(renderKnowledgeGraphMarkdown(knowledgeGraphSelectResult.parse(await inline.json())).markdown, rendered.markdown);
    const partial = await select({ definitionId:ids.$partial.id, rootIds:[ids.$root.id] });
    assert.equal(partial.status,200,await partial.clone().text());
    const partialGraph = knowledgeGraphSelectResult.parse(await partial.json());
    assert.deepEqual(partialGraph.missingTypes,["FutureFeature"]);
    assert.equal(partialGraph.incomplete,true);
    assert.equal(partialGraph.nodes.length,2);
    const bounded = await select({ definitionId: ids.$lens.id, rootIds: [ids.$root.id], maxNodes: 1 });
    assert.equal(bounded.status, 200, await bounded.clone().text());
    const limited = knowledgeGraphSelectResult.parse(await bounded.json());
    assert.equal(limited.incomplete, true);
    assert.deepEqual(limited.omitted.map(ref => ref.id), [ids.$child.id]);
    assert.equal(renderKnowledgeGraphMarkdown(limited).complete, false);
    // knowledge-graph.render flattens the same selection through the caller's template.
    const template = { version: 1, order: 0, name: "Facts", bindings: { root: { op: "ref", id: "$params.rootId" }, facts: { op: "query", type: "SelectionFact" } },
      require: [{ op: "present", value: "$root" }],
      sections: [{ heading: "$root.title", level: 1, fields: [{ label: "Linked", value: { op: "map", from: { op: "related", from: "$root", edge: "selection_link" }, value: "$item.title" } }] },
        { heading: "Every fact", fields: [{ label: "Facts", value: { op: "map", from: "$facts", value: "$item.title" } }] }] };
    const flattened = await app.call(path, reader, { method: "POST", body: { action: "knowledge-graph.render", input: { definitionId: ids.$lens.id, rootIds: [ids.$root.id], templates: [template] } } });
    assert.equal(flattened.status, 200, await flattened.clone().text());
    const { document, selection } = knowledgeGraphRenderResult.parse(await flattened.json());
    assert.match(document.markdown, /^# Root\n\n- Linked:\n {2}- Child/);
    assert.ok(!document.markdown.includes("Unrelated"), "templates read only the selection");
    assert.ok(document.sources.some(source => source.ref.id === ids.$child.id));
    assert.equal(document.complete, true);
    assert.equal(selection.nodes.length, 2);
    const tooSmall = await app.call(path, reader, { method: "POST", body: { action: "knowledge-graph.render", input: { definitionId: ids.$lens.id, rootIds: [ids.$root.id], maxNodes: 1, templates: [template] } } });
    assert.equal(knowledgeGraphRenderResult.parse(await tooSmall.json()).document.complete, false);
    assert.deepEqual((await snapshot()).results, before.results);
    // A saved query without a selection runs as written.
    const savedQuery = "query Facts($rootIds: [ID!]!) { selectionFacts(ids: $rootIds) { nodes { id typeId title edges(types: [\"selection_link\"], direction: OUTGOING) { id typeId fromId toId to { id typeId title } } } } }";
    const savedCall = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: { requestKey: "saved-query", operations: [
      create("$query", "graph-node", { typeId: core.knowledgeGraph, title: "Facts query", body: JSON.stringify({ name: "Facts query", purpose: "A hand-written query.", query: savedQuery }) }),
    ] } } });
    assert.equal(savedCall.status, 200, await savedCall.clone().text());
    const queryId = (await savedCall.json() as Record<string, { id: string }>).$query.id;
    const fromQuery = knowledgeGraphSelectResult.parse(await (await select({ definitionId: queryId, rootIds: [ids.$root.id] })).json());
    assert.equal(fromQuery.query, savedQuery);
    assert.deepEqual(fromQuery.nodes.map(node => node.ref.id).sort(), [ids.$root.id, ids.$child.id].sort());
    assert.deepEqual(fromQuery.definition.relationships, [{ type: "selection_link", direction: "outgoing" }]);
    const badQuery = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: { requestKey: "bad-query", operations: [
      create("$bad", "graph-node", { typeId: core.knowledgeGraph, title: "Bad query", body: JSON.stringify({ name: "Bad", purpose: "Unparsable.", query: "query {" }) }),
    ] } } });
    assert.notEqual(badQuery.status, 200, "a query that does not parse is not saved");
    const wrongHash = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: { requestKey: "wrong-hash", operations: [
      create("$hash", "graph-node", { typeId: core.knowledgeGraph, title: "Wrong hash", body: JSON.stringify({ name: "Wrong hash", purpose: "A hash of another text.", query: savedQuery, hash: "0".repeat(64) }) }),
    ] } } });
    assert.notEqual(wrongHash.status, 200, "a hash that is not the query's sha256 is not saved");
    // A written selection stores what it compiles to: a hand-supplied query naming a type that is gone is replaced.
    const staleBody = { name: "Stale", purpose: "A selection whose stored query names a type that is gone.", rootTypes: ["SelectionFact"],
      selection: { relationships: ["selection_link"], maxDepth: 2, maxNodes: 20 }, query: "query Stale($rootIds: [ID!]!) { goneFacts(ids: $rootIds) { nodes { id } } }" };
    const staleCall = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: { requestKey: "stale-query", operations: [
      create("$stale", "graph-node", { typeId: core.knowledgeGraph, title: "Stale lens", body: JSON.stringify(staleBody) }),
    ] } } });
    assert.equal(staleCall.status, 200, await staleCall.clone().text());
    const stale = knowledgeGraphSelectResult.parse(await (await select({ definitionId: (await staleCall.json() as Record<string, { id: string }>).$stale.id, rootIds: [ids.$root.id] })).json());
    assert.match(stale.query ?? "", /^query StaleLens\(/);
    assert.deepEqual(stale.nodes.map(node => node.ref.id).sort(), [ids.$root.id, ids.$child.id].sort());
    // A supplied query that validates but omits a hop of the selection is replaced by the compile too.
    const narrowBody = { name: "Narrow", purpose: "A selection whose stored query predates its link type.", rootTypes: ["SelectionFact"],
      selection: { relationships: ["selection_link"], maxDepth: 2, maxNodes: 20 }, query: "query Narrow($rootIds: [ID!]!) { selectionFacts(ids: $rootIds) { nodes { id typeId title } } }" };
    const narrowCall = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: { requestKey: "narrow-query", operations: [
      create("$narrow", "graph-node", { typeId: core.knowledgeGraph, title: "Narrow lens", body: JSON.stringify(narrowBody) }),
    ] } } });
    assert.equal(narrowCall.status, 200, await narrowCall.clone().text());
    const narrow = knowledgeGraphSelectResult.parse(await (await select({ definitionId: (await narrowCall.json() as Record<string, { id: string }>).$narrow.id, rootIds: [ids.$root.id] })).json());
    assert.equal(narrow.query, graph.query?.replace("query FactsLens(", "query NarrowLens(").replace("first: 200", "first: 20"), "the live compile, not the stored text");
    assert.deepEqual(narrow.nodes.map(node => node.ref.id).sort(), [ids.$root.id, ids.$child.id].sort());
    // A link type added after the lens was saved (as Planning adds UseCase after the seed): the
    // stored document is recompiled when the type is written, so the hash clients run includes it.
    const futureBody = { name: "Future", purpose: "A selection naming a link type that does not exist yet.", rootTypes: ["SelectionFact"],
      selection: { relationships: ["selection_link", "selection_future"], maxDepth: 2, maxNodes: 20 } };
    const futureCall = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: { requestKey: "future-lens", operations: [
      create("$future", "graph-node", { typeId: core.knowledgeGraph, title: "Future lens", body: JSON.stringify(futureBody) }),
    ] } } });
    assert.equal(futureCall.status, 200, await futureCall.clone().text());
    const futureId = (await futureCall.json() as Record<string, { id: string }>).$future.id;
    const storedBody = async () => JSON.parse(String((await app.database.prepare("SELECT body FROM graph_nodes WHERE id=?").bind(futureId).first() as { body: string }).body));
    const compiledBefore = await storedBody();
    assert.ok(!compiledBefore.query.includes("selectionFuture"), "compiled without the missing link type");
    const linkCall = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: { requestKey: "future-link", operations: [
      create("$futureType", "graph-type", { category: "edge", name: "selection_future", title: "Selection future", body: "Synthetic link added later." }),
      create("$futureEdge", "graph-edge", { typeId: "$futureType", fromId: ids.$root.id, toId: ids.$other.id }),
    ] } } });
    assert.equal(linkCall.status, 200, await linkCall.clone().text());
    const after = await storedBody();
    assert.notEqual(after.hash, compiledBefore.hash, "the stored document follows the new type");
    const future = knowledgeGraphSelectResult.parse(await (await select({ definitionId: futureId, rootIds: [ids.$root.id] })).json());
    assert.equal(future.hash, after.hash, "select runs the stored document");
    assert.deepEqual(future.nodes.map(node => node.ref.id).sort(), [ids.$root.id, ids.$child.id, ids.$other.id].sort());
    assert.equal((await select({ definitionId: ids.$lens.id, rootIds: [crypto.randomUUID()] })).status, 404);
    assert.equal((await app.dispatch("", new Request(`${app.origin}${path}`, { method: "POST", body: JSON.stringify({ action: "knowledge-graph.render", input: { definitionId: ids.$lens.id, rootIds: [ids.$root.id], templates: [bare] } }) }))).status, 401);
  } finally { await app.dispose(); }
});
