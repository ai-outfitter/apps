import assert from "node:assert/strict";
import test from "node:test";
import {
  homeCardCatalog,
  homeCardReadResult,
  type HomeCardNode,
  safeHomeCardPath,
  walkHomeCardNodes,
} from "@ai-outfitter/app-sdk/home-cards";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import type { Member } from "@ai-outfitter/app-test/worker";
import { core } from "../src/lib/graph";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const member = { userId: "member", organizationId: "org", role: "member" };
const cards = "/api/internal/home-cards/v1/";
const entities = "/api/internal/entities/v1/";
const artifact = () =>
  appArtifact(new URL("..", import.meta.url), "operational");
type App = Awaited<ReturnType<typeof appWorker>>;
type Ready = Extract<
  ReturnType<typeof homeCardReadResult.parse>,
  { status: "ready" }
>;

const uuid = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Row = {
  id: string;
  typeId: string;
  title: string;
  summary?: string;
  body?: string;
  archived?: boolean;
  updatedAt?: number;
};
async function insertNodes(app: App, rows: Row[]) {
  const db = app.database;
  const insert = db.prepare(
    "insert into graph_nodes (id,typeId,slug,title,summary,body,archived,revision,createdAt,updatedAt) values (?,?,?,?,?,?,?,1,?,?)",
  );
  await db.batch(
    rows.map((row) =>
      insert.bind(
        row.id,
        row.typeId,
        row.id,
        row.title,
        row.summary ?? "",
        row.body ?? "",
        row.archived ? 1 : 0,
        row.updatedAt ?? 1,
        row.updatedAt ?? 1,
      ),
    ),
  );
}
async function insertEdges(
  app: App,
  rows: { id: string; typeId: string; fromId: string; toId: string; archived?: boolean }[],
) {
  const db = app.database;
  const insert = db.prepare(
    "insert into graph_edges (id,typeId,fromId,toId,archived,revision,createdAt,updatedAt) values (?,?,?,?,?,1,1,1)",
  );
  await db.batch(
    rows.map((row) =>
      insert.bind(row.id, row.typeId, row.fromId, row.toId, row.archived ? 1 : 0),
    ),
  );
}
async function read(app: App, who: Member, size: string) {
  const response = await app.call(cards + "read", who, {
    method: "POST",
    body: { cardId: "recent-documents", size },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return homeCardReadResult.parse(await response.json());
}
function items(result: ReturnType<typeof homeCardReadResult.parse>) {
  assert.equal(result.status, "ready");
  const list = (result as Ready).body.find((node) => node.kind === "list");
  return list?.kind === "list" ? list.items : [];
}
function paths(body: HomeCardNode[]) {
  const found: string[] = [];
  walkHomeCardNodes(body, (node) => {
    if (node.kind === "link") found.push(node.target.path);
    if (node.kind === "empty" && node.link) found.push(node.link.target.path);
    if (node.kind === "list")
      for (const item of node.items) if (item.link) found.push(item.link.path);
  });
  return found;
}

test("recent documents: newest active Documents first, bounded by size, plain text and own links", async () => {
  const app = await appWorker("wiki-map", artifact());
  const personal = await appWorker("wiki-map", artifact(), "personal-wiki");
  const person = {
    userId: "person",
    organizationId: "",
    owner: { kind: "user", id: "person" },
    role: "owner",
  } as Member;
  try {
    assert.equal((await app.call(cards + "catalog")).status, 401);
    const catalog = homeCardCatalog.parse(
      await (await app.call(cards + "catalog", member)).json(),
    );
    assert.deepEqual(catalog.cards, [
      {
        cardId: "changes-review",
        title: "Today's Wiki changes",
        description: "What agents found for your Wiki, waiting for your review or created on a first run.",
        sizes: ["small", "medium", "large"],
        defaultSize: "medium",
        actionIds: [],
      },
      {
        cardId: "recent-documents",
        title: "Recent documents",
        description: "The most recently updated documents in this Wiki.",
        sizes: ["small", "medium", "large"],
        defaultSize: "medium",
        actionIds: [],
      },
    ]);

    const empty = await read(app, member, "medium");
    assert.equal(empty.status, "ready");
    const [placeholder] = (empty as Ready).body;
    assert.equal(placeholder.kind, "empty");
    assert.deepEqual(paths((empty as Ready).body), ["/documents"]);

    // Twelve documents; two share a timestamp so their IDs decide the order.
    await insertNodes(app, [
      ...Array.from({ length: 12 }, (_, n) => ({
        id: uuid("d0000000", n),
        typeId: core.document,
        title: `Document ${n}`,
        summary: n === 11 ? "**Bold** <b>note</b>\nwith [a link](https://example.com)" : "",
        body: "# Private body <script>alert(1)</script>",
        updatedAt: n === 10 ? 1000 + 11 : 1000 + n,
      })),
      {
        id: uuid("d0000000", 99),
        typeId: core.document,
        title: "Archived document",
        archived: true,
        updatedAt: 5000,
      },
      {
        id: uuid("e0000000", 1),
        typeId: core.goal,
        title: "Not a document",
        updatedAt: 6000,
      },
    ]);
    const expected = [10, 11, 9, 8, 7, 6, 5, 4, 3, 2].map((n) =>
      uuid("d0000000", n),
    );
    for (const [size, count] of [
      ["small", 3],
      ["medium", 5],
      ["large", 10],
    ] as const) {
      const result = await read(app, member, size);
      const list = items(result);
      assert.deepEqual(
        list.map((item) => item.id),
        expected.slice(0, count),
        size,
      );
      assert.equal(JSON.stringify(result).includes("Private body"), false);
      for (const path of paths((result as Ready).body))
        assert.ok(safeHomeCardPath(path), path);
      assert.deepEqual(
        list.map((item) => item.link),
        expected
          .slice(0, count)
          .map((id) => ({ path: `/documents/${id}` })),
      );
    }
    const [first, second] = items(await read(app, member, "small"));
    assert.equal(first.meta, "Updated 1970-01-01");
    assert.equal(first.subtitle, undefined);
    assert.equal(second.subtitle, "Bold note with a link");

    // Each installation is its own scope: a person's Wiki shows only theirs.
    assert.equal(
      items(await read(personal, person, "large")).length,
      0,
    );
    await insertNodes(personal, [
      { id: uuid("f0000000", 1), typeId: core.document, title: "Mine", updatedAt: 1 },
    ]);
    assert.deepEqual(
      items(await read(personal, person, "large")).map((item) => item.id),
      [uuid("f0000000", 1)],
    );
    assert.equal(
      items(await read(app, member, "large")).some(
        (item) => item.id === uuid("f0000000", 1),
      ),
      false,
    );
  } finally {
    await app.dispose();
    await personal.dispose();
  }
});

test("organization-goals projects outgoing pursues to active Goals, bounded on a large graph", async () => {
  const app = await appWorker("wiki-map", artifact());
  const get = (who: Member, id: string) =>
    app.call(entities + "get", who, {
      method: "POST",
      body: { type: "organization-goals", id },
    });
  try {
    const root = uuid("a0000000", 1),
      other = uuid("a0000000", 2),
      archivedOrganization = uuid("a0000000", 3),
      project = uuid("a0000000", 4),
      notGoal = uuid("a0000000", 5);
    const goal = (n: number) => uuid("b0000000", n);
    const filler = Array.from({ length: 1000 }, (_, n) => ({
      id: uuid("c0000000", n),
      typeId: n % 2 ? core.person : core.document,
      title: `Filler ${n}`,
    }));
    await insertNodes(app, [
      { id: root, typeId: core.organization, title: "Acme", summary: "Makes *things*" },
      { id: other, typeId: core.organization, title: "Other" },
      { id: archivedOrganization, typeId: core.organization, title: "Gone", archived: true },
      { id: project, typeId: core.project, title: "Project" },
      { id: notGoal, typeId: core.document, title: "Strategy memo" },
      ...Array.from({ length: 30 }, (_, n) => ({
        id: goal(n),
        typeId: core.goal,
        title: `Goal ${String(n).padStart(2, "0")}`,
        summary: n === 0 ? "Grow\nrevenue" : "",
        body: "secret body",
        archived: n === 29,
      })),
      ...filler,
    ]);
    let edge = 0;
    const pursue = (fromId: string, toId: string, archived = false, typeId: string = core.pursues) => ({
      id: uuid("e0000000", edge++),
      typeId,
      fromId,
      toId,
      archived,
    });
    await insertEdges(app, [
      // Root pursues goals 0..24 (24 has an archived relationship) and archived goal 29.
      ...Array.from({ length: 25 }, (_, n) => pursue(root, goal(n), n === 24)),
      pursue(root, goal(29)),
      pursue(root, notGoal),
      pursue(goal(25), root),
      pursue(project, goal(26)),
      pursue(root, goal(27), false, core.measured),
      pursue(other, goal(28)),
    ]);

    const response = await get(member, root);
    assert.equal(response.status, 200, await response.clone().text());
    const record = (await response.json()) as EntityRecord;
    assert.equal(record.ref.type, "organization-goals");
    assert.equal(record.ref.id, root);
    assert.equal(record.title, "Acme");
    const attributes = record.attributes as {
      organization: { ref: { id: string; type: string }; summary: string };
      goals: { ref: { installationId: string; type: string; id: string }; revision: number; summary: string; pursuit: { ref: { type: string } } }[];
      truncated: boolean;
    };
    assert.deepEqual(attributes.organization.ref, {
      installationId: app.installationId,
      type: "graph-node",
      id: root,
    });
    assert.equal(attributes.organization.summary, "Makes things");
    assert.equal(attributes.goals.length, 20);
    assert.equal(attributes.truncated, true);
    assert.deepEqual(
      attributes.goals.map((g) => g.ref.id),
      Array.from({ length: 20 }, (_, n) => goal(n)),
    );
    assert.equal(attributes.goals[0].summary, "Grow revenue");
    assert.equal(attributes.goals[0].pursuit.ref.type, "graph-edge");
    assert.equal(attributes.goals[0].ref.installationId, app.installationId);
    assert.equal(JSON.stringify(record).includes("secret body"), false);

    const second = (await (await get(member, other)).json()) as EntityRecord;
    assert.deepEqual(
      (second.attributes.goals as { ref: { id: string } }[]).map((g) => g.ref.id),
      [goal(28)],
    );
    assert.equal(second.attributes.truncated, false);

    // Fake roots: a Goal, a missing node and an archived Organization are not found.
    for (const id of [goal(0), archivedOrganization, uuid("a0000000", 99)])
      assert.equal((await get(member, id)).status, 404, id);

    const list = (await (
      await app.call(entities + "list", member, {
        method: "POST",
        body: { type: "organization-goals", limit: 100 },
      })
    ).json()) as EntityRecord[];
    // Seeded starter Organizations are listed too; archived ones never are.
    const listed = list.map((row) => row.ref.id);
    assert.ok(listed.includes(root) && listed.includes(other));
    assert.equal(listed.includes(archivedOrganization), false);
    assert.deepEqual(listed, [...listed].sort());
    const types = (await (await app.call(entities + "types", owner)).json()) as {
      type: string;
      writable: boolean;
      operations: string[];
    }[];
    const projection = types.find((t) => t.type === "organization-goals");
    assert.equal(projection?.writable, false);
    assert.deepEqual(projection?.operations, ["list", "get"]);
    assert.equal(
      (
        await app.call(entities + "create", owner, {
          method: "POST",
          body: { type: "organization-goals", attributes: {} },
        })
      ).status,
      403,
    );
  } finally {
    await app.dispose();
  }
});
