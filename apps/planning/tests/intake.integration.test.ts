import { prepareIntakeAction } from "../src/server/intake-agent";
import assert from "node:assert/strict";
import test from "node:test";
import { createClient, type InValue } from "@libsql/client";
import type { z } from "zod";
import {
  claimInput,
  claimWork,
  IntakeService,
  recordResult,
  recordResultInput,
  reviseScope,
  reviseScopeInput,
  routeInput,
  routeIntake,
  saveDraftInput,
  saveResultDraft,
  validateRoutes,
  workActions,
  type IntakeContext,
} from "../src/server/intake";

/** Run one of the intake writes the mutations run, with its input parsed as the mutation does. */
const write = <S extends z.ZodType, R>(schema: S, run: (s: IntakeService, value: z.output<S>) => Promise<R>) =>
  (context: IntakeContext, input: z.input<S>) => run(new IntakeService(context), schema.parse(input));
const intake = {
  claim: write(claimInput, claimWork),
  recordResult: write(recordResultInput, recordResult),
  requestReview: write(recordResultInput, recordResult),
  saveDraft: write(saveDraftInput, saveResultDraft),
  route: write(routeInput, routeIntake),
  reviseScope: write(reviseScopeInput, reviseScope),
};

async function fixture(initialDuty = "recommend") {
  let duty = initialDuty;
  const client = createClient({ url: ":memory:" });
  await client.execute(
    "CREATE TABLE planning_intakes(id TEXT PRIMARY KEY, installationId TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL)",
  );
  await client.execute(
    "CREATE TABLE planning_work_guard(value INTEGER NOT NULL)",
  );
  await client.execute(
    "CREATE TABLE planning_work_submissions(id TEXT,installationId TEXT)",
  );
  let sourceRevision = 1,
    approve = false,
    holder = "holder";
  const identity = {
    userId: "member",
    organizationId: "org",
    installationId: "planning",
    owner: { kind: "organization" as const, id: "org" },
    canEdit: true,
    role: "owner",
  };
  const context = {
    identity,
    actor: { kind: "member" as const, id: "member" },
    originActor: { kind: "member" as const, id: "member" },
    store: () => ({
      query: async (s: { sql: string; params?: unknown[] }) =>
        (
          await client.execute({
            sql: s.sql,
            args: (s.params ?? []) as InValue[],
          })
        ).rows as Record<string, unknown>[],
      batch: async (ss: { sql: string; params?: unknown[] }[]) =>
        client.batch(
          ss.map((s) => ({ sql: s.sql, args: (s.params ?? []) as InValue[] })),
          "write",
        ),
    }),
    host: () => ({
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bounded fixture implements the host operations under test.
      call: async (name: string, raw: unknown) => {
        const input = raw as Record<string, unknown>;
        if (name === "entities.types")
          return ["graph-type", "graph-node", "graph-edge"].map((type) => ({
            type,
            installationId: "wiki",
            writable: true,
          }));
        if (name === "entities.get")
          return {
            ref: { installationId: "wiki", type: "graph-node", id: "source" },
            title: "Source",
            revision: sourceRevision,
            attributes: { body: "Source evidence" },
            references: [],
          };
        if (name === "entities.resolve") return { installationId: "wiki" };
        if (name === "identity.resolve") return { holderId: holder };
        if (
          name === "actions.call" &&
          input.action === "governance.gate-policy"
        )
          return {
            workKinds: [
              "research",
              "architecture",
              "prioritization",
              "backlog",
              "implementation",
            ],
            evidenceRequirements: {
              researchCitations: true,
              resolvedGaps: true,
            },
            duties: [{ duty, assignment: { holderId: "holder" } }],
          };
        if (
          name === "actions.call" &&
          input.action === "governance.request-gate" &&
          duty === "perform"
        )
          throw new Response("Recommend duty required", { status: 403 });
        if (
          name === "actions.call" &&
          input.action === "governance.request-gate"
        )
          return {
            id: `gate-${(input.input as { subject: { revision: number } }).subject.revision}`,
          };
        if (
          name === "actions.call" &&
          input.action === "governance.verify-gate"
        ) {
          if (!approve)
            throw new Response("Decision required", { status: 409 });
          return { verified: true };
        }
        throw new Error(`Unexpected ${name}: ${JSON.stringify(input)}`);
      },
    }),
  } as unknown as IntakeContext;
  return {
    client,
    recommend: () => {
      duty = "recommend";
    },
    context,
    service: new IntakeService(context),
    sourceRevision: () => {
      sourceRevision++;
    },
    approve: () => {
      approve = true;
    },
    revoke: () => {
      holder = "other";
    },
  };
}
const gate = {
  installationId: "governance",
  controlId: "10000000-0000-4000-8000-000000000001",
};
const input = {
  requestId: "10000000-0000-4000-8000-000000000002",
  kind: "customer-problem" as const,
  title: "Customer needs a simpler booking flow",
  description: "Compare alternatives and propose a solution",
  sources: [
    { installationId: "wiki", type: "graph-node", id: "source", revision: 1 },
  ],
};
const status = (n: number) => (error: unknown) =>
  error instanceof Response && error.status === n;
