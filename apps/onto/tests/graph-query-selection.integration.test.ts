// graph.query as an app reads one project's context: roots by canonical `source` or by
// stored properties, expanded with an inline selection that keeps to the context types
// (`nodeTypes`), stops at shared context and follows `part_of` only from a Project to a
// product. Planning's project-context.ts runs this selection; its rules are
// project-readiness.ts's.
import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { graphQueryResult } from "@ai-outfitter/app-sdk/graph-query";
import { core } from "../src/lib/graph";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const path = "/api/internal/actions/v1/call";
const planning = "planning-installation";
const productTypes = ["Product", "SoftwareProduct"];
const selection = {
  rootTypes: ["Project", "UseCase", "UserStory"],
  relationships: [
    "has_use_case", "has_story", "has_requirement", "has_acceptance_criterion", "addresses", "pursues", "experiences", "produces", "measured_by",
    ...productTypes.map((product) => ({ type: "part_of", direction: "outgoing" as const, from_type: "Project", to_type: product })),
    { type: "experiences", direction: "incoming" as const, from_type: "CustomerSegment", to_type: "Problem" },
  ],
  nodeTypes: ["Problem", "Goal", "MetricDefinition", "CustomerSegment", "UserStory", "UseCase", "Requirement", "AcceptanceCriterion", ...productTypes],
  terminalTypes: [...productTypes, "Goal", "MetricDefinition", "CustomerSegment"],
  // A selected problem shows the customer segments that experience it (the incoming
  // experiences rule) and nothing beyond them.
  stopAfterTypes: ["Problem"],
  maxDepth: 6,
  maxNodes: 500,
};

