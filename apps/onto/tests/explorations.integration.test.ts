import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { print } from "graphql";
import { documents } from "../src/server/documents";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const path = "/api/internal/actions/v1/call";
// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

test("an exploration opens offerings, projects and competitors from an organization, and a patch changes what every reader sees", async (t) => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"));
  t.after(() => app.dispose());
  assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
  const action = async (name: string, input: object) => {
    const response = await app.call(path, owner, { method: "POST", body: { action: name, input } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<Json>;
  };
  const run = async (name: keyof typeof documents, variables: object) => {
    const document = documents[name].document as unknown;
    const query = typeof document === "string" ? document : print(document as Parameters<typeof print>[0]);
    return action(name === "MutateExploration" ? "graph.mutate" : "graph.graphql", { query, operationName: name, variables });
  };
  const { types } = await action("graph.read", {});
  const type = (name: string) => types.find((row: Json) => row.name === name)?.id as string;
  for (const name of ["Organization", "Offering", "Product", "Project", "offered_by", "packages_product", "produces", "alternative_for", "developed_by"])
    assert.ok(type(name), name);
  const node = (ref: string, typeName: string, title: string, slug: string) => ({ operation: "create", ref, type: "graph-node", attributes: { typeId: type(typeName), title, slug } });
  const edge = (ref: string, typeName: string, fromId: string, toId: string) => ({ operation: "create", ref, type: "graph-edge", attributes: { typeId: type(typeName), fromId, toId } });
  await action("graph.apply", { requestKey: "explore-fixture", operations: [
    node("$sunny", "Organization", "Sunny", "sunny"),
    node("$kit", "Offering", "Sunny kit", "sunny-kit"),
    node("$sensor", "Product", "SNY-1 sensor", "sny-1"),
    node("$firmware", "Project", "SNY-1 firmware", "sny-1-firmware"),
    node("$rival", "Organization", "Ecowitt", "ecowitt"),
    node("$rival-kit", "Product", "Ecowitt soil sensor", "ecowitt-soil"),
    edge("$e1", "offered_by", "$kit", "$sunny"),
    edge("$e2", "packages_product", "$kit", "$sensor"),
    edge("$e3", "produces", "$firmware", "$sensor"),
    edge("$e4", "alternative_for", "$rival-kit", "$kit"),
    edge("$e5", "developed_by", "$rival-kit", "$rival"),
  ] });

  const created = await run("MutateExploration", { input: { slug: "sunny-offerings", expectedRevision: 0, patch: {
    title: "Sunny offerings", start: { type: "Organization", slug: "sunny" },
    steps: { offerings: { from: "Organization:sunny", path: "offerings" }, projects: { from: "*offerings", path: "projects" } },
  } } });
  assert.equal(created.errors, undefined, JSON.stringify(created.errors));
  const first = created.data.mutateExploration;
  assert.equal(first.revision, 1);
  assert.deepEqual(first.picture.nodes.map((n: Json) => n.key).sort(), [
    "Offering:sunny-kit", "Organization:sunny", "Product:sny-1", "Project:sny-1-firmware",
  ]);
  assert.deepEqual(first.picture.steps.map((s: Json) => [s.key, s.count]), [["offerings", 1], ["projects", 1]]);
  assert.ok(first.picture.edges.some((e: Json) => e.from === "Project:sny-1-firmware" && e.label === "produces"));
  assert.equal(first.lastChange.summary, "Started from Organization sunny");

  // A stale revision is refused; the current one opens competitors and hides the product.
  const stale = await run("MutateExploration", { input: { slug: "sunny-offerings", expectedRevision: 0, patch: { title: "x" } } });
  assert.match(JSON.stringify(stale.errors), /revision 1/);
  const changed = (await run("MutateExploration", { input: { slug: "sunny-offerings", expectedRevision: 1, patch: {
    steps: { competitors: { from: "*offerings", path: "competitors" }, projects: null },
  } } })).data.mutateExploration;
  assert.equal(changed.revision, 2);
  assert.deepEqual(changed.lastChange.nodes.sort(), ["Organization:ecowitt", "Product:ecowitt-soil"]);
  assert.equal(changed.lastChange.summary, "Opened competitors, closed projects");
  assert.deepEqual(changed.picture.steps.map((s: Json) => [s.key, s.count]), [["offerings", 1], ["competitors", 1]]);

  // Every reader (the page, another agent) sees the same picture.
  const read = (await run("Exploration", { slug: "sunny-offerings" })).data.exploration;
  assert.equal(read.revision, 2);
  assert.deepEqual(read.picture.nodes.map((n: Json) => n.key).sort(), changed.picture.nodes.map((n: Json) => n.key).sort());
  const listed = (await run("Explorations", {})).data.explorations;
  assert.deepEqual(listed.map((e: Json) => e.slug), ["sunny-offerings"]);

  // Hiding a node drops it and stops steps from reaching through it; an unknown edge type is reported per step.
  const hidden = (await run("MutateExploration", { input: { slug: "sunny-offerings", expectedRevision: 2, patch: {
    hidden: { "Offering:sunny-kit": true }, steps: { odd: { from: "Organization:sunny", path: "no_such_edge" } },
  } } })).data.mutateExploration;
  assert.deepEqual(hidden.picture.nodes.map((n: Json) => n.key), ["Organization:sunny"]);
  assert.match(hidden.picture.steps.find((s: Json) => s.key === "odd").error, /no edge type no_such_edge/);

  // A dry run answers without saving.
  const dry = (await run("MutateExploration", { input: { slug: "sunny-offerings", expectedRevision: 3, dryRun: true, patch: { hidden: null } } })).data.mutateExploration;
  assert.equal(dry.revision, 3);
  assert.equal((await run("Exploration", { slug: "sunny-offerings" })).data.exploration.picture.nodes.length, 1);
});

test("pull requests open live from GitHub through a project's repositories, and without a host the step says why", async (t) => {
  const pulls = [
    { number: 12, title: "Read the CO2 sensor", url: "https://github.com/acme/sunny/pull/12", state: "OPEN", createdAt: "2026-11-01", updatedAt: "2026-11-07", closedAt: null, mergedAt: null },
    { number: 11, title: "Initial firmware", url: "https://github.com/acme/sunny/pull/11", state: "MERGED", createdAt: "2026-10-01", updatedAt: "2026-10-07", closedAt: "2026-10-07", mergedAt: "2026-10-07" },
  ];
  const requests: Json[] = [];
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"), "wiki-map-installation", {
    workflowHost: () => ({ call: async (operation, input) => {
      requests.push({ operation, input });
      if (operation === "snapshot") return { ok: true, value: {
        installation: { id: "wiki-map-installation", activeHash: "fixture", hostname: null, workflows: [] }, bindings: [], subscriptions: [],
        connections: [{ id: "github:user", provider: "github", revision: "user", owner: "user", operations: ["pulls.list"], repositories: [] }],
      } };
      if (operation === "repository.request") return { ok: true, value: { data: { repository: { pullRequests: { nodes: pulls, pageInfo: { endCursor: null, hasNextPage: false } } } } } };
      return { ok: false, status: 400, message: `Unexpected ${operation}` };
    } }),
  });
  t.after(() => app.dispose());
  const scope = { organizationId: "org", installationId: app.installationId, userId: "owner", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 600_000 };
  assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
  const action = async (name: string, input: object, hosted = true) => {
    const response = await app.call(path, owner, { method: "POST", body: { action: name, input }, ...(hosted ? { workflowHost: scope } : {}) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<Json>;
  };
  const { types } = await action("graph.read", {});
  const type = (name: string) => types.find((row: Json) => row.name === name)?.id as string;
  await action("graph.apply", { requestKey: "pulls-fixture", operations: [
    { operation: "create", ref: "$project", type: "graph-node", attributes: { typeId: type("Project"), title: "SNY-1 firmware", slug: "sny-1-firmware" } },
    { operation: "create", ref: "$repo", type: "graph-node", attributes: { typeId: type("Repository"), title: "acme/sunny", slug: "acme-sunny", website: "https://github.com/acme/sunny" } },
    { operation: "create", ref: "$code", type: "graph-edge", attributes: { typeId: type("source_in"), fromId: "$project", toId: "$repo" } },
  ] });
  const mutate = (input: object, hosted = true) => action("graph.mutate", { query: documents.MutateExploration.document as unknown as string, operationName: "MutateExploration", variables: { input } }, hosted);
  const opened = await mutate({ slug: "firmware", expectedRevision: 0, patch: {
    title: "Firmware", start: { type: "Project", slug: "sny-1-firmware" },
    steps: { prs: { from: "Project:sny-1-firmware", path: "pullRequests" } },
  } });
  assert.equal(opened.errors, undefined, JSON.stringify(opened.errors));
  const picture = opened.data.mutateExploration.picture;
  assert.deepEqual(picture.nodes.map((n: Json) => [n.key, n.url]), [
    ["Project:sny-1-firmware", null],
    ["Repository:acme-sunny", "https://github.com/acme/sunny"],
    ["github:acme/sunny#12", "https://github.com/acme/sunny/pull/12"],
  ]);
  assert.ok(picture.edges.some((e: Json) => e.from === "Repository:acme-sunny" && e.to === "github:acme/sunny#12"));
  assert.deepEqual((requests.find(r => r.operation === "repository.request")?.input.body.variables), { owner: "acme", name: "sunny", first: 50, after: null });
  // All states on request; and a read without a workflow host reports it on the step instead of failing.
  const all = await mutate({ slug: "firmware", expectedRevision: 1, patch: { steps: { prs: { state: "all" } } } });
  assert.equal(all.data.mutateExploration.picture.steps[0].count, 2);
  const unhosted = await action("graph.graphql", { query: documents.Exploration.document as unknown as string, variables: { slug: "firmware" } }, false);
  assert.match(unhosted.data.exploration.picture.steps[0].error, /GitHub/);
});

test("a competitor an agent stages shows as proposed beside the offering it competes with, until a member decides", async (t) => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"));
  t.after(() => app.dispose());
  assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
  const action = async (name: string, input: object) => {
    const response = await app.call(path, owner, { method: "POST", body: { action: name, input } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<Json>;
  };
  const run = (name: keyof typeof documents, variables: object) =>
    action(name === "Exploration" ? "graph.graphql" : "graph.mutate", { query: documents[name].document as unknown as string, operationName: name, variables });
  const { types } = await action("graph.read", {});
  const type = (name: string) => types.find((row: Json) => row.name === name)?.id as string;
  await action("graph.apply", { requestKey: "proposal-fixture", operations: [
    { operation: "create", ref: "$sunny", type: "graph-node", attributes: { typeId: type("Organization"), title: "Sunny", slug: "sunny" } },
    { operation: "create", ref: "$kit", type: "graph-node", attributes: { typeId: type("Offering"), title: "Sunny kit", slug: "sunny-kit" } },
    { operation: "create", ref: "$e", type: "graph-edge", attributes: { typeId: type("offered_by"), fromId: "$kit", toId: "$sunny" } },
  ] });
  await run("MutateExploration", { input: { slug: "sunny", expectedRevision: 0, patch: {
    title: "Sunny", start: { type: "Organization", slug: "sunny" }, steps: { offerings: { from: "Organization:sunny", path: "offerings" } },
  } } });
  const staged = await run("StageChanges", { input: { title: "Competitors", proposals: [
    { operation: { operation: "create", ref: "$rival", type: "graph-node", attributes: { typeId: "Product", title: "Ecowitt soil sensor" } }, reason: "Sold to the same gardeners." },
    { operation: { operation: "create", ref: "$alt", type: "graph-edge", attributes: { typeId: "alternative_for", fromId: "$rival", toId: "sunny-kit" } }, reason: "Same use." },
  ] } });
  assert.equal(staged.errors, undefined, JSON.stringify(staged.errors));
  const batchId = staged.data.stageChanges.id;
  const read = async () => (await run("Exploration", { slug: "sunny" })).data.exploration;
  const before = await read();
  assert.equal(before.revision, 1, "staging changes no exploration revision");
  const proposed = before.picture.nodes.find((n: Json) => n.proposedIn);
  assert.deepEqual(proposed && { key: proposed.key, title: proposed.title, type: proposed.type, proposedIn: proposed.proposedIn },
    { key: `proposed:${batchId}/rival`, title: "Ecowitt soil sensor", type: "Product", proposedIn: batchId });
  assert.ok(before.picture.edges.some((e: Json) => e.from === proposed.key && e.to === "Offering:sunny-kit" && e.label === "alternative_for"));
  // Discarded proposals disappear.
  await app.database.prepare("UPDATE graph_batches SET state='discarded' WHERE id=?").bind(batchId).run();
  assert.equal((await read()).picture.nodes.some((n: Json) => n.proposedIn), false);
});
