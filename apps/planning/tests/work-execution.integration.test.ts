import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";

const id = (n: number) =>
  `32000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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

// Planning runs its real published action dispatcher and installation D1. The
// host fixtures model the public Wiki/Foundry/Governance contracts; Governance's
// real exact-decision path has its own Worker integration coverage.
test("Planning freezes, recovers submission, evaluates exact evidence and accepts only the governed candidate", async () => {
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
    "DecisionControl",
    "Issue",
    "has_issue",
    "targets_requirement",
  ].map((name, index) =>
    record("graph-type", 100 + index, {
      name,
      category: index < 5 || index === 9 || index === 10 ? "node" : "edge",
    }),
  );
  let nodes: EntityRecord[] = [],
    edges: EntityRecord[] = [];
  const owner = { userId: "owner", organizationId: "org", role: "owner" };
  const commit = "a".repeat(40),
    submissionId = "b".repeat(64);
  let externalCreated = 0,
    lostResponse = true,
    merged = true,
    approved = false,
    policyRevision = 2;
  let imageRevision = commit,
    imageHash = "1".repeat(64),
    policyTitle = "Original holder",
    policyNodeRevision = 1;
  let providerDenied = false,
    inProgress = false,
    malformed = false,
    submitCalls = 0,
    reviewRace = false,
    reviewRouted = false;
  let submitted = false,
    frozenWorkPackage: unknown,
    savedReview: Record<string, unknown> | undefined;
  const policy = () => ({
    controlRef: { installationId: "wiki", type: "graph-node", id: id(20) },
    controlRevision: policyRevision,
    accountableAssignment: {
      holderTitle: policyTitle,
      holder: {
        installationId: "wiki",
        type: "graph-node",
        id: id(22),
        revision: policyNodeRevision,
      },
      assignment: {
        installationId: "wiki",
        type: "graph-node",
        id: id(21),
        revision: 1,
      },
    },
    requiredReviewers: [],
  });
  const results = () => ({
    submissionId,
    workPackage: frozenWorkPackage,
    repository: "example/product",
    issue: inProgress
      ? null
      : { number: 12, url: "https://forge.example/issues/12" },
    run: { id: "run", status: "complete" },
    pullRequests: [
      {
        number: 13,
        url: "https://forge.example/pulls/13",
        repository: "example/product",
        headSha: commit,
        mergeSha: merged ? "c".repeat(40) : null,
        merged,
        state: merged ? "closed" : "open",
        reviews: malformed
          ? {}
          : [{ id: 55, commit_id: commit, state: "DISMISSED" }],
        checks: {
          check_runs: [
            { head_sha: commit, status: "completed", conclusion: "success" },
            {
              id: 45,
              head_sha: commit,
              status: "completed",
              conclusion: "failure",
            },
            {
              id: 44,
              head_sha: commit,
              status: "completed",
              conclusion: "success",
              html_url: "https://forge.example/checks/44",
            },
          ],
        },
      },
    ],
    evidence: {
      receipts: [],
      images: [
        {
          id: "image-1",
          name: "Preview",
          revision: imageRevision,
          sha256: imageHash,
          url: "https://evidence.example/image-1",
        },
      ],
    },
    blockers: [],
  });
  const ok = (value: unknown) => ({ ok: true as const, value });
  const missing = () => ({
    ok: false as const,
    status: 404,
    message: "Not found",
  });
  const calls: string[] = [];
  let graphWrites = 0;
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "planning-execution",
    {
      workflowHost: () => ({
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Fixture dispatches scoped public app contracts and explicitly models lost responses.
        async call(operation, raw) {
          const input = raw as Record<string, unknown>;
          if (operation === "entities.types")
            return ok(
              ["graph-type", "graph-node", "graph-edge"].map((type) => ({
                installationId: "wiki",
                type,
                title: type,
                description: "fixture",
                schema: {},
                writable: true,
              })),
            );
          if (operation === "entities.list")
            return ok(
              (
                {
                  "graph-type": types,
                  "graph-node": nodes,
                  "graph-edge": edges,
                }[String(input.type)] ?? []
              ).slice(
                Number(input.offset ?? 0),
                Number(input.offset ?? 0) + Number(input.limit ?? 100),
              ),
            );
          if (operation === "entities.get") {
            const found = [...types, ...nodes, ...edges].find(
              (record) => record.ref.id === input.id,
            );
            return found ? ok(found) : missing();
          }
          if (operation === "entities.create") {
            graphWrites++;
            const attributes = input.attributes as EntityRecord["attributes"];
            const rows = input.type === "graph-node" ? nodes : edges;
            if (rows.some((row) => row.ref.id === attributes.id))
              return { ok: false, status: 409, message: "Duplicate" };
            const created: EntityRecord = {
              ref: {
                installationId: "wiki",
                type: String(input.type),
                id: String(attributes.id),
              },
              revision: 1,
              title: String(attributes.title ?? ""),
              attributes,
              references: (input.references ??
                []) as EntityRecord["references"],
            };
            rows.push(created);
            return ok(created);
          }
          if (operation === "entities.update") {
            graphWrites++;
            const current = [...nodes, ...edges].find(
              (row) => row.ref.id === input.id,
            );
            if (!current || current.revision !== input.revision)
              return { ok: false, status: 409, message: "Changed" };
            Object.assign(current.attributes, input.attributes);
            current.revision++;
            return ok(current);
          }
          if (operation === "actions.list")
            return ok([
              {
                installationId: "foundry",
                actions: [
                  {
                    name: "work.targets",
                    description: "targets",
                    access: "read",
                    permitted: true,
                    input: {},
                    output: {},
                  },
                ],
              },
              {
                installationId: "governance",
                actions: [
                  {
                    name: "governance.work-policy",
                    description: "policy",
                    access: "read",
                    permitted: true,
                    input: {},
                    output: {},
                  },
                ],
              },
            ]);
          if (operation !== "actions.call")
            throw new Error(`Unexpected host operation ${operation}`);
          const action = String(input.action),
            value = input.input as Record<string, unknown>;
          calls.push(action);
          if (action === "graph.read") {
            const graphRecord = (row: EntityRecord) => ({
              id: row.ref.id,
              revision: row.revision,
              title: row.title,
              ...row.attributes,
              ...(row.references[0] ? { source: row.references[0] } : {}),
            });
            return {
              ok: true,
              value: {
                version: 1,
                installationId: "wiki",
                types: types.map(graphRecord),
                nodes: nodes
                  .filter((row) => !row.attributes.archived)
                  .map(graphRecord),
                edges: edges.map(graphRecord),
                selection: null,
                truncated: false,
                missingTypes: [],
              },
            };
          }
          if (action === "artifact.preview") {
            const selected = nodes.filter(
              (node) =>
                ![id(4), id(5), id(20)].includes(node.ref.id) &&
                (!Array.isArray(value.selectedNodeIds) ||
                  value.selectedNodeIds.includes(node.ref.id)),
            );
            const selectedIds = new Set([
              ...selected.map((node) => node.ref.id),
              id(4),
              id(5),
            ]);
            const selectedEdges = edges.filter(
              (edge) =>
                selectedIds.has(String(edge.attributes.fromId)) &&
                selectedIds.has(String(edge.attributes.toId)),
            );
            const structural = nodes.filter((node) =>
              [id(4), id(5)].includes(node.ref.id),
            );
            const requestedProvenance = value.provenance as
              | {
                  nodeIds?: string[];
                  relationships?: { fromId: string; typeId: string }[];
                }
              | undefined;
            const provenance = [
              ...nodes.filter((node) =>
                requestedProvenance?.nodeIds?.includes(node.ref.id),
              ),
              ...edges.filter((edge) =>
                requestedProvenance?.relationships?.some(
                  (relationship) =>
                    relationship.fromId === edge.attributes.fromId &&
                    relationship.typeId === edge.attributes.typeId,
                ),
              ),
            ];
            const requiredTypes = new Set(
              [...selected, ...structural, ...selectedEdges, ...provenance].map(
                (record) => record.attributes.typeId,
              ),
            );
            return ok({
              title: "Work brief",
              description: "# Work brief\n\nProposed context.",
              nodes: selected.map((node) => ({
                id: node.ref.id,
                revision: node.revision,
              })),
              edges: selectedEdges.map((edge) => ({
                id: edge.ref.id,
                revision: edge.revision,
              })),
              definition: { id: id(4), revision: 1 },
              lens: { id: id(5), revision: 1 },
              wikiOrigin: "https://wiki.fixture",
              provenance: provenance.map((source) => ({
                type: source.ref.type,
                id: source.ref.id,
                revision: source.revision,
              })),
              manifest: {
                sources: [
                  ...provenance,
                  ...selected,
                  ...structural,
                  ...selectedEdges,
                  ...types.filter((type) => requiredTypes.has(type.ref.id)),
                ],
              },
              gaps: [],
            });
          }
          if (action === "work.targets")
            return ok({
              projects: [
                {
                  id: "project-target",
                  name: "Configured project",
                  ready: true,
                  blocker: null,
                },
              ],
            });
          if (action === "governance.work-policy") return ok(policy());
          if (action === "work.get" && providerDenied)
            return {
              ok: false,
              status: 403,
              message: "Execution access revoked",
            };
          if (action === "work.get")
            return submitted ? ok(results()) : missing();
          if (action === "work.submit") {
            assert.deepEqual(value.target, { project: "project-target" });
            assert.ok(value.workPackage);
            submitCalls++;
            if (!submitted) externalCreated++;
            submitted = true;
            frozenWorkPackage = value.workPackage;
            if (lostResponse) {
              lostResponse = false;
              inProgress = true;
              return {
                ok: false,
                status: 503,
                message: "Response interrupted after creation",
              };
            }
            inProgress = false;
            return ok({ submissionId, issue: results().issue });
          }
          if (action === "governance.release") return ok({ id: id(30) });
          if (action === "governance.claim" && reviewRouted)
            return {
              ok: false,
              status: 409,
              message: "Already submitted for review",
            };
          if (action === "governance.claim")
            return ok({
              claim: { token: id(31) },
              document: {
                revision: savedReview ? 2 : 1,
                attributes: {
                  body: savedReview
                    ? JSON.stringify(savedReview)
                    : "Draft pending",
                },
              },
            });
          if (action === "governance.save-draft") {
            savedReview = JSON.parse(String(value.body));
            if (reviewRace) {
              reviewRace = false;
              await app.database
                .prepare(
                  "UPDATE planning_work_submissions SET revision=revision+1 WHERE id=?",
                )
                .bind(id(40))
                .run();
              reviewRouted = true;
              return {
                ok: false,
                status: 503,
                message: "Draft saved; response lost after concurrent refresh",
              };
            }
            return ok({ revision: 2 });
          }
          if (action === "governance.verify-work-acceptance") {
            if (
              !approved ||
              savedReview?.packageDigest !== value.packageDigest ||
              savedReview?.evaluationDigest !== value.evaluationDigest
            )
              return {
                ok: false,
                status: 409,
                message: "Required decision is outstanding or stale",
              };
            return ok({
              verified: true,
              purpose: "planning_acceptance",
              packageDigest: value.packageDigest,
              evaluationDigest: value.evaluationDigest,
              candidate: value.candidate,
            });
          }
          throw new Error(`Unexpected action ${action}`);
        },
      }),
    },
  );
  const scope = {
    installationId: app.installationId,
    organizationId: "org",
    userId: "owner",
    packageHash: "fixture",
    phase: "interactive" as const,
    expiresAt: Date.now() + 3600000,
  };
  const call = (action: string, input: unknown, role = "owner") =>
    app.call(
      "/api/apps/planning/work",
      { ...owner, role },
      { method: "POST", body: { action, input }, workflowHost: scope },
    );
  const run = async (action: string, input: unknown) => {
    const response = await call(action, input);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<Record<string, unknown>>;
  };
  try {
    const created = await app.call("/api/apps/planning/projects", owner, {
      method: "POST",
      body: { name: "Useful work", goals: "Ship a bounded change" },
    });
    const project = (await created.json()) as { id: string };
    nodes = [
      record("graph-node", 1, { typeId: id(100), title: "Project context" }, [
        { installationId: app.installationId, type: "project", id: project.id },
      ]),
      record("graph-node", 2, {
        typeId: id(101),
        title: "Bounded requirement",
        body: JSON.stringify({
          statement: "Render the requested scope",
          status: "proposed",
        }),
      }),
      record("graph-node", 3, {
        typeId: id(102),
        title: "Visible output",
        body: JSON.stringify({
          condition: "Preview the work",
          expectedOutcome: "Only selected context appears",
        }),
      }),
      record("graph-node", 4, { typeId: id(103), title: "Brief recipe" }),
      record("graph-node", 5, { typeId: id(104), title: "Project lens" }),
      record("graph-node", 20, {
        typeId: id(109),
        title: "Work acceptance",
        body: JSON.stringify({ state: "active", kind: "release_approval" }),
      }),
    ];
    edges = [
      record("graph-edge", 10, { typeId: id(105), fromId: id(1), toId: id(2) }),
      record("graph-edge", 11, { typeId: id(106), fromId: id(2), toId: id(3) }),
      record("graph-edge", 12, { typeId: id(107), fromId: id(4), toId: id(1) }),
      record("graph-edge", 13, { typeId: id(108), fromId: id(4), toId: id(5) }),
    ];
    const previewInput = {
      projectId: project.id,
      definitionId: id(4),
      requirementIds: [id(2)],
    };
    const preview = await run("work.preview", previewInput);
    const destinations = await run("work.destinations", {});
    assert.equal((destinations.foundries as unknown[]).length, 1);
    const request = {
      requestId: id(40),
      preview: previewInput,
      expectedDigest: preview.digest,
      foundryInstallationId: "foundry",
      foundryProjectId: "project-target",
      governanceInstallationId: "governance",
      controlId: id(20),
    };
    assert.equal((await call("work.submit", request, "member")).status, 403);
    assert.equal(
      (
        await call("work.submit", {
          ...request,
          expectedDigest: "d".repeat(64),
        })
      ).status,
      409,
    );
    assert.equal((await call("work.submit", request)).status, 503);
    nodes[2].revision++;
    let recovered = await run("work.submit", request);
    assert.equal(
      submitCalls,
      2,
      "an in-progress receipt must resume the same frozen write",
    );
    assert.equal((recovered.freshness as { stale: boolean }).stale, true);
    nodes[2].revision--;
    recovered = await run("work.get", { submissionId: request.requestId });
    assert.equal(externalCreated, 1);
    providerDenied = true;
    const historical = await run("work.get", {
      submissionId: request.requestId,
    });
    assert.equal(
      (historical.executionSource as { source: string }).source,
      "saved_observation",
    );
    assert.equal(
      (await call("work.refresh", { submissionId: request.requestId })).status,
      403,
    );
    providerDenied = false;
    assert.equal((recovered.freshness as { stale: boolean }).stale, false);
    assert.equal(
      nodes.filter((node) => node.ref.id === request.requestId).length,
      1,
    );
    const writesBeforeRead = graphWrites;
    await run("work.get", { submissionId: request.requestId });
    assert.equal(
      graphWrites,
      writesBeforeRead,
      "work.get never reconciles graph state",
    );
    await run("work.refresh", { submissionId: request.requestId });
    assert.equal(
      nodes.filter((node) => node.ref.id === request.requestId).length,
      1,
    );
    const projected = nodes.find((node) => node.ref.id === request.requestId);
    assert.ok(projected);
    projected.attributes.archived = true;
    const pendingProjection = await run("work.refresh", {
      submissionId: request.requestId,
    });
    assert.equal(
      (pendingProjection.projection as { status: string }).status,
      "pending",
    );
    projected.attributes.archived = false;
    const sourceRefs = projected.references;
    projected.references = [];
    const conflictingProjection = await run("work.refresh", {
      submissionId: request.requestId,
    });
    assert.equal(
      (conflictingProjection.projection as { status: string }).status,
      "pending",
    );
    projected.references = sourceRefs;
    assert.equal(
      (
        await call(
          "work.refresh",
          { submissionId: request.requestId },
          "member",
        )
      ).status,
      403,
    );
    assert.deepEqual(
      (recovered.submission as { snapshot: unknown }).snapshot,
      preview,
    );
    assert.equal(
      (await call("work.submit", { ...request, foundryProjectId: "other" }))
        .status,
      409,
    );
    assert.equal(
      (await call("work.get", { submissionId: id(99) })).status,
      404,
    );
    assert.equal(
      (
        (await run("work.submissions", {
          projectId: project.id,
        })) as unknown as unknown[]
      ).length,
      1,
    );
    const evaluate = {
      submissionId: request.requestId,
      criterion: { installationId: "wiki", type: "graph-node", id: id(3) },
      criterionRevision: 1,
      candidateCommit: commit,
      result: "passed",
      method:
        "Compared the requested output with the successful exact-commit fixture check",
      evidence: [{ kind: "check", id: "44" }],
    };
    assert.equal(
      (
        await call("work.evaluate", {
          ...evaluate,
          evidence: [{ kind: "image", id: "image-1" }],
        })
      ).status,
      409,
    );
    for (const id of ["nonexistent", "undefined"])
      assert.equal(
        (
          await call("work.evaluate", {
            ...evaluate,
            evidence: [{ kind: "check", id }],
          })
        ).status,
        409,
      );
    assert.equal(
      (
        await call("work.evaluate", {
          ...evaluate,
          candidateCommit: "e".repeat(40),
        })
      ).status,
      409,
    );
    assert.equal(
      (await call("work.evaluate", { ...evaluate, criterionRevision: 2 }))
        .status,
      409,
    );
    for (const evidence of [
      [
        { kind: "check", id: "44" },
        { kind: "check", id: "45" },
      ],
      [
        { kind: "check", id: "44" },
        { kind: "review", id: "55" },
      ],
    ])
      assert.equal(
        (await call("work.evaluate", { ...evaluate, evidence })).status,
        409,
        "mixed failed/dismissed evidence cannot pass",
      );
    malformed = true;
    const blocked = await run("work.get", { submissionId: request.requestId });
    assert.ok(
      (blocked.blockers as string[]).some((blocker) =>
        blocker.includes("malformed"),
      ),
    );
    assert.equal((await call("work.evaluate", evaluate)).status, 409);
    malformed = false;
    const evaluated = await run("work.evaluate", evaluate);
    assert.equal((evaluated.freshness as { stale: boolean }).stale, false);
    const accept = { submissionId: request.requestId, candidateCommit: commit };
    assert.equal((await call("work.accept", accept)).status, 409);
    merged = false;
    assert.equal(
      (
        await call("work.request-review", {
          ...accept,
          recommendation: "Please review verified output",
        })
      ).status,
      409,
    );
    merged = true;
    reviewRace = true;
    assert.equal(
      (
        await call("work.request-review", {
          ...accept,
          recommendation: "Please review verified output",
        })
      ).status,
      503,
    );
    const persistedReview = await app.database
      .prepare("SELECT review FROM planning_work_submissions WHERE id=?")
      .bind(request.requestId)
      .first();
    assert.equal(
      JSON.parse(String(persistedReview?.review)).occurrenceId,
      id(30),
    );
    const review = await run("work.request-review", {
      ...accept,
      recommendation: "Please review verified output",
    });
    reviewRouted = false;
    assert.ok(savedReview?.evaluationDigest);
    assert.ok(review.review);
    assert.ok(
      !calls.includes("governance.submit") &&
        !calls.includes("governance.decide"),
    );
    assert.equal((await call("work.accept", accept)).status, 409);
    approved = true;
    policyTitle = "Updated biography/display name";
    policyNodeRevision++;
    await run("work.request-review", {
      ...accept,
      recommendation: "Same authority despite a display edit",
    });
    imageRevision = "e".repeat(40);
    assert.equal(
      (
        await call("work.evaluate", {
          ...evaluate,
          evidence: [
            { kind: "check", id: "44" },
            { kind: "image", id: "image-1" },
          ],
        })
      ).status,
      409,
    );
    imageRevision = commit;
    await run("work.evaluate", {
      ...evaluate,
      evidence: [
        { kind: "check", id: "44" },
        { kind: "image", id: "image-1" },
      ],
    });
    await run("work.request-review", {
      ...accept,
      recommendation: "Inspect the exact-head screenshot evidence",
    });
    imageHash = "2".repeat(64);
    assert.equal(
      (await call("work.accept", accept)).status,
      409,
      "replacement screenshot content must be re-evaluated",
    );
    imageHash = "1".repeat(64);
    policyRevision++;
    assert.equal((await call("work.accept", accept)).status, 409);
    policyRevision--;
    nodes[2].revision++;
    assert.equal((await call("work.accept", accept)).status, 409);
    assert.equal(
      (
        (await run("work.get", { submissionId: request.requestId }))
          .freshness as { stale: boolean }
      ).stale,
      true,
    );
    nodes[2].revision--;
    await run("work.evaluate", {
      ...evaluate,
      method: "Re-attested against a fresh exact-commit check",
    });
    assert.equal(
      (await call("work.accept", accept)).status,
      409,
      "changed evaluations require a fresh decision",
    );
    await run("work.request-review", {
      ...accept,
      recommendation: "Review refreshed evidence",
    });
    const accepted = await run("work.accept", accept);
    const acceptedEvidence = JSON.stringify(
      (accepted.submission as { accepted: { execution: unknown } }).accepted
        .execution,
    );
    merged = false;
    const afterProviderChange = await run("work.refresh", {
      submissionId: request.requestId,
    });
    assert.equal(
      JSON.stringify(
        (afterProviderChange.submission as { accepted: { execution: unknown } })
          .accepted.execution,
      ),
      acceptedEvidence,
      "accepted evidence remains immutable after later provider observations",
    );
    merged = true;
    nodes[2].revision++;
    await run("work.request-review", {
      ...accept,
      recommendation: "Already accepted historical work",
    });
    nodes[2].revision--;
    assert.ok((accepted.submission as { accepted: unknown }).accepted);
    await run("work.accept", accept);
    assert.equal(
      (
        await call("work.accept", {
          ...accept,
          candidateCommit: "f".repeat(40),
        })
      ).status,
      409,
    );
    assert.equal((await call("work.evaluate", evaluate)).status, 409);
    const stored = await app.database
      .prepare("SELECT snapshot FROM planning_work_submissions WHERE id=?")
      .bind(request.requestId)
      .first();
    assert.deepEqual(
      JSON.parse(String(stored?.snapshot)),
      preview,
      "acceptance never rewrites submitted scope",
    );
    assert.equal(externalCreated, 1);
    // Synthetic large persisted sections fit independently; combined readback
    // must stay within the app-action transport bound without losing content.
    const largeSnapshot = structuredClone(preview);
    (
      largeSnapshot.manifest as { sources: EntityRecord[] }
    ).sources[0].attributes.largeFixture = "s".repeat(260000);
    const largeAcceptance = structuredClone(
      (accepted.submission as { accepted: Record<string, unknown> }).accepted,
    );
    (largeAcceptance.execution as Record<string, unknown>).largeFixture =
      "e".repeat(260000);
    await app.database
      .prepare(
        "UPDATE planning_work_submissions SET snapshot=?,accepted=? WHERE id=?",
      )
      .bind(
        JSON.stringify(largeSnapshot),
        JSON.stringify(largeAcceptance),
        request.requestId,
      )
      .run();
    nodes[2].revision++;
    const summary = await run("work.get", { submissionId: request.requestId });
    assert.equal(summary.summary, true);
    assert.ok(
      (summary.blockers as string[]).some((message) =>
        message.includes("Source context changed"),
      ),
      "bounded summary retains source freshness blocker",
    );
    assert.deepEqual(summary.readbackViews, [
      "snapshot",
      "evidence",
      "acceptance",
      "evaluations",
    ]);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 500 * 1024);
    const exactScope = await run("work.get", {
      submissionId: request.requestId,
      view: "snapshot",
    });
    assert.deepEqual(exactScope, largeSnapshot);
    const exactAcceptance = await run("work.get", {
      submissionId: request.requestId,
      view: "acceptance",
    });
    assert.deepEqual(exactAcceptance, largeAcceptance);
    const savedSummary = await run("work.refresh", {
      submissionId: request.requestId,
    });
    assert.equal(
      savedSummary.summary,
      true,
      "committed writes return a bounded saved summary",
    );
  } finally {
    await app.dispose();
  }
});
