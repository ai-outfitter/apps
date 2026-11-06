import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { wikiFixtureCall } from "@ai-outfitter/app-test/wiki-fixture";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { documents } from "../src/server/documents";

// StartWork: a Wiki story with its requirement and acceptance criteria becomes
// a Wiki Issue holding the templated request, one GitHub issue and (here, with no execution
// bindings) a blocked run. Real Wiki and Foundry workers; GitHub is a double.
test("StartWork stores the Wiki-templated issue, submits it once and links it to GitHub", { skip: !process.env.OUTFITTER_WIKI_PACKAGE && "Set OUTFITTER_WIKI_PACKAGE to a built Wiki operational package" }, async () => {
  const owner = { userId: "owner", organizationId: "org", role: "owner" };
  const wiki = await appWorker("wiki-map", process.env.OUTFITTER_WIKI_PACKAGE!);
  const issues: { title: string; body: string; marker: string }[] = [];
  const selections: unknown[] = [];
  const ok = (value: unknown) => ({ ok: true as const, value });
  const fixed: Record<string, unknown> = {
    snapshot: {
      installation: { id: "foundry", activeHash: "hash", hostname: "foundry.synthetic.localhost", workflows: [] },
      bindings: [], subscriptions: [],
      connections: [{ id: "github", provider: "github", revision: "r", owner: "organization", operations: ["issues.read", "issues.create"], repositories: ["acme/app"] }],
    },
    "workflow.references": [],
    "workflow.read": null,
    "organization.context": { organization: { id: "org", slug: "synthetic", name: "Synthetic", instructions: "", operational: true } },
  };
  // GitHub double: one issue per marker, as the connector's marker search converges.
  const createIssue = (call: { title: string; body: string; marker: string }) => {
    const prior = issues.findIndex((issue) => issue.marker === call.marker);
    if (prior < 0) issues.push(call);
    const number = prior < 0 ? issues.length : prior + 1;
    return ok({ number, url: `https://github.com/acme/app/issues/${number}`, state: "open", created: prior < 0 });
  };
  const app = await appWorker("software-foundry", appArtifact(new URL("..", import.meta.url), "operational"), "graph-work-foundry", {
    workflowHost: () => ({
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fixture dispatches the host operations under test.
      async call(operation, raw) {
        const input = raw as Record<string, unknown>;
        if (Object.hasOwn(fixed, operation)) return ok(fixed[operation]);
        if (operation === "repository.request")
          return ok(String(input.path).startsWith("/repos/acme/app/issues?") ? [] : { id: 1, full_name: "acme/app" });
        if (operation === "connector.execute") return createIssue(input.input as { title: string; body: string; marker: string });
        if (operation === "actions.call" && input.action === "knowledge-graph.render") selections.push(input.input);
        return wikiFixtureCall(wiki, owner, operation, raw);
      },
    }),
  });
  const scope = { organizationId: "org", installationId: app.installationId, userId: "owner", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 600000 };
  const entity = async (operation: string, input: object) => {
    const response = await wiki.call(`/api/internal/entities/v1/${operation}`, owner, { method: "POST", body: input });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as EntityRecord;
  };
  // The StartWork document through graph.mutate, as graph_mutate runs it; a refusal answers its status.
  type Started = {
    wikiIssue: { ref: EntityRecord["ref"] }; submissionId: string; issue: { number: number; url: string; created: boolean };
    run: unknown; execution?: { status: string }; gaps: string[];
  };
  const send = async (input: object) => {
    const response = await app.call("/api/internal/actions/v1/call", owner, {
      method: "POST", workflowHost: scope,
      body: { action: "graph.mutate", input: { query: documentText(documents.StartWork.document), operationName: "StartWork", variables: { input } } },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const { data, errors } = (await response.json()) as { data: { startWork: Started } | null; errors?: { message: string; extensions?: { status?: number } }[] };
    return { started: data?.startWork, error: errors?.[0] };
  };
  const status = async (input: object) => {
    const { error } = await send(input);
    return error ? (error.extensions?.status ?? 400) : 200;
  };
  const started = async (input: object) => {
    const { started, error } = await send(input);
    assert.ok(started, error?.message ?? "No result");
    return started;
  };
  try {
    const wikiInit = await wiki.call("/api/internal/app-initialize", owner, { method: "POST", body: {} });
    assert.equal(wikiInit.status, 200, await wikiInit.clone().text());
    const types: EntityRecord[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = (await (await wiki.call("/api/internal/entities/v1/list", owner, { method: "POST", body: { type: "graph-type", limit: 100, offset } })).json()) as EntityRecord[];
      types.push(...page);
      if (page.length < 100) break;
    }
    const typeId = (name: string) => {
      const type = types.find((row) => row.attributes.name === name);
      assert.ok(type, name);
      return type.ref.id;
    };
    const node = (name: string, title: string, extra: object = {}) =>
      entity("create", { type: "graph-node", attributes: { typeId: typeId(name), title, ...extra } });
    const edge = (name: string, from: EntityRecord, to: EntityRecord) =>
      entity("create", { type: "graph-edge", attributes: { typeId: typeId(name), fromId: from.ref.id, toId: to.ref.id } });
    const ref = (row: EntityRecord) => ({ ref: row.ref, revision: row.revision });


    const story = await node("UserStory", "Analysts export a filtered report", {
      body: JSON.stringify({ actor: "an analyst", capability: "to export the current selection", benefit: "I stop rebuilding it by hand" }),
    });
    const requirement = await node("Requirement", "Export only selected rows", {
      body: JSON.stringify({ statement: "Exports contain only the selected rows", rationale: "Analysts share exports", status: "approved" }),
    });
    const criterion = await node("AcceptanceCriterion", "Export matches selection", {
      body: JSON.stringify({ condition: "A filter is applied and Export is pressed", expectedOutcome: "The file contains exactly the filtered rows" }),
    });
    const bare = await node("UserStory", "A story without criteria", { body: JSON.stringify({ actor: "a viewer", capability: "to look", benefit: "I see" }) });
    await edge("has_requirement", story, requirement);
    await edge("has_acceptance_criterion", requirement, criterion);

    const start = (extra: object = {}) => ({ requestId: crypto.randomUUID(), target: { repository: "acme/app" }, root: ref(story), ...extra });

    // Refusals write nothing: no criteria, stale root, foreign root, ungranted repository, unknown project.
    const wikiIssues = async () => (await wiki.database.prepare("SELECT count(*) AS n FROM graph_nodes WHERE typeId=?").bind(typeId("Issue")).first()) as { n: number };
    const before = await wikiIssues();
    assert.equal(await status(start({ root: ref(bare) })), 422);
    assert.equal(await status(start({ root: { ...ref(story), revision: story.revision + 1 } })), 409);
    assert.equal(await status(start({ root: { ref: { ...story.ref, installationId: "foreign" }, revision: story.revision } })), 409);
    assert.ok(await status(start({ target: { repository: "acme/other" } })) >= 400);
    assert.equal(await status(start({ target: { project: crypto.randomUUID() } })), 409);
    assert.deepEqual(await wikiIssues(), before);
    assert.equal(issues.length, 0);

    const input = start();
    const result = await started(input);
    assert.equal(result.issue.number, 1);
    assert.equal(result.issue.created, true);
    assert.equal(result.run, null);
    assert.equal(result.execution?.status, "blocked", JSON.stringify(result.execution));
    const selected = selections.at(-1) as { definition: { id: string }; rootIds: string[]; templates: { name: string }[] };
    assert.equal(selected.definition.id, "foundry.feature-request");
    assert.deepEqual(selected.rootIds, [story.ref.id]);
    assert.equal(selected.templates[0].name, "Foundry feature request v1");

    // The Wiki stores the templated issue and links it to GitHub and the Foundry submission.
    const stored = await entity("get", { type: "graph-node", id: result.wikiIssue.ref.id });
    assert.equal(stored.attributes.typeId, typeId("Issue"));
    assert.equal(stored.title, story.title);
    assert.equal(stored.attributes.website, result.issue.url);
    assert.deepEqual(stored.references, [{ installationId: app.installationId, type: "work-submission", id: result.submissionId }]);
    const body = String(stored.attributes.body);
    assert.match(body, /No Problem is linked/);
    assert.match(body, /I want: to export the current selection/);
    assert.match(body, /Statement: Exports contain only the selected rows/);
    assert.match(body, /Expected outcome: The file contains exactly the filtered rows/);
    const scoped = await wiki.database.prepare("SELECT count(*) AS n FROM graph_edges WHERE typeId=? AND fromId=? AND toId=?")
      .bind(typeId("targets_requirement"), stored.ref.id, requirement.ref.id).first();
    assert.deepEqual(scoped, { n: 1 });

    // The GitHub issue carries the same text, the checklist and a link back to the Wiki Issue.
    assert.equal(issues.length, 1);
    assert.match(issues[0].body, /Statement: Exports contain only the selected rows/);
    assert.match(issues[0].body, /A filter is applied and Export is pressed → The file contains exactly the filtered rows/);
    assert.match(issues[0].body, new RegExp(stored.ref.id));

    // Retrying converges: same Wiki Issue, same GitHub issue, nothing new, even after the graph changed.
    await entity("update", { type: "graph-node", id: requirement.ref.id, revision: requirement.revision, attributes: { title: "Export selected rows only" } });
    const again = await started(input);
    assert.equal(again.wikiIssue.ref.id, result.wikiIssue.ref.id);
    assert.equal(again.issue.number, 1);
    assert.equal(issues.length, 1);
    assert.equal((await wikiIssues()).n, before.n + 1);
    assert.equal(await status({ ...input, title: "Different" }), 409, "different work under the same ID conflicts");

    // A Project root reaches the same criteria through its scope (UseCase comes with Planning's ontology).
    const project = await node("Project", "Exports");
    await edge("has_requirement", project, requirement);
    await started(start({ root: ref(project) }));
    assert.equal(issues.length, 2);
    // A Problem is not a work root.
    assert.equal(await status(start({ root: ref(await node("Problem", "Manual rework")) })), 409);
  } finally {
    await app.dispose();
    await wiki.dispose();
  }
});
