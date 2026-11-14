import { wikiFixtureCall } from "@ai-outfitter/app-test/wiki-fixture";
import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { useCaseTypeId } from "../src/server/use-cases";
const owner = { userId: "owner", organizationId: "org", role: "owner" };

test("Planning stores use cases in Wiki, preserves edits on setup, and enforces project scope and revisions", async () => {
  const hostCalls: string[] = [];
  const wiki = await appWorker(
    "wiki-map",
    appArtifact(new URL("../../onto", import.meta.url), "operational"),
  );
  // Onto checks edge endpoints against existing types, so seed its standard types as an installed Wiki has them.
  assert.equal((await wiki.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "planning-use-cases",
    {
      workflowHost: () => ({
        async call(operation, input) {
          hostCalls.push(operation);
          return wikiFixtureCall(wiki, owner, operation, input);
        },
      }),
    },
  );
  const scope = {
    organizationId: "org",
    installationId: app.installationId,
    userId: owner.userId,
    packageHash: "test",
    phase: "interactive" as const,
    expiresAt: Date.now() + 600000,
  };
  const call = (path: string, body?: object, identity = owner) =>
    app.call(`/api/apps/planning${path}`, identity, {
      ...(body ? { method: "POST", body } : {}),
      workflowHost: scope,
    });
  const document = {
    actor: "Member",
    goal: "Choose useful work",
    trigger: "Ready to work",
    steps: "Review goals and choose an issue",
    alternatives: "Ask for a blocking decision",
    successCriteria: "The chosen issue supports a goal",
  };
  try {
    // Operator-key upgrades defer member-scoped initialization to this visit.
    const firstVisit = await call("/use-cases/context", {});
    assert.equal(firstVisit.status, 200, await firstVisit.clone().text());
    // One coalesced discovery: Onto, then the legacy Wiki template it must not shadow.
    assert.equal(
      hostCalls.filter((operation) => operation === "entities.types").length,
      2,
    );
    assert.ok(
      hostCalls.includes("entities.create"),
      "first editor visit initializes the use-case type",
    );
    const setup = await app.call("/api/internal/app-initialize", owner, {
      method: "POST",
      body: {},
      workflowHost: scope,
    });
    assert.equal(setup.status, 200, await setup.clone().text());
    assert.equal(
      ((await setup.json()) as { installationId: string }).installationId,
      wiki.installationId,
    );
    const types = (await (
      await wiki.call("/api/internal/entities/v1/list", owner, {
        method: "POST",
        body: { type: "graph-type", limit: 100 },
      })
    ).json()) as EntityRecord[];
    for (const [kind, name, title] of [
      ["opportunities", "Problem", "Choosing useful work is difficult"],
      ["customer-segments", "CustomerSegment", "Small teams"],
    ]) {
      const type = types.find((row) => row.attributes.name === name);
      assert.ok(type);
      const created = await wiki.call(
        "/api/internal/entities/v1/create",
        owner,
        {
          method: "POST",
          body: {
            type: "graph-node",
            attributes: {
              typeId: type.ref.id,
              title,
              summary: "Existing Wiki context",
            },
          },
        },
      );
      assert.equal(created.status, 200);
      const discovery = await call(`/discovery/${kind}`, undefined, {
        ...owner,
        role: "member",
      });
      assert.equal(discovery.status, 200, await discovery.clone().text());
      const result = (await discovery.json()) as {
        records: EntityRecord[];
        wiki: { installationId: string };
      };
      assert.equal(result.wiki.installationId, wiki.installationId);
      assert.ok(result.records.some((row) => row.title === title));
      assert.ok(
        result.records.every((row) => row.attributes.typeId === type.ref.id),
      );
    }
    assert.equal((await call("/discovery/unknown")).status, 404);
    const p = (await (await call("/projects", { name: "Plan" })).json()) as {
      id: string;
    };
    const q = (await (await call("/projects", { name: "Other" })).json()) as {
      id: string;
    };
    const draft = {
      projectId: p.id,
      title: "Choose work",
      document,
    };
    assert.equal(
      (await call("/use-cases", { ...draft, title: "" })).status,
      400,
    );
    assert.equal(
      (await call("/use-cases", { ...draft, projectId: crypto.randomUUID() }))
        .status,
      404,
    );
    const response = await call("/use-cases", draft);
    assert.equal(response.status, 200, await response.clone().text());
    const saved = (await response.json()) as EntityRecord;
    assert.equal(saved.ref.installationId, wiki.installationId);
    assert.equal(saved.attributes.typeId, useCaseTypeId);
    assert.deepEqual(saved.attributes.properties, {
      planning_installation_id: app.installationId,
      project_id: p.id,
    });
    const directly = await wiki.call("/api/internal/entities/v1/get", owner, {
      method: "POST",
      body: { type: "graph-node", id: saved.ref.id },
    });
    assert.deepEqual(
      JSON.parse(
        ((await directly.json()) as EntityRecord).attributes.body as string,
      ),
      document,
    );
    const updated = await call("/use-cases", {
      ...draft,
      id: saved.ref.id,
      revision: 1,
      title: "Choose valuable work",
    });
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal(
      (await call("/use-cases", { ...draft, id: saved.ref.id, revision: 1 }))
        .status,
      409,
    );
    assert.equal(
      (
        await call("/use-cases", {
          ...draft,
          projectId: q.id,
          id: saved.ref.id,
          revision: 2,
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("/use-cases", { ...draft, installationId: "foreign" }))
        .status,
      400,
    );
    assert.equal(
      (await call("/use-cases", draft, { ...owner, role: "member" })).status,
      403,
    );
    hostCalls.length = 0;
    const again = await call("/use-cases/context", {});
    assert.equal(again.status, 200);
    assert.deepEqual(
      hostCalls,
      // One discovery (Onto, then the legacy Wiki template), then UseCase, the intake ontology's two types, then the code-change definitions (CodeChange, delivers, merged_into), then the measurement definitions (Measure, Measurement, computes, measurement_of, captured_with).
      ["entities.types", "entities.types", ...Array(11).fill("entities.get")],
      "navigation checks add-only setup without rediscovering Wiki",
    );
    assert.equal((await call("/use-cases/setup", {})).status, 404);
    const query = `?${new URLSearchParams({ installationId: wiki.installationId, projectId: p.id })}`;
    const list = (await (
      await call(`/use-cases${query}`)
    ).json()) as EntityRecord[];
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "Choose valuable work");
    const otherCase = await call("/use-cases", {
      ...draft,
      projectId: q.id,
      title: "Other project use case",
    });
    assert.equal(otherCase.status, 200);
    const allQuery = `?${new URLSearchParams({ installationId: wiki.installationId })}`;
    const allCases = (await (
      await call(`/use-cases${allQuery}`)
    ).json()) as EntityRecord[];
    assert.deepEqual(
      allCases.map((row) => row.title).sort((a, b) => a.localeCompare(b)),
      ["Choose valuable work", "Other project use case"],
    );
    const archive = await call("/use-cases", {
      ...draft,
      id: saved.ref.id,
      revision: 2,
      archived: true,
    });
    assert.equal(archive.status, 200);
    assert.deepEqual(await (await call(`/use-cases${query}`)).json(), []);
    assert.equal(
      (
        await wiki.call("/api/internal/entities/v1/get", owner, {
          method: "POST",
          body: { type: "graph-node", id: saved.ref.id },
        })
      ).status,
      200,
    );
  } finally {
    await app.dispose();
    await wiki.dispose();
  }
});
