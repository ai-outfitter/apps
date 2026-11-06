import assert from "node:assert/strict";
import test from "node:test";
import { GraphQLList, GraphQLObjectType, GraphQLSchema, GraphQLString, parse, printSchema } from "graphql";
import { z } from "zod";
import { documentRows, defineDocuments } from "../src/app-documents";
import { documentRunner, graphGraphqlResult, mutateAction, mutationField, serveGraphql } from "../src/app-graphql";
import type { TadaDocumentNode } from "../src/graph-graphql-typed";

const saved: unknown[] = [];
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: "Query", fields: {
    hello: { type: GraphQLString, resolve: () => "hi" },
    many: { type: new GraphQLList(GraphQLString), resolve: () => Array.from({ length: 400 }, () => "x".repeat(1000)) },
    huge: { type: GraphQLString, resolve: () => "x".repeat(300_000) },
    broken: { type: GraphQLString, resolve: () => { throw new Error("boom"); } },
  } }),
  mutation: new GraphQLObjectType({ name: "Mutation", fields: {
    addNote: mutationField({
      name: "AddNote", description: "Add a note.",
      input: z.strictObject({ title: z.string().min(1), kind: z.enum(["idea", "task"]), projectId: z.uuid().optional(), tags: z.array(z.string()).default([]), revision: z.number().int().min(1).optional() }),
      run: (_context, input) => {
        if (input.title === "no") throw new Response("Not this one", { status: 409 });
        saved.push(input);
        return { id: "n1", ...input };
      },
    }),
  } }),
});
const run = async (query: string, extra: { variables?: Record<string, unknown>; operation?: "query" | "mutation" } = {}) =>
  graphGraphqlResult.parse(await serveGraphql({ schema, query, ...extra }));

