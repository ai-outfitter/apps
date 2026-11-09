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
