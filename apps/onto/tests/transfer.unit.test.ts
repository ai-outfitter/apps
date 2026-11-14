import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { core } from "../src/lib/graph";
import {
  changes,
  configureTarget,
  decodeToolResult,
  discover,
  resolvePending,
  exportFile,
  transferFile,
  uploadFile,
  type Call,
  type Journal,
} from "../scripts/transfer";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";

function fixture() {
  const rows: EntityRecord[] = [];
  const writes: string[] = [];
  for (const [id, category, name] of [
    [core.project, "node", "Project"],
    [core.person, "node", "Person"],
    [core.participates, "edge", "participant"],
  ]) {
    rows.push({
      ref: { id, type: "graph-type", installationId: "wiki" },
      title: name,
      revision: 1,
      references: [],
      attributes: {
        category,
        name,
        title: name,
        body: name,
        properties: [],
        archived: false,
      },
    });
  }
  const call: Call = async (name, args) => {
    if (name === "list_entities")
      return rows
        .filter(
          (row) =>
            row.ref.type === args.type &&
            row.ref.installationId === args.installationId,
        )
        .slice(Number(args.offset), Number(args.offset) + Number(args.limit));
    if (name === "get_entity")
      return rows.find((row) => row.ref.id === args.id)!;
    writes.push(name);
    if (name === "create_entity") {
      const row: EntityRecord = {
        ref: {
          id: randomUUID(),
          type: String(args.type),
          installationId: String(args.installationId),
        },
        title: "Test",
        revision: 1,
        attributes: args.attributes as EntityRecord["attributes"],
        references: args.references as EntityRecord["references"],
      };
      rows.push(row);
      return structuredClone(row);
    }
    const row = rows.find((row) => row.ref.id === args.id)!;
    assert.equal(args.revision, row.revision);
    Object.assign(row.attributes, args.attributes);
    row.revision++;
    return structuredClone(row);
  };
  const journal: Journal = {
    endpoint: "https://example.com/mcp",
    wiki: "wiki",
    planning: "planning",
    entries: {},
  };
  const project = randomUUID(),
    one = randomUUID(),
    two = randomUUID();
  const file = transferFile.parse({
    format: "outfitter-graph-entities-v1",
    projects: [
      {
        id: project,
        typeId: core.project,
        title: "Mission",
        source: {
          installationId: "local-planning",
          type: "project",
          id: randomUUID(),
        },
      },
    ],
    nodes: [one, two].map((id) => ({
      id,
      typeId: core.person,
      title: "Same name",
      body: "Original",
    })),
    edges: [
      {
        id: randomUUID(),
        typeId: core.participates,
        fromId: one,
        toId: project,
      },
    ],
  });
  return { rows, writes, call, journal, file };
}
test("upload previews then creates distinct people and canonical projects; export restores portable IDs without private fields", async () => {
  const f = fixture();
  assert.equal(
    (await uploadFile(f.call, f.file, f.journal, async () => {})).create,
    5,
  );
  assert.equal(f.writes.length, 0);
  await uploadFile(f.call, f.file, f.journal, async () => {}, true);
  assert.equal(f.rows.filter((row) => row.ref.type === "project").length, 1);
  assert.equal(
    f.rows.filter((row) => row.attributes.typeId === core.person).length,
    2,
  );
  const project = f.rows.find((row) => row.attributes.typeId === core.project)!;
  assert.equal(project.references[0].installationId, "planning");
  const edge = f.rows.find((row) => row.ref.type === "graph-edge")!;
  assert.equal(edge.attributes.toId, project.ref.id);
  project.attributes.connectorNotes = { email: "private@example.test" };
  project.attributes.provenance = { createdBy: "private-user" };
  const output = await exportFile(f.call, f.journal);
  assert.equal(output.projects[0].id, f.file.projects[0].id);
  assert.equal(output.edges[0].toId, f.file.projects[0].id);
  assert.doesNotMatch(JSON.stringify(output), /private@example|private-user/);
  const before = f.writes.length;
  await uploadFile(f.call, output, f.journal, async () => {}, true);
  assert.equal(f.writes.length, before);
});
test("independent local and agent changes survive repeated uploads; overlapping changes conflict", async () => {
  const f = fixture();
  await uploadFile(f.call, f.file, f.journal, async () => {}, true);
  const person = f.rows.find(
    (row) =>
      row.ref.id ===
      f.journal.entries[`graph-node/${f.file.nodes[0].id}`].ref.id,
  )!;
  person.attributes.body = "Agent documentation";
  person.revision++;
  f.file.nodes[0].summary = "Local summary";
  await uploadFile(f.call, f.file, f.journal, async () => {}, true);
  await uploadFile(f.call, f.file, f.journal, async () => {}, true);
  assert.equal(person.attributes.body, "Agent documentation");
  assert.equal(person.attributes.summary, "Local summary");
  f.file.nodes[0].body = "Conflicting local documentation";
  await assert.rejects(
    uploadFile(f.call, f.file, f.journal, async () => {}),
    /Conflicting body/,
  );
});
test("lost create response leaves a durable stop before any retry", async () => {
  const f = fixture();
  let saved = 0;
  const lost: Call = async (name, args) => {
    const result = await f.call(name, args);
    if (name === "create_entity") throw new Error("response lost");
    return result;
  };
  await assert.rejects(
    uploadFile(
      lost,
      f.file,
      f.journal,
      async () => {
        saved++;
      },
      true,
    ),
    /response lost/,
  );
  assert.ok(saved);
  assert.ok(f.journal.pending);
  const writes = f.writes.length;
  await assert.rejects(
    uploadFile(f.call, f.file, f.journal, async () => {}, true),
    /Uncertain create/,
  );
  assert.equal(f.writes.length, writes);
});
test("field merging and seed validation reject ambiguity", () => {
  assert.deepEqual(
    changes({ body: "old" }, { body: "agent" }, { body: "old" }),
    {},
  );
  assert.throws(
    () => changes({ body: "local" }, { body: "agent" }),
    /Conflicting/,
  );
  const f = fixture();
  f.file.nodes.push(f.file.nodes[0]);
  assert.equal(transferFile.safeParse(f.file).success, false);
});