test("all intake kinds persist and conflicting retries do not overwrite original scope", async () => {
  const f = await fixture();
  try {
    for (const kind of [
      "customer-problem",
      "use-case",
      "user-story",
      "competitor",
      "competitor-product",
    ] as const) {
      const v = { ...input, kind, requestId: crypto.randomUUID() };
      const row = await f.service.create(v);
      assert.deepEqual((await f.service.create(v)).body.input, v);
      await assert.rejects(
        f.service.create({ ...v, title: "changed" }),
        status(409),
      );
      assert.equal((await f.service.get(row.id)).body.input.title, v.title);
    }
  } finally {
    f.client.close();
  }
});
test("dependencies need approved results; source changes and revoked assignments block work", async () => {
  const f = await fixture();
  try {
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [
        {
          kind: "research",
          dependsOn: [],
          rationale: "Compare alternatives",
          gate,
        },
        {
          kind: "architecture",
          dependsOn: ["research"],
          rationale: "Choose approach",
          gate,
        },
        {
          kind: "backlog",
          dependsOn: [],
          rationale: "Independent triage",
          gate,
        },
      ],
    });
    const [research, architecture] = row.body.routes;
    await f.service.ready(row, research);
    await assert.rejects(f.service.ready(row, architecture), status(409));
    const claim = (await intake.claim(f.context, {
      intakeId: row.id,
      childId: research.id,
      requestId: crypto.randomUUID(),
    })) as { token: string };
    const recorded = {
      summary: "Alternatives examined",
      sources: [
        {
          url: "https://example.test/research",
          observedAt: "2026-10-29T00:00:00Z",
          excerpt: "Observed alternatives",
        },
      ],
      gaps: [],
      wikiRefs: [],
    };
    await intake.recordResult(f.context, {
      intakeId: row.id,
      childId: research.id,
      token: claim.token,
      result: recorded,
    });
    row = await f.service.get(row.id);
    await assert.rejects(f.service.ready(row, row.body.routes[1]), status(409));
    f.approve();
    await f.service.ready(row, row.body.routes[1]);
    f.revoke();
    assert.equal(
      await new IntakeService(f.context).assigned(row.body.routes[1]),
      false,
    );
    f.sourceRevision();
    await assert.rejects(
      new IntakeService(f.context).ready(row, row.body.routes[2]),
      status(409),
    );
  } finally {
    f.client.close();
  }
});
test("cycle and omitted prerequisite rejected; selected discovery always precedes implementation", () => {
  assert.throws(() =>
    validateRoutes({
      routes: [{ kind: "research", dependsOn: ["research"], rationale: "x" }],
    }),
  );
  assert.throws(() =>
    validateRoutes({
      routes: [
        { kind: "research", dependsOn: ["architecture"], rationale: "x" },
      ],
    }),
  );
  const routed = validateRoutes({
    routes: [
      { kind: "research", dependsOn: [], rationale: "x" },
      { kind: "implementation", dependsOn: [], rationale: "x" },
    ],
  });
  assert.deepEqual(routed.routes[1].dependsOn, ["research"]);
});

