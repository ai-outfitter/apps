import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import { packageDigest } from "../src/server/work-packages";
const id = (n: number) =>
  `31000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const record = (
  type: string,
  n: number,
  attributes: EntityRecord["attributes"],
  references: EntityRecord["references"] = [],
): EntityRecord => ({
  ref: { installationId: "wiki", type, id: id(n) },
  revision: 1,
  title: String(attributes.title ?? attributes.name ?? n),
  attributes,
  references,
});

test("Planning context and preview preserve selected criterion revisions without writes, reject foreign scope, and bind content", async () => {
  const types = [
    "Project",
    "Requirement",
    "AcceptanceCriterion",
    "ArtifactDefinition",
    "KnowledgeGraph",
    "has_requirement",
    "has_acceptance_criterion",
    "artifact_for",
    "uses_view",
  ].map((name, i) =>
    record("graph-type", 100 + i, { name, category: i < 5 ? "node" : "edge" }),
  );
  let nodes: EntityRecord[] = [],
    edges: EntityRecord[] = [];
  const calls: string[] = [];
  let raceId: string | undefined;
  let extraScopeEdge: EntityRecord | undefined;
  let omittedScopeId: string | undefined;
  let racePlanning: (() => Promise<void>) | undefined;
  const owner = { userId: "owner", organizationId: "org", role: "owner" };
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "planning-packages",
    {
      workflowHost: () => ({
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Fixture host dispatches the five public operations under test.
        async call(op, input) {
          calls.push(op);
          const v = input as Record<string, unknown>;
          if (op === "entities.types")
            return {
              ok: true,
              value: ["graph-type", "graph-node", "graph-edge"].map((type) => ({
                installationId: "wiki",
                type,
                title: type,
                description: "test",
                schema: {},
                writable: true,
              })),
            };
          if (op === "entities.list")
            return {
              ok: true,
              value: (
                {
                  "graph-type": types,
                  "graph-node": nodes,
                  "graph-edge": edges,
                }[String(v.type)] ?? []
              ).slice(
                Number(v.offset ?? 0),
                Number(v.offset ?? 0) + Number(v.limit ?? 100),
              ),
            };
          if (op === "entities.get") {
            const row = [...nodes, ...edges, ...types].find(
              (n) => n.ref.id === v.id,
            );
            return row
              ? { ok: true, value: row }
              : { ok: false, status: 404, message: "Missing" };
          }
          if (op === "actions.call") {
            calls.push(String(v.action));
            if (v.action === "graph.read" || v.action === "graph.query") {
              const graphRecord = (row: EntityRecord) => ({
                id: row.ref.id,
                revision: row.revision,
                title: row.title,
                ...row.attributes,
                ...(row.references[0] ? { source: row.references[0] } : {}),
              });
              const snapshot = {
                version: 1 as const,
                installationId: "wiki",
                types: types.map(graphRecord),
                nodes: nodes
                  .filter((row) => !row.attributes.archived)
                  .map(graphRecord),
                edges: edges.map(graphRecord),
                selection: null,
                truncated: false,
                missingTypes: [],
              };
              if (v.action === "graph.read") return { ok: true, value: snapshot };
              // The Wiki answers graph.query with the SDK's own engine over its graph,
              // and a refusal (such as a record over the byte bound) as its status.
              try {
                return { ok: true, value: await queryGraph(snapshot as never, v.input as never) };
              } catch (error) {
                if (!(error instanceof Response)) throw error;
                return { ok: false, status: error.status, message: await error.text() };
              }
            }
            if (racePlanning) {
              const mutate = racePlanning;
              racePlanning = undefined;
              await mutate();
            }
            const args = v.input as {
              selectedNodeIds?: string[];
              provenance?: {
                nodeIds: string[];
                relationships: { fromId: string; typeId: string }[];
              };
            };
            const visibleNodes = nodes.filter(
              (n) =>
                ![id(4), id(5), id(8)].includes(n.ref.id) &&
                args.selectedNodeIds?.includes(n.ref.id),
            );
            const provenanceRows = [
              ...nodes.filter((n) =>
                args.provenance?.nodeIds.includes(n.ref.id),
              ),
              ...[...edges, ...(extraScopeEdge ? [extraScopeEdge] : [])].filter(
                (e) =>
                  e.ref.id !== omittedScopeId &&
                  args.provenance?.relationships.some(
                    (query) =>
                      query.fromId === e.attributes.fromId &&
                      query.typeId === e.attributes.typeId,
                  ),
              ),
            ];
            const sources = [
              ...new Map(
                [
                  ...visibleNodes,
                  ...nodes.filter((n) => [id(4), id(5)].includes(n.ref.id)),
                  ...edges.filter(
                    (e) =>
                      [id(4), ...(args.selectedNodeIds ?? [])].includes(
                        String(e.attributes.fromId),
                      ) &&
                      [id(4), id(5), ...(args.selectedNodeIds ?? [])].includes(
                        String(e.attributes.toId),
                      ),
                  ),
                  ...types,
                  ...provenanceRows,
                ].map((row) => [`${row.ref.type}/${row.ref.id}`, row]),
              ).values(),
            ].map((row) =>
              row.ref.id === raceId
                ? { ...row, revision: row.revision + 1 }
                : row,
            );
            return {
              ok: true,
              value: {
                title: "Implementation brief",
                description:
                  "# Implementation brief\n\nDefinition status: proposed.",
                nodes: visibleNodes.map((n) => ({
                  id: n.ref.id,
                  revision: n.revision,
                })),
                lens: { id: id(5), revision: 1 },
                manifest: { sources },
                provenance: provenanceRows.map((row) => ({
                  type: row.ref.type,
                  id: row.ref.id,
                  revision: row.revision,
                })),
                gaps: [],
              },
            };
          }
          return { ok: false, status: 403, message: "Unexpected mutation" };
        },
      }),
    },
  );
  const scope = {
    installationId: app.installationId,
    organizationId: "org",
    userId: "owner",
    packageHash: "test",
    phase: "interactive" as const,
    expiresAt: Date.now() + 600000,
  };
  const call = (path: string, body?: object) =>
    app.call(path, owner, {
      ...(body ? { method: "POST", body } : {}),
      workflowHost: scope,
    });
  try {
    const project = (await (
      await call("/api/apps/planning/projects", {
        name: "Useful work",
        goals: "Ship a bounded change",
      })
    ).json()) as { id: string };
    nodes = [
      record("graph-node", 1, { typeId: id(100), title: "Project context" }, [
        { installationId: app.installationId, type: "project", id: project.id },
      ]),
      record("graph-node", 2, {
        typeId: id(101),
        title: "Render context",
        body: JSON.stringify({
          statement: "Render selected context",
          status: "proposed",
        }),
      }),
      record("graph-node", 3, {
        typeId: id(102),
        title: "Criterion",
        body: JSON.stringify({
          condition: "Preview work",
          expectedOutcome: "Only selected context appears",
        }),
      }),
      record("graph-node", 4, { typeId: id(103), title: "Brief recipe" }),
      record("graph-node", 5, { typeId: id(104), title: "Project lens" }),
      record("graph-node", 6, {
        typeId: id(101),
        title: "Unrelated requirement",
      }),
    ];
    types.push(
      ...[
        "Issue",
        "targets_requirement",
        "has_issue",
        "Problem",
        "addresses",
      ].map((name, i) =>
        record("graph-type", 109 + i, {
          name,
          category: [0, 3].includes(i) ? "node" : "edge",
        }),
      ),
    );
    nodes.push(
      record("graph-node", 7, {
        typeId: id(112),
        title: "Only supports unselected work",
      }),
    );
    edges = [
      record("graph-edge", 10, { typeId: id(105), fromId: id(1), toId: id(2) }),
      record("graph-edge", 11, { typeId: id(106), fromId: id(2), toId: id(3) }),
      record("graph-edge", 12, { typeId: id(107), fromId: id(4), toId: id(1) }),
      record("graph-edge", 13, { typeId: id(108), fromId: id(4), toId: id(5) }),
      record("graph-edge", 14, { typeId: id(105), fromId: id(1), toId: id(6) }),
      record("graph-edge", 15, { typeId: id(113), fromId: id(6), toId: id(7) }),
    ];
    const contextResponse = await call(`/api/apps/planning/work-context?projectId=${project.id}`);
    assert.equal(
      contextResponse.status,
      200,
      await contextResponse.clone().text(),
    );
    const context = (await contextResponse.json()) as {
      requirements: EntityRecord[];
      criteria: EntityRecord[];
    };
    assert.deepEqual(
      context.requirements.map((r) => r.ref.id),
      [id(2), id(6)],
    );
    assert.equal(context.criteria[0].ref.id, id(3));
    const input = {
      projectId: project.id,
      requirementIds: [id(2)],
      definitionId: id(4),
    };
    const response = await call("/api/apps/planning/work", {
      action: "work.preview",
      input,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()) as {
      description: string;
      digest: string;
      criteria: { revision: number }[];
      workPackage: Record<string, unknown>;
      manifest: { sources: EntityRecord[] };
    };
    assert.match(result.description, /Only selected context appears/);
    assert.doesNotMatch(result.description, /Unrelated requirement/);
    assert.doesNotMatch(result.description, /app.internal/);
    assert.match(
      result.description,
      /entity reference:/,
      "null hostname uses canonical references, not internal dispatch URLs",
    );
    assert.equal(result.criteria[0].revision, 1);
    assert.ok(
      !result.manifest.sources.some((s) => s.ref.id === id(7)),
      "unselected requirement support must not leak",
    );
    assert.equal(
      calls.filter((op) => op === "artifact.preview").length,
      1,
      "preview renders Wiki exactly once",
    );
    for (const changing of [id(4), id(10)]) {
      raceId = changing;
      assert.equal(
        (await call("/api/apps/planning/work-context", input)).status,
        409,
      );
    }
    raceId = id(5);
    assert.equal(
      (await call("/api/apps/planning/work-context", input)).status,
      409,
      "lens changes are checked against the full initial graph",
    );
    raceId = undefined;
    const issue = (await (
      await call("/api/apps/planning/issues", {
        projectId: project.id,
        title: "Bounded issue",
        category: "stone",
      })
    ).json()) as { id: string };
    assert.equal(
      (
        await call("/api/apps/planning/work-context", {
          ...input,
          issueId: issue.id,
        })
      ).status,
      409,
      "unsourced issue scope must be linked explicitly",
    );
    nodes.push(
      record("graph-node", 8, { typeId: id(109), title: "Bounded issue" }, [
        { installationId: app.installationId, type: "issue", id: issue.id },
      ]),
    );
    edges.push(
      record("graph-edge", 16, { typeId: id(111), fromId: id(1), toId: id(8) }),
      record("graph-edge", 17, { typeId: id(110), fromId: id(8), toId: id(2) }),
    );
    assert.equal(
      (
        await call("/api/apps/planning/work-context", {
          ...input,
          issueId: issue.id,
          requirementIds: [id(6)],
        })
      ).status,
      409,
      "explicit issue scope cannot override targets",
    );
    assert.equal(
      (
        await call("/api/apps/planning/work-context", {
          ...input,
          issueId: issue.id,
        })
      ).status,
      200,
    );
    for (const criticalScopeId of [id(8), id(17), id(11)]) {
      raceId = criticalScopeId;
      assert.equal(
        (
          await call("/api/apps/planning/work-context", {
            ...input,
            issueId: issue.id,
          })
        ).status,
        409,
      );
    }
    raceId = undefined;
    omittedScopeId = id(17);
    assert.equal(
      (
        await call("/api/apps/planning/work-context", {
          ...input,
          issueId: issue.id,
        })
      ).status,
      409,
    );
    omittedScopeId = undefined;
    extraScopeEdge = record("graph-edge", 18, {
      typeId: id(110),
      fromId: id(8),
      toId: id(6),
    });
    assert.equal(
      (
        await call("/api/apps/planning/work-context", {
          ...input,
          issueId: issue.id,
        })
      ).status,
      409,
      "concurrent new scope edge changes complete provenance set",
    );
    extraScopeEdge = undefined;
    nodes.push(
      record("graph-node", 9, { typeId: id(109), title: "Ambiguous issue" }, [
        { installationId: app.installationId, type: "issue", id: issue.id },
      ]),
    );
    assert.equal(
      (
        await call("/api/apps/planning/work-context", {
          ...input,
          issueId: issue.id,
        })
      ).status,
      409,
      "ambiguous Wiki Issue sources outside the project view are rejected",
    );
    nodes = nodes.filter((n) => n.ref.id !== id(9));
    edges = edges.filter((e) => e.ref.id !== id(19));
    types.push(
      record("graph-type", 114, { name: "UseCase", category: "node" }),
      record("graph-type", 115, { name: "has_use_case", category: "edge" }),
    );
    nodes.push(
      record("graph-node", 20, {
        typeId: id(114),
        title: "Supporting use case",
      }),
      record("graph-node", 21, {
        typeId: id(102),
        title: "Unselected supporting criterion",
        body: JSON.stringify({
          condition: "Supporting only",
          expectedOutcome: "Not part of scope",
        }),
      }),
    );
    edges.push(
      record("graph-edge", 22, {
        typeId: id(115),
        fromId: id(1),
        toId: id(20),
      }),
      record("graph-edge", 23, {
        typeId: id(106),
        fromId: id(20),
        toId: id(21),
      }),
    );
    const supportPreview = (await (
      await call("/api/apps/planning/work-context", input)
    ).json()) as typeof result;
    assert.ok(
      !supportPreview.manifest.sources.some((row) => row.ref.id === id(21)),
      "supporting criteria outside selected requirements never enter the rendered manifest",
    );
    const requirement = nodes.find((n) => n.ref.id === id(2))!;
    const originalBody = requirement.attributes.body;
    requirement.attributes.body = JSON.stringify({
      statement: "Retired",
      status: "retired",
    });
    assert.equal(
      (await call("/api/apps/planning/work-context", input)).status,
      409,
    );
    requirement.attributes.body = originalBody;
    assert.equal(
      (
        await call("/api/apps/planning/work-context", {
          ...input,
          projectId: "invalid",
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("/api/apps/planning/work-context?projectId=invalid")).status,
      400,
    );
    const { digest, ...binding } = result.workPackage;
    assert.equal(digest, await packageDigest(binding));
    assert.ok(result.manifest.sources.some((n) => n.ref.id === id(5)));
    assert.equal(
      (
        await call("/api/apps/planning/work-context", {
          ...input,
          requirementIds: [id(999)],
        })
      ).status,
      409,
    );
    assert.equal(
      (await call("/api/apps/planning/work-context", { projectId: project.id }))
        .status,
      409,
    );
    nodes.find((n) => n.ref.id === id(3))!.revision = 2;
    const changed = (await (
      await call("/api/apps/planning/work-context", input)
    ).json()) as { digest: string };
    assert.notEqual(changed.digest, result.digest);
    racePlanning = async () => {
      const edited = await app.call(
        `/api/apps/planning/projects/${project.id}`,
        owner,
        {
          method: "PUT",
          body: { revision: 1, name: "Changed while previewing" },
        },
      );
      assert.equal(edited.status, 200);
    };
    assert.equal(
      (await call("/api/apps/planning/work-context", input)).status,
      409,
      "changed canonical project revision rejects mixed package",
    );
    const criterionLink = edges.find((e) => e.ref.id === id(11))!;
    const archivedCriterion = record("graph-node", 24, {
      typeId: id(102),
      title: "Archived criterion",
      archived: true,
    });
    nodes.push(archivedCriterion);
    const archivedLink = record("graph-edge", 25, {
      typeId: id(106),
      fromId: id(2),
      toId: id(24),
    });
    edges.push(archivedLink);
    assert.equal(
      (await call("/api/apps/planning/work-context", input)).status,
      200,
      "active provenance edges to archived nodes do not cause false conflicts",
    );
    edges = edges.filter((e) => e.ref.id !== id(11));
    extraScopeEdge = criterionLink;
    assert.equal(
      (await call("/api/apps/planning/work-context", input)).status,
      409,
      "criterion type selector exists even without any initial criterion edge",
    );
    extraScopeEdge = undefined;
    edges.push(criterionLink);
    const foreignRequirement = record("graph-node", 26, {
      typeId: id(101),
      title: "Outside project scope",
      body: JSON.stringify({ statement: "Other project", status: "proposed" }),
    });
    nodes.push(foreignRequirement);
    edges.push(
      record("graph-edge", 27, {
        typeId: id(110),
        fromId: id(8),
        toId: id(26),
      }),
    );
    assert.equal(
      (
        await call("/api/apps/planning/work-context", {
          ...input,
          issueId: issue.id,
        })
      ).status,
      409,
      "foreign issue targets reject explicitly instead of importing foreign requirements",
    );
    edges = edges.filter((e) => e.ref.id !== id(27));
    for (let i = 200; i < 410; i++) {
      nodes.push(
        record(
          "graph-node",
          i,
          { typeId: id(109), title: `Execution history ${i}` },
          [
            {
              installationId: app.installationId,
              type: "work-submission",
              id: id(1000 + i),
            },
          ],
        ),
      );
      edges.push(
        record("graph-edge", 2000 + i, {
          typeId: id(111),
          fromId: id(1),
          toId: id(i),
        }),
      );
    }
    assert.equal(
      (await call("/api/apps/planning/work-context", input)).status,
      200,
      "210 execution projections do not consume bounded project context",
    );
    const originalSummary = requirement.attributes.summary;
    requirement.attributes.summary = "😀".repeat(150000);
    assert.equal(
      (await call(`/api/apps/planning/work-context?projectId=${project.id}`))
        .status,
      413,
    );
    requirement.attributes.summary = originalSummary;
    assert.ok(
      calls.every((op) => !["entities.create", "entities.update"].includes(op)),
      "read paths never initialize or modify Wiki",
    );
  } finally {
    await app.dispose();
  }
});
