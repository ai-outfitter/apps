import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { graphql } from "graphql";
import { graphContext, memorySource } from "@ai-outfitter/app-sdk/graph-graphql";
import { authoredWiki } from "./issue-273-fixtures";

type Row = (typeof authoredWiki)[number];
type Variables = { start: string; end: string; limit: number; cursor?: string };

export async function wikiFixture(includeAuthored: boolean) {
  const { graphqlSchema } = await import("../../../wiki/src/documents/graphql");
  const rows = includeAuthored ? authoredWiki : [];
  const scopes = ["personal", "fixture-team", "other-team"];
  const stores = new Map(scopes.map(scope => [scope, new DatabaseSync(":memory:")]));
  const close = () => { for (const db of stores.values()) db.close(); };
  try {
    const files = ["0000_graph.sql", "0008_graph_batches.sql", "0012_documents.sql"];
    const migrations = await Promise.all(files.map(file => readFile(new URL(`../../../wiki/migrations/${file}`, import.meta.url), "utf8")));
    for (const [scope, db] of stores) {
      for (const migration of migrations) db.exec(migration);
      const type = db.prepare("select id from graph_types where name='Document'").get()?.id;
      for (const row of rows.filter(row => row.scope === scope)) seed(db, row, String(type));
    }
  } catch (error) {
    close();
    throw error;
  }

  return { close, async read(variables: Variables) {
    // The test host grants exactly these two installs. The actual SDK/Wiki resolver
    // receives both storage generations within each install and applies its own filters.
    const permitted = await Promise.all([...stores].filter(([scope]) => scope !== "other-team").map(async ([scope, db]) => {
      const result = await graphql({
        schema: graphqlSchema,
        source: "query($start:String!,$end:String!,$first:Int){wikiRevisionActivity(start:$start,end:$end,first:$first){nodes{id slug revision title createdAt store} pageInfo{hasNextPage}}}",
        variableValues: { start: variables.start, end: variables.end, first: variables.limit },
        contextValue: graphContext(memorySource({ installationId: scope, types: [], nodes: [], edges: [] }), { database: { query: async ({ sql, params }: { sql: string; params: SQLInputValue[] }) => db.prepare(sql).all(...params) } }),
      });
      if (result.errors?.length || !result.data) throw new Error(result.errors?.map(error => error.message).join("; ") || "Wiki activity returned no data");
      const resultPage = result.data.wikiRevisionActivity as { nodes: Omit<Row, "scope">[]; pageInfo: { hasNextPage: boolean } };
      if (resultPage.pageInfo.hasNextPage) throw new Error("Raw Wiki fixture exceeded one installation page");
      return resultPage.nodes.map(row => ({ ...row, scope }));
    }));
    const sorted = permitted.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    // Deliberately split the small federation result to exercise Forerunner pagination.
    return { data: { wikiRevisionActivity: variables.cursor ? sorted.slice(1) : sorted.slice(0, 1) }, ...(!variables.cursor && sorted.length > 1 ? { next: "page-2" } : {}) };
  } };
}

function seed(db: DatabaseSync, row: Row, type: string) {
  const at = Date.parse(row.createdAt);
  if (row.store === "document") {
    db.prepare("insert into wiki_documents(id,revision,createdAt,updatedAt) values(?,?,?,?)").run(row.id, row.revision, at, at);
    db.prepare("insert into wiki_pages(id,slug,documentId,updatedAt) values(?,?,?,?)").run(row.id, row.slug, row.id, at);
    db.prepare("insert into wiki_document_revisions(documentId,revision,title,provenance,createdAt) values(?,?,?,?,?)")
      .run(row.id, row.revision, row.title, "provenance" in row ? JSON.stringify({ kind: row.provenance }) : null, at);
  } else {
    db.prepare("insert into graph_nodes(id,typeId,slug,title,revision,createdAt,updatedAt) values(?,?,?,?,?,?,?)").run(row.id, type, row.slug, row.title, row.revision, at, at);
    db.prepare("insert into graph_revisions(kind,recordId,revision,proposedBy,approval,snapshot,createdAt) values('graph-node',?,?,'fixture','{}',?,?)")
      .run(row.id, row.revision, JSON.stringify({ slug: row.slug, title: row.title }), at);
  }
}