test("required evidence gaps block review and downstream work while unrelated routes remain eligible", async () => {
  const f = await fixture();
  try {
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [
        { kind: "research", dependsOn: [], rationale: "Compare", gate },
        {
          kind: "architecture",
          dependsOn: ["research"],
          rationale: "Design",
          gate,
        },
        { kind: "backlog", dependsOn: [], rationale: "Independent", gate },
      ],
    });
    row.body.routes[0].result = {
      summary: "Insufficient evidence",
      sources: [],
      gaps: ["Required competitor source unavailable"],
      wikiRefs: [],
    };
    row = await f.service.save(row);
    f.approve();
    await assert.rejects(f.service.ready(row, row.body.routes[1]), status(409));
    await new IntakeService(f.context).ready(row, row.body.routes[2]);
    await f.service.requestGate(row, row.body.routes[0]);
    const inspected = await f.service.inspect(await f.service.get(row.id));
    assert.match(
      inspected.body.routes[0].blocker ?? "",
      /Required evidence remains unavailable/,
    );
    assert.equal(inspected.body.routes[0].gateReceipt, undefined);
    assert.equal(inspected.body.routes[2].blocker, null);
  } finally {
    f.client.close();
  }
});

test("old unfinished work is discoverable and context binds completed prerequisites", async () => {
  const f = await fixture();
  try {
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [
        { kind: "research", dependsOn: [], rationale: "Research", gate },
        {
          kind: "architecture",
          dependsOn: ["research"],
          rationale: "Architecture",
          gate,
        },
      ],
    });
    for (let i = 0; i < 105; i++)
      await f.service.create({ ...input, requestId: crypto.randomUUID() });
    const listed = await f.service.work();
    assert.equal(listed.work.length, 1);
    const context = (await workActions["work.context"].invoke(
      f.context,
      listed.work[0],
    )) as { markdown: string };
    assert.match(context.markdown, /Research/);
    const [research, architecture] = row.body.routes;
    research.result = {
      summary: "Prior research informs this architecture",
      sources: [
        {
          url: "https://example.test/research",
          observedAt: "2026-10-29T00:00:00Z",
          excerpt: "Cited source",
        },
      ],
      gaps: [],
      wikiRefs: [],
    };
    research.revision++;
    row = await f.service.save(row);
    f.approve();
    const downstream = await f.service.context(
      `${row.id}_${architecture.id}`,
      architecture.revision,
    );
    assert.match(
      downstream.markdown,
      /Prior research informs this architecture/,
    );
    assert.ok(
      downstream.sources.some(
        (source) =>
          source.ref.id.endsWith(research.id) &&
          source.revision === research.revision,
      ),
    );
    assert.ok((await f.service.list(100)).length > 0);
  } finally {
    f.client.close();
  }
});

test("expired research claims can correct unapproved evidence while preserving its history", async () => {
  const f = await fixture();
  try {
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [
        { kind: "research", dependsOn: [], rationale: "Research", gate },
      ],
    });
    const childId = row.body.routes[0].id;
    const claim = async () =>
      intake.claim(f.context, {
        intakeId: row.id,
        childId,
        requestId: crypto.randomUUID(),
      }) as Promise<{ token: string }>;
    const first = await claim();
    const evidence = {
      summary: "Original finding",
      sources: [
        {
          url: "https://example.test/source",
          observedAt: "2026-10-29T00:00:00Z",
          excerpt: "Finding",
        },
      ],
      gaps: [],
    };
    await intake.recordResult(f.context, {
      intakeId: row.id,
      childId,
      token: first.token,
      result: evidence,
    });
    row = await f.service.get(row.id);
    const originalReceipt = row.body.routes[0].gateReceipt;
    row.body.routes[0].claim!.until = 0;
    await f.service.save(row);
    const renewed = await claim();
    await intake.recordResult(f.context, {
      intakeId: row.id,
      childId,
      token: renewed.token,
      result: { ...evidence, summary: "Corrected finding" },
    });
    row = await f.service.get(row.id);
    assert.equal(
      row.body.routes[0].resultHistory?.[0].result.summary,
      "Original finding",
    );
    assert.notDeepEqual(row.body.routes[0].gateReceipt, originalReceipt);
    row.body.routes[0].claim!.until = 0;
    await f.service.save(row);
    f.approve();
    await assert.rejects(claim(), status(409));
  } finally {
    f.client.close();
  }
});

