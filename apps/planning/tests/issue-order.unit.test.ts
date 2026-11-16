import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient, type InValue } from "@libsql/client";
import { serveGraphql } from "@ai-outfitter/app-sdk/app-graphql";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { graphqlSchema } from "../src/server/graphql";
import { createIssue, createProject } from "../src/server/planning";

test("issues ordered by position page from the position index: filtered in the database, never sorted", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = drizzle(client, { logger: { logQuery: (sql, params) => { statements.push({ sql, params }); } } });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    const identity = { userId: "a", installationId: "mine", owner: { kind: "user", id: "a" }, canEdit: true } as never;
    const project = await createProject(db, identity, { name: "Launch" });
    const other = await createProject(db, identity, { name: "Other" });
    for (const [projectId, title, category] of [[project.id, "First stone", "stone"], [other.id, "Elsewhere", "stone"], [project.id, "First sand", "sand"], [project.id, "Second stone", "stone"]] as const)
      await createIssue(db, identity, { projectId, title, category });
    const read = async (after: string | null) => {
      statements.length = 0;
      const result = await serveGraphql({ schema: graphqlSchema, maxBytes: 65536, context: { db: () => db, identity }, variables: { projectId: [project.id], after },
        query: `query($projectId: [ID!], $after: String) { issues(first: 2, after: $after, orderBy: POSITION_ASC, filter: { projectId: { in: $projectId }, status: { in: ["todo"] } }) {
          nodes { title position } pageInfo { hasNextPage endCursor } totalCount } }` });
      assert.equal(result.errors, undefined, JSON.stringify(result.errors));
      const page = statements.find(statement => /order by/i.test(statement.sql));
      assert.ok(page, "one ordered page statement");
      const plan = (await client.execute({ sql: `EXPLAIN QUERY PLAN ${page.sql}`, args: page.params as InValue[] })).rows.map(row => String(row.detail));
      assert.ok(plan.some(step => /SEARCH planning_issues USING INDEX planning_issues_position \(installationId=\?/.test(step)) && !plan.some(step => /TEMP B-TREE/.test(step)), plan.join("\n"));
      return (result.data as { issues: { nodes: { title: string; position: number }[]; pageInfo: { hasNextPage: boolean; endCursor: string }; totalCount: number } }).issues;
    };
    // Positions run per project and category, so ties fall to the ID; the page is whatever the index gives first.
    const first = await read(null);
    assert.deepEqual([first.nodes.map(node => node.position), first.pageInfo.hasNextPage, first.totalCount], [[0, 0], true, 3]);
    const rest = await read(first.pageInfo.endCursor);
    assert.deepEqual([rest.nodes.map(node => [node.title, node.position]), rest.pageInfo.hasNextPage], [[["Second stone", 1]], false]);
    assert.deepEqual([...first.nodes, ...rest.nodes].map(node => node.title).sort(), ["First sand", "First stone", "Second stone"]);
  } finally { client.close(); }
});