test("graph.query finds pages by source and properties and keeps an inline selection to its node types", async () => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
    const create = (ref: string, type: string, attributes: object) => ({ operation: "create", ref, type, attributes });
    // The standard seed already holds these types; only UseCase (with Planning's link properties) is this fixture's own.
    const seeded = {
      Project: core.project, Problem: core.problem, CustomerSegment: core.customerSegment, Product: core.product, Organization: core.organization,
      UserStory: "199e5077-b65f-4c56-a672-06dd6ebe999d", has_story: "d8b2e79c-6454-4fde-8b9e-117f3bf2856e", has_use_case: "059e57b9-3d99-4b62-8489-c45ae0f8831f",
      addresses: core.addresses, experiences: core.experiences, part_of: "71000000-0000-4000-8000-000000000032",
    } as const;
    const story = JSON.stringify({ actor: "a member", capability: "do the thing", benefit: "so that it is done" });
    const typeOf = (name: keyof typeof seeded | "UseCase") => (name === "UseCase" ? "$UseCase" : seeded[name]);
    const node = (ref: string, type: keyof typeof seeded | "UseCase", attributes: object) => create(ref, "graph-node", { typeId: typeOf(type), ...attributes });
    const edge = (ref: string, type: keyof typeof seeded, from: string, to: string) => create(ref, "graph-edge", { typeId: typeOf(type), fromId: from, toId: to });
    const response = await app.call(path, owner, { method: "POST", body: { action: "graph.apply", input: {
      requestKey: "graph-context-fixture", operations: [
        create("$UseCase", "graph-type", { category: "node", name: "UseCase", title: "Use case", body: "A fixture use case type.", properties: [
          { name: "planning_installation_id", type: "string", description: "The Planning installation of the named project.", required: false },
          { name: "project_id", type: "string", description: "The Planning project this use case belongs to.", required: false },
        ] }),
        node("$anchor", "Project", { title: "Anchor project", slug: "anchor-project" }),
        node("$useCase", "UseCase", { title: "Linked use case", summary: "Reached by has_use_case." }),
        node("$story", "UserStory", { title: "Linked story", body: story }),
        node("$retired", "UseCase", { title: "Retired use case", body: JSON.stringify({ status: "retired" }) }),
        node("$problem", "Problem", { title: "Shared problem" }),
        node("$segment", "CustomerSegment", { title: "Segment that experiences the problem" }),
        node("$farStory", "UserStory", { title: "Another project's story", body: story }),
        node("$product", "Product", { title: "Product the anchor is part of" }),
        node("$organization", "Organization", { title: "Fixture organization" }),
        node("$explicit", "UseCase", { title: "Explicitly linked use case", properties: { planning_installation_id: planning, project_id: "p1" } }),
        node("$otherAnchor", "Project", { title: "Other project", slug: "other-project" }),
        edge("$e1", "has_use_case", "$anchor", "$useCase"),
        edge("$e2", "has_story", "$useCase", "$story"),
        edge("$e3", "has_use_case", "$anchor", "$retired"),
        edge("$e4", "addresses", "$useCase", "$problem"),
        edge("$e5", "experiences", "$segment", "$problem"),
        // The problem is shared context: the other project's story behind it is never borrowed.
        edge("$e6", "addresses", "$farStory", "$problem"),
        edge("$e7", "has_story", "$otherAnchor", "$farStory"),
        edge("$e8", "part_of", "$anchor", "$product"),
        edge("$e9", "part_of", "$useCase", "$organization"),
      ],
    } } });
    assert.equal(response.status, 200, await response.clone().text());
    const ids = await response.json() as Record<string, { id: string }>;
    const source = (projectId: string) => JSON.stringify({ installationId: planning, type: "project", id: projectId });
    for (const [ref, projectId] of [["$anchor", "p1"], ["$otherAnchor", "p2"]] as const)
      await app.database.prepare("UPDATE graph_nodes SET source=? WHERE id=?").bind(source(projectId), ids[ref].id).run();

    const read = await app.call(path, owner, { method: "POST", body: { action: "graph.query", access: "read", input: { maxBytes: 256 * 1024, queries: [
      { name: "anchors", entity: "node", sources: [{ installationId: planning, type: "project", id: "p1" }], expand: selection, fields: ["title", "summary", "slug"], limit: 10 },
      { name: "explicit", entity: "node", types: ["UseCase", "UserStory"], properties: { planning_installation_id: planning, project_id: "p1" }, expand: selection, fields: ["title", "summary", "slug"], limit: 100 },
      { name: "other", entity: "node", sources: [{ installationId: planning, type: "project", id: "p2" }], expand: selection, fields: ["title", "summary", "slug"], limit: 10 },
      { name: "missing", entity: "node", sources: [{ installationId: planning, type: "project", id: "nope" }], expand: selection, fields: ["title", "summary", "slug"], limit: 10 },
    ] } } });
    assert.equal(read.status, 200, await read.clone().text());
    const result = graphQueryResult.parse(await read.json());
    assert.ok(Object.values(result.queries).every((query) => query.cursor === null && query.omitted.length === 0), "no query hit a bound");
    const titles = new Map(result.nodes.map((row) => [String(row.id), String(row.title)]));
    const title = (id: string) => titles.get(id) ?? "";
    // related names edges too; only the nodes have titles.
    const reached = (name: string) => [...result.queries[name].matches, ...result.queries[name].related].map(title).filter(Boolean).sort((a, b) => a.localeCompare(b));

    assert.deepEqual(result.queries.anchors.matches.map(title), ["Anchor project"]);
    assert.deepEqual(reached("anchors"), ["Anchor project", "Linked story", "Linked use case", "Product the anchor is part of", "Segment that experiences the problem", "Shared problem"],
      "the retired use case, the organization behind part_of and the other project's story stay out");
    assert.deepEqual(reached("explicit"), ["Explicitly linked use case"]);
    // The other project shares the problem, so it too shows the segment that experiences it.
    assert.deepEqual(reached("other"), ["Another project's story", "Other project", "Segment that experiences the problem", "Shared problem"]);
    assert.deepEqual(result.queries.missing.matches, []);
    assert.equal(result.nodes.find((row) => row.id === ids.$anchor.id)?.slug, "anchor-project");

    const indexes = await app.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('graph_edges_out','graph_edges_in','graph_nodes_type_slug')").all();
    assert.equal(indexes.results.length, 3, "the typed hop indexes are installed");
  } finally {
    await app.dispose();
  }
});