test("perform-only workers hand recorded findings to the Recommend holder", async () => {
  const f = await fixture("perform");
  try {
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [
        { kind: "research", dependsOn: [], rationale: "Research", gate },
      ],
    });
    const childId = row.body.routes[0].id;
    const claim = (await intake.claim(f.context, {
      intakeId: row.id,
      childId,
      requestId: crypto.randomUUID(),
    })) as { token: string };
    await intake.recordResult(f.context, {
      intakeId: row.id,
      childId,
      token: claim.token,
      result: {
        summary: "Evidence",
        sources: [
          {
            url: "https://example.test",
            observedAt: "2026-10-29T00:00:00Z",
            excerpt: "Evidence",
          },
        ],
        gaps: [],
      },
    });
    assert.equal((await new IntakeService(f.context).work()).work.length, 0);
    f.recommend();
    assert.equal((await new IntakeService(f.context).work()).work.length, 1);
    await intake.requestReview(f.context, {
      intakeId: row.id,
      childId,
    });
    assert.ok((await f.service.get(row.id)).body.routes[0].gateReceipt);
  } finally {
    f.client.close();
  }
});
test("scope revisions cannot discard in-flight or completed delivery", async () => {
  const f = await fixture();
  try {
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [
        { kind: "implementation", dependsOn: [], rationale: "Implement", gate },
      ],
    });
    row.body.routes[0].submissionIntent = {
      requestId: crypto.randomUUID(),
      digest: "a".repeat(64),
    };
    row = await f.service.save(row);
    await assert.rejects(
      intake.reviseScope(f.context, {
        intakeId: row.id,
        revision: row.revision,
        requestId: crypto.randomUUID(),
        title: "Changed",
        description: input.description,
        sources: input.sources,
      }),
      status(409),
    );
    assert.ok((await f.service.get(row.id)).body.routes[0].submissionIntent);
  } finally {
    f.client.close();
  }
});

test("model output cannot choose its own Governance authority", async () => {
  const f = await fixture();
  try {
    const original = f.context.host;
    f.context.host = (() => ({
      call: async (name: string, raw: unknown) => {
        if (name === "workflow.start") return { id: crypto.randomUUID() };
        if (name === "inference.generate")
          return {
            output: {
              routes: [
                {
                  kind: "research",
                  dependsOn: [],
                  rationale: "Proposed",
                  gate,
                },
              ],
            },
          };
        return original().call(name as never, raw as never);
      },
    })) as IntakeContext["host"];
    const row = await f.service.create(input);
    await assert.rejects(f.service.route(row));
    assert.equal((await f.service.get(row.id)).body.routes.length, 0);
    assert.equal((await f.service.get(row.id)).body.routing?.state, "failed");
  } finally {
    f.client.close();
  }
});

test("sidebar submission uses the private proposal request identity", () => {
  const requestId = crypto.randomUUID();
  const prepared = prepareIntakeAction(
    "intake.submit",
    { work: { requestId: "model-chosen", expectedDigest: "a".repeat(64) } },
    requestId,
  ) as { work: { requestId: string } };
  assert.equal(prepared.work.requestId, requestId);
});

test("scope history readback omits former claim tokens", async () => {
  const f = await fixture();
  try {
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [
        { kind: "research", dependsOn: [], rationale: "Research", gate },
      ],
    });
    await intake.claim(f.context, {
      intakeId: row.id,
      childId: row.body.routes[0].id,
      requestId: crypto.randomUUID(),
    });
    row = await f.service.get(row.id);
    await intake.reviseScope(f.context, {
      intakeId: row.id,
      revision: row.revision,
      requestId: crypto.randomUUID(),
      title: "Updated",
      description: input.description,
      sources: input.sources,
    });
    const viewed = await f.service.inspect(await f.service.get(row.id));
    assert.equal(
      "token" in viewed.body.scopeReviews![0].routes[0].claim!,
      false,
    );
  } finally {
    f.client.close();
  }
});

