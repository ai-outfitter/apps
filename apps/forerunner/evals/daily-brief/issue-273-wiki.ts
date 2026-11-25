import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { authoredWiki } from "./issue-273-fixtures";

type Row = (typeof authoredWiki)[number];
type Variables = { start: string; end: string; limit: number; cursor?: string };
type WikiWorker = Awaited<ReturnType<typeof appWorker>>;

export async function wikiFixture(includeAuthored: boolean) {
  const rows = includeAuthored ? authoredWiki : [];
  const stores = new Map<string, WikiWorker>();
  const close = async () => { await Promise.all([...stores.values()].map(app => app.dispose())); };
  try {
    for (const scope of ["personal", "fixture-team", "other-team"]) {
      const app = await appWorker("wiki-map", appArtifact(new URL("../../../wiki", import.meta.url), "operational"), scope);
      stores.set(scope, app);
      const type = await app.database.prepare("SELECT id FROM graph_types WHERE name='Document'").first<string>("id");
      if (!type) throw new Error("Installed Wiki is missing its legacy Document type");
      for (const row of rows.filter(row => row.scope === scope)) await seed(app.database, row, type);
    }
  } catch (error) {
    await close();
    throw error;
  }

  return { close, async read(variables: Variables) {
    // The fixture federation grants these two installs. Each real Wiki dispatch
    // reads both stores and applies its own authored activity filter.
    const permitted = await Promise.all([...stores].filter(([scope]) => scope !== "other-team").map(async ([scope, app]) => {
      const member = scope === "personal" ? { userId: "fixture-member", role: "owner", organizationId: "", owner: { kind: "user" as const, id: "fixture-member" } }
        : { userId: "fixture-member", role: "owner", organizationId: scope, owner: { kind: "organization" as const, id: scope } };
      const response = await app.call("/api/apps/wiki-map/documents", member, {
        method: "POST",
        body: { operation: "WikiRevisionActivity", variables: { start: variables.start, end: variables.end, first: variables.limit } },
      });
      if (!response.ok) throw new Error(`Installed Wiki revision read returned ${response.status}`);
      const result = await response.json() as { wikiRevisionActivity: { nodes: Omit<Row, "scope">[]; pageInfo: { hasNextPage: boolean } } };
      if (result.wikiRevisionActivity.pageInfo.hasNextPage) throw new Error("Wiki fixture exceeded one installation page");
      return result.wikiRevisionActivity.nodes.map(row => ({ ...row, scope }));
    }));
    const sorted = permitted.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    // Deliberately split the fixture federation result to exercise Forerunner pagination.
    return { data: { wikiRevisionActivity: variables.cursor ? sorted.slice(1) : sorted.slice(0, 1) }, ...(!variables.cursor && sorted.length > 1 ? { next: "page-2" } : {}) };
  } };
}

async function seed(db: WikiWorker["database"], row: Row, type: string) {
  const at = Date.parse(row.createdAt);
  if (row.store === "document") {
    await db.batch([
      db.prepare("insert into wiki_documents(id,revision,createdAt,updatedAt) values(?,?,?,?)").bind(row.id, row.revision, at, at),
      db.prepare("insert into wiki_pages(id,slug,documentId,updatedAt) values(?,?,?,?)").bind(row.id, row.slug, row.id, at),
      db.prepare("insert into wiki_document_revisions(documentId,revision,title,provenance,createdAt) values(?,?,?,?,?)")
        .bind(row.id, row.revision, row.title, "provenance" in row ? JSON.stringify({ kind: row.provenance }) : null, at),
    ]);
  } else {
    await db.batch([
      db.prepare("insert into graph_nodes(id,typeId,slug,title,revision,createdAt,updatedAt) values(?,?,?,?,?,?,?)").bind(row.id, type, row.slug, row.title, row.revision, at, at),
      db.prepare("insert into graph_revisions(kind,recordId,revision,proposedBy,approval,snapshot,createdAt) values('graph-node',?,?,'fixture','{}',?,?)")
        .bind(row.id, row.revision, JSON.stringify({ slug: row.slug, title: row.title }), at),
    ]);
  }
}