test("definite refusals clear pending while preserving the server explanation", async () => {
  const f = fixture();
  const rejected: Call = async (name, args) => {
    if (name === "create_entity")
      return decodeToolResult({
        isError: true,
        content: [{ type: "text", text: "Choose existing active entities" }],
      });
    return f.call(name, args);
  };
  await assert.rejects(
    uploadFile(rejected, f.file, f.journal, async () => {}, true),
    /Choose existing active entities/,
  );
  assert.equal(f.journal.pending, undefined);
});

test("preflight rejects archived endpoints, self loops and invalid types before any writes", async () => {
  for (const scenario of ["archived", "self", "type"] as const) {
    const f = fixture();
    if (scenario === "archived") f.file.nodes[0].archived = true;
    if (scenario === "self") f.file.edges[0].toId = f.file.edges[0].fromId;
    if (scenario === "type") f.file.edges[0].typeId = core.person;
    await assert.rejects(
      uploadFile(f.call, f.file, f.journal, async () => {}, true),
      /archived endpoint|Self relationship|Invalid active edge type/,
    );
    assert.equal(f.writes.length, 0);
  }
});

test("new custom types remap references and export with the original portable IDs", async () => {
  const f = fixture();
  const id = randomUUID();
  f.file.types.push({
    id,
    category: "node",
    name: "Custom",
    title: "Custom",
    body: "Description",
    properties: [],
    archived: false,
  });
  f.file.nodes[0].typeId = id;
  await uploadFile(f.call, f.file, f.journal, async () => {}, true);
  const mapped = f.journal.entries[`graph-type/${id}`].ref.id;
  assert.notEqual(mapped, id);
  const node = f.rows.find(
    (row) =>
      row.ref.id ===
      f.journal.entries[`graph-node/${f.file.nodes[0].id}`].ref.id,
  );
  assert.equal(node?.attributes.typeId, mapped);
  const output = await exportFile(f.call, f.journal);
  assert.equal(
    output.nodes.find((row) => row.id === f.file.nodes[0].id)?.typeId,
    id,
  );
});

test("read-only Wiki discovery needs neither Planning nor writable access", async () => {
  await discover(
    async () =>
      ["graph-type", "graph-node", "graph-edge"].map((type) => ({
        installationId: "wiki",
        type,
        writable: false,
      })),
    "wiki",
  );
});

test("a lost create can be reconciled to a verified record without replay", async () => {
  const f = fixture();
  const lost: Call = async (name, args) => {
    const value = await f.call(name, args);
    if (name === "create_entity") throw new Error("response lost");
    return value;
  };
  await assert.rejects(
    uploadFile(lost, f.file, f.journal, async () => {}, true),
  );
  const record = f.rows.find((row) => row.ref.type === "project");
  assert.ok(record);
  await resolvePending(f.call, f.journal, record.ref.id);
  assert.equal(f.journal.pending, undefined);
  await uploadFile(f.call, f.file, f.journal, async () => {}, true);
  assert.equal(f.rows.filter((row) => row.ref.type === "project").length, 1);
});

test("unchanged historical nodes survive a round trip after their type is archived", async () => {
  const f = fixture();
  await uploadFile(f.call, f.file, f.journal, async () => {}, true);
  const type = f.rows.find((row) => row.ref.id === core.person);
  assert.ok(type);
  type.attributes.archived = true;
  const output = await exportFile(f.call, f.journal);
  const before = f.writes.length;
  await uploadFile(f.call, output, f.journal, async () => {}, true);
  assert.equal(f.writes.length, before);
});

test("adding Planning preserves an existing Wiki receipt; switching destinations fails", () => {
  const f = fixture();
  delete f.journal.planning;
  f.journal.entries.existing = {
    ref: { installationId: "wiki", type: "graph-node", id: "saved-id" },
    base: {},
    references: [],
  };
  configureTarget(f.journal, f.journal.endpoint, "wiki", "planning");
  assert.equal(f.journal.planning, "planning");
  assert.ok(f.journal.entries.existing);
  assert.throws(
    () =>
      configureTarget(
        f.journal,
        f.journal.endpoint,
        "wiki",
        "another-planning",
      ),
    /another target/,
  );
});

test("standalone projects round trip without Planning records or a Planning installation", async () => {
  const f = fixture();
  f.journal.planning = undefined;
  const id = randomUUID();
  const file = transferFile.parse({ format: "outfitter-graph-entities-v1", nodes: [{ id, typeId: core.project, title: "External recommendations" }] });
  await uploadFile(f.call, file, f.journal, async () => {}, true);
  assert.equal(f.rows.filter(row => row.ref.type === "project").length, 0);
  const project = f.rows.find(row => row.attributes.typeId === core.project)!;
  assert.deepEqual(project.references, []);
  const output = await exportFile(f.call, f.journal);
  assert.equal(output.nodes[0].id, id);
  assert.deepEqual(output.projects, []);
});
