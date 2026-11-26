import assert from "node:assert/strict";
import test from "node:test";
import { buildSchema } from "graphql";
import {
  defineDocuments,
  documentRows,
  publishDocuments,
  type McpPublication,
} from "../src/app-documents";
import type { DocumentFederation } from "../src/document-federation";

test("published Markdown collections retain their canonical body field through generation", () => {
  const schema = buildSchema(
    `type Query { reports(first:Int,after:String): ReportConnection! } type ReportConnection { nodes:[Report!]! pageInfo:PageInfo! } type Report { title:String! slug:String! markdown:String! } type PageInfo { endCursor:String hasNextPage:Boolean! }`,
  );
  const publication: McpPublication = {
    description: "Current product reports",
    collection: true,
    provenance: "organizationSlug",
    markdown: { title: "title", slug: "slug", body: "markdown" },
  };
  const documents = publishDocuments(
    defineDocuments({
      ProductSummaries: {
        story:
          "As a member, I want current reports, so that I can review saved evidence.",
        document:
          "query ProductSummaries($first:Int,$after:String) { reports(first:$first,after:$after) { nodes { title slug markdown } pageInfo { endCursor hasNextPage } } }",
      },
    }),
    { ProductSummaries: publication },
  );
  const [row] = JSON.parse(
    JSON.stringify(documentRows(schema, documents)),
  ) as ReturnType<typeof documentRows>;
  const federation: DocumentFederation | undefined = row.federation;
  assert.deepEqual(federation?.markdown, {
    title: "title",
    slug: "slug",
    body: "markdown",
  });
  assert.equal(row.mcp?.markdown?.body, "markdown");
  assert.equal(row.hidden, undefined);
  assert.match(row.query, /markdown/);
});

test("only an explicitly published mutation can declare a longer execution budget", () => {
  const schema = buildSchema("type Query { value: String } type Mutation { save: String }");
  const save = { story: "As a member, I want to save, so that I can finish.", document: "mutation Save { save }",
    executionTimeoutMs: 840_000 };
  const declaration = publishDocuments({ Save: save }, { Save: { description: "Save work." } });
  assert.equal(documentRows(schema, declaration)[0].executionTimeoutMs, 840_000);
  assert.throws(() => documentRows(schema, { Save: save }), /requires an MCP-published mutation/);
  for (const invalid of [90_000, 840_001, 420_000.1]) {
    assert.throws(() => documentRows(schema, { Save: { ...declaration.Save, executionTimeoutMs: invalid } }), /840,000/);
  }
  assert.throws(() => documentRows(schema, { Save: { ...declaration.Save, hidden: true } }), /requires an MCP-published mutation/);
  assert.throws(() => documentRows(schema, { Value: { ...declaration.Save, document: "query Value { value }" } }),
    /requires an MCP-published mutation/);
});