test("mutationField types its input from zod and still validates with it", async () => {
  const sdl = printSchema(schema);
  assert.match(sdl, /addNote\(input: AddNoteInput!\): JSON/);
  assert.match(sdl, /input AddNoteInput \{\n {2}title: String!\n {2}kind: AddNoteInputKind!\n {2}projectId: ID\n {2}tags: \[String!\]\n {2}revision: Float\n\}/);
  assert.match(sdl, /enum AddNoteInputKind \{\n {2}idea\n {2}task\n\}/);
  const added = await run(`mutation Add($input: AddNoteInput!) { addNote(input: $input) }`, { variables: { input: { title: "Ship", kind: "task" } }, operation: "mutation" });
  assert.deepEqual(added.data, { addNote: { id: "n1", title: "Ship", kind: "task", tags: [] } });
  const bad = await run(`mutation { addNote(input: { title: "", kind: idea }) }`, { operation: "mutation" });
  assert.equal(bad.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  const refused = await run(`mutation { addNote(input: { title: "no", kind: idea }) }`, { operation: "mutation" });
  assert.deepEqual([refused.errors?.[0]?.message, refused.errors?.[0]?.extensions], ["Not this one", { code: "REFUSED", status: 409 }]);
});

test("a request runs only its own operation kind: graph.graphql reads, graph.mutate writes", async () => {
  const before = saved.length;
  const read = await run(`mutation { addNote(input: { title: "x", kind: idea }) }`);
  assert.equal(read.errors?.[0]?.extensions?.code, "OPERATION_NOT_ALLOWED");
  const write = await run(`{ hello }`, { operation: "mutation" });
  assert.equal(write.errors?.[0]?.extensions?.code, "OPERATION_NOT_ALLOWED");
  assert.equal(saved.length, before);
  assert.deepEqual((await run(`{ hello }`)).data, { hello: "hi" });
});

test("mutateAction is a write for editors unless canInvoke says otherwise", async () => {
  assert.throws(() => mutateAction(new GraphQLSchema({ query: schema.getQueryType() })), /Mutation type/);
  const action = mutateAction(schema);
  assert.equal(action.access, "write");
  const context = (canEdit: boolean) => ({ identity: { userId: "u", canEdit }, actor: {}, originActor: {} }) as never;
  const input = { query: `mutation { addNote(input: { title: "y", kind: idea }) }` };
  assert.deepEqual(await action.invoke(context(true), input), { data: { addNote: { id: "n1", title: "y", kind: "idea", tags: [] } } });
  await assert.rejects(Promise.resolve().then(() => action.invoke(context(false), input)), (error: unknown) => error instanceof Response && error.status === 403);
  const anyone = mutateAction(schema, { canInvoke: () => true });
  assert.ok(await anyone.invoke(context(false), input));
});

test("documentRows checks stories, names and the schema, and lists every problem", () => {
  const documents = defineDocuments({
    Hello: { story: "As a member, I want a greeting, so that I know the app answers.", document: "query Hello { hello }" },
    AddNote: { story: "As an editor, I want to add a note, so that the team sees it.", document: "mutation AddNote($input: AddNoteInput!) { addNote(input: $input) }" },
  });
  const rows = documentRows(schema, documents);
  assert.deepEqual(rows.map(row => [row.name, row.kind]), [["AddNote", "mutation"], ["Hello", "query"]]);
  assert.match(rows[0].hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(rows[0].variables, { type: "object", properties: { input: { description: "GraphQL AddNoteInput!" } }, required: ["input"] });
  assert.throws(() => documentRows(schema, {
    NoStory: { story: "Adds a note", document: "query NoStory { hello }" },
    Misnamed: { story: "As a member, I want x, so that y.", document: "query Other { hello }" },
    Invalid: { story: "As a member, I want x, so that y.", document: "query Invalid { missing }" },
  }), (error: Error) => /NoStory: story/.test(error.message) && /Misnamed: the operation must be named Misnamed/.test(error.message) && /Invalid: Cannot query field "missing"/.test(error.message));
});

test("nullable required fields accept null, and enums GraphQL cannot name stay strings", async () => {
  const cleared: unknown[] = [];
  const edge = new GraphQLSchema({
    query: schema.getQueryType(),
    mutation: new GraphQLObjectType({ name: "Mutation", fields: {
      setDue: mutationField({ name: "SetDue", description: "Set or clear a due date.", input: z.strictObject({ dueDate: z.string().nullable(), flag: z.enum(["true", "false"]) }),
        run: (_context, input) => { cleared.push(input); return true; } }),
    } }),
  });
  assert.match(printSchema(edge), /input SetDueInput \{\n {2}dueDate: String\n {2}flag: String!\n\}/);
  const result = graphGraphqlResult.parse(await serveGraphql({ schema: edge, query: `mutation { setDue(input: { dueDate: null, flag: "true" }) }`, operation: "mutation" }));
  assert.deepEqual([result.data, cleared], [{ setDue: true }, [{ dueDate: null, flag: "true" }]]);
});

test("documentRunner answers a page's document whole, or as the route's Response or Error", async () => {
  const runDocument = documentRunner<{ who: string }>(() => schema);
  const doc = (text: string) => parse(text) as unknown as TadaDocumentNode<Record<string, unknown>, Record<string, unknown>>;
  const thrown = (text: string, variables: Record<string, unknown> = {}) => runDocument(doc(text), variables, { who: "u" }).then(() => assert.fail("expected a throw"), (error: unknown) => error);
  const answer = async (text: string, variables: Record<string, unknown> = {}) => {
    const error = await thrown(text, variables);
    assert.ok(error instanceof Response, String(error));
    return [error.status, await error.text()];
  };
  const add = `mutation Add($input: AddNoteInput!) { addNote(input: $input) }`;
  assert.deepEqual({ ...await runDocument(doc(add), { input: { title: "Run", kind: "idea" } }, { who: "u" }) }, { addNote: { id: "n1", title: "Run", kind: "idea", tags: [] } });
  // A refusal keeps its status and text; invalid input, or a variable its type rejects, is an opaque 400.
  assert.deepEqual(await answer(add, { input: { title: "no", kind: "idea" } }), [409, "Not this one"]);
  assert.deepEqual(await answer(add, { input: { title: "", kind: "idea" } }), [400, "Invalid input"]);
  assert.deepEqual(await answer(add, { input: { title: "x", kind: "nope" } }), [400, "Invalid input"]);
  // A list cut to fit 256 KiB, or an answer that cannot fit at all, is a 500; anything else is rethrown.
  assert.deepEqual(await answer(`query Many { many }`), [500, "The response was too large to return whole"]);
  assert.equal((await answer(`query Huge { huge }`))[0], 500);
  const broken = await thrown(`query Broken { broken }`);
  assert.ok(broken instanceof Error && /broken: boom/.test(broken.message), String(broken));
});