test("rejected pre-effect submissions can be reset but uncertain delivery cannot", async () => {
  const f = await fixture();
  try {
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [
        { kind: "implementation", dependsOn: [], rationale: "Implement", gate },
      ],
    });
    const childId = row.body.routes[0].id,
      requestId = crypto.randomUUID();
    const attempt = await f.service.beginSubmission(
      row,
      row.body.routes[0],
      requestId,
      "a".repeat(64),
    );
    row = await f.service.get(row.id);
    await assert.rejects(
      f.service.resetSubmission(row, row.body.routes[0]),
      status(409),
    );
    await f.service.failedSubmission(
      row.id,
      childId,
      attempt,
      new Response("Invalid package", { status: 409 }),
    );
    row = await f.service.get(row.id);
    assert.equal(row.body.routes[0].submissionIntent?.state, "rejected");
    row = await f.service.resetSubmission(row, row.body.routes[0]);
    assert.equal(row.body.routes[0].submissionIntent, undefined);
    const second = await f.service.beginSubmission(
      row,
      row.body.routes[0],
      requestId,
      "a".repeat(64),
    );
    await f.client.execute({
      sql: "INSERT INTO planning_work_submissions(id,installationId) VALUES(?,?)",
      args: [requestId, "planning"],
    });
    await f.service.failedSubmission(
      row.id,
      childId,
      second,
      new Response("Provider response lost", { status: 409 }),
    );
    row = await f.service.get(row.id);
    assert.equal(row.body.routes[0].submissionIntent?.state, "retryable");
    await assert.rejects(
      f.service.resetSubmission(row, row.body.routes[0]),
      status(409),
    );
  } finally {
    f.client.close();
  }
});
test("an explicit Perform assignment keeps Recommend holders in review", async () => {
  const f = await fixture();
  try {
    const old = f.context.host;
    f.context.host = (() => ({
      call: async (name: string, raw: unknown) => {
        const input = raw as { action?: string };
        const result = await old().call(name as never, raw as never);
        if (
          name === "actions.call" &&
          input.action === "governance.gate-policy"
        )
          return {
            ...(result as object),
            duties: [
              { duty: "perform", assignment: { holderId: "other" } },
              { duty: "recommend", assignment: { holderId: "holder" } },
            ],
          };
        return result;
      },
    })) as IntakeContext["host"];
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [
        { kind: "research", dependsOn: [], rationale: "Research", gate },
      ],
    });
    assert.equal(await f.service.assigned(row.body.routes[0]), false);
    assert.equal(await f.service.assigned(row.body.routes[0], "review"), true);
  } finally {
    f.client.close();
  }
});

test("intake options read active work gates through the host's own input schemas", async () => {
  const { operations } = await import("@ai-outfitter/app-sdk/workflow-host");
  const controlId = "10000000-0000-4000-8000-0000000000c1";
  const calls: string[] = [];
  const host = {
    call: async (name: keyof typeof operations, raw: unknown) => {
      // The platform refuses input its operation schema rejects ("Invalid workflow host input").
      const parsed = operations[name].input.safeParse(raw);
      if (!parsed.success) throw new Response("Invalid workflow host input", { status: 400 });
      calls.push(name);
      const input = parsed.data as Record<string, unknown>;
      if (name === "entities.types")
        return [
          { type: "graph-type", collection: "types", template: "onto", installationId: "wiki", writable: true },
          { type: "graph-node", collection: "nodes", template: "onto", installationId: "wiki", writable: true },
          { type: "graph-edge", collection: "edges", template: "onto", installationId: "wiki", writable: true },
        ].filter((item) => !input.template || item.template === input.template);
      if (name === "entities.list" && input.type === "graph-type")
        return [{ ref: { installationId: "wiki", type: "graph-type", id: "control-type" }, title: "DecisionControlV4", revision: 1, attributes: {}, references: [] }];
      if (name === "entities.list" && input.type === "graph-node")
        return [{
          ref: { installationId: "wiki", type: "graph-node", id: controlId },
          title: "Discovery and implementation gate", revision: 1, references: [],
          attributes: { body: JSON.stringify({ kind: "work_gate", state: "active", work_kinds: ["research"] }) },
        }];
      if (name === "actions.list")
        return [{ installationId: "governance", actions: [{ name: "governance.gate-policy", permitted: true }] }];
      throw new Error(`Unexpected ${name}`);
    },
  };
  const service = new IntakeService({ identity: { installationId: "planning" }, host: () => host } as unknown as IntakeContext);
  const options = await service.options();
  assert.deepEqual(options.gates, [
    { installationId: "governance", controlId, title: "Discovery and implementation gate", workKinds: ["research"] },
  ]);
  assert.ok(calls.includes("entities.types") && calls.includes("actions.list"));
});

test("agents draft findings across several saves, then submit the draft for review", async () => {
  const f = await fixture();
  try {
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [{ kind: "research", dependsOn: [], rationale: "Research", gate }],
    });
    const childId = row.body.routes[0].id;
    const save = (token: string, draft: Record<string, unknown>) =>
      intake.saveDraft(f.context, { intakeId: row.id, childId, token, draft });
    await assert.rejects(save(crypto.randomUUID(), { summary: "No claim" }), status(403));
    const { token } = await intake.claim(f.context, { intakeId: row.id, childId, requestId: crypto.randomUUID() });
    await save(token, { summary: "First pass" });
    row = await f.service.get(row.id);
    assert.equal(row.body.routes[0].draft?.result.summary, "First pass");
    assert.equal(row.body.routes[0].revision, 1, "drafts leave the work record unchanged");
    assert.equal(row.body.routes[0].gateReceipt, undefined, "drafts request no review");
    const viewed = await f.service.inspect(row);
    assert.equal("token" in (viewed.body.routes[0].draft ?? {}), false, "readers never see the claim token");
    // An incomplete draft cannot be submitted.
    await assert.rejects(intake.recordResult(f.context, { intakeId: row.id, childId, token }), status(422));
    const sources = [{ url: "https://example.test/source", observedAt: "2026-11-03T00:00:00Z", excerpt: "Finding" }];
    await save(token, { summary: "Second pass", sources, gaps: [] });
    await intake.recordResult(f.context, { intakeId: row.id, childId, token });
    row = await f.service.get(row.id);
    const route = row.body.routes[0];
    assert.equal(route.result?.summary, "Second pass");
    assert.deepEqual(route.result?.sources, sources);
    assert.equal(route.draft, undefined);
    assert.equal(route.revision, 2);
    assert.deepEqual(route.gateReceipt, { id: "gate-2" });
    // A token with no draft left is refused rather than read as a review request.
    await assert.rejects(intake.recordResult(f.context, { intakeId: row.id, childId, token }), status(409));
    // Without a token or result, a duty holder only asks for review again.
    await intake.recordResult(f.context, { intakeId: row.id, childId });
    assert.equal((await f.service.get(row.id)).body.routes[0].revision, 2);
  } finally {
    f.client.close();
  }
});

test("routing with only a project keeps the routes; discovery work does not freeze it", async () => {
  const f = await fixture();
  try {
    let row = await f.service.create(input);
    row = await f.service.route(row, {
      routes: [{ kind: "research", dependsOn: [], rationale: "Research", gate }],
    });
    const projectId = "10000000-0000-4000-8000-0000000000d1";
    const routed = await intake.route(f.context, { intakeId: row.id, revision: row.revision, projectId });
    assert.equal(routed.body.projectId, projectId);
    assert.deepEqual(routed.body.routes.map((item) => item.id), row.body.routes.map((item) => item.id));
    const current = await f.service.get(row.id);
    current.body.routes[0].claim = { principal: "member", token: crypto.randomUUID(), until: Date.now() + 60000 };
    const claimed = await f.service.save(current);
    const other = "10000000-0000-4000-8000-0000000000d2";
    const moved = await intake.route(f.context, { intakeId: row.id, revision: claimed.revision, projectId: other });
    assert.equal(moved.body.projectId, other);
  } finally {
    f.client.close();
  }
});
