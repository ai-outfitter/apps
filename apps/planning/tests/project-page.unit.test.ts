import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import {
  demoProjectPage,
  projectPageView,
  readProjectPage,
} from "../src/server/project-page";

function fixture() {
  const demo = demoProjectPage();
  const calls: { operation: string; input: Record<string, any> }[] = [];
  const host = {
    async call(operation: string, input: Record<string, any>) {
      calls.push({ operation, input });
      if (operation === "entities.types")
        return ["projects", "issues"].map((collection) => ({
          installationId: "planning",
          template: "planning",
          collection,
          type: collection === "projects" ? "project" : "issue",
          title: collection,
        }));
      const data = input.type === "project" ? demo.projects : demo.issues;
      if (
        operation === "entities.get" &&
        !data.some((row) => row.id === input.id)
      )
        throw new Response("Not found", { status: 404 });
      const records = data.map((row) => ({
        ref: { installationId: "planning", type: input.type, id: row.id },
        revision: row.revision,
        title: "name" in row ? row.name : row.title,
        attributes: Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => !input.select || input.select.includes(key),
          ),
        ),
        references: [],
      }));
      return operation === "entities.get" ? records[0] : records;
    },
  } as unknown as WorkflowHost<"interactive">;
  return { host, calls, demo };
}

test("project detail reads one scoped project and its issues, retaining order metadata", async () => {
  const { host, calls, demo } = fixture();
  const result = await readProjectPage(host, "planning", demo.projects[0].id);
  assert.equal(result.projects[0].name, demo.projects[0].name);
  assert.equal(result.groups[0].issues[0].issue.position, 0);
  const lists = calls.filter((call) => call.operation === "entities.list");
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0].input.filter, { projectId: demo.projects[0].id });
  assert.deepEqual(lists[0].input.order, {
    field: "position",
    direction: "asc",
  });
  assert.ok(lists[0].input.select.includes("position"));
  assert.equal(
    calls.some((call) => call.operation !== "entities.types" && /wiki|readiness/.test(JSON.stringify(call.input))),
    false,
  );
});

test("directory reads issue summaries only and leaves editing issues unloaded", async () => {
  const { host, calls } = fixture();
  const result = await readProjectPage(host, "planning");
  assert.equal(result.cards[0].openIssues, 1);
  assert.deepEqual(result.issues, []);
  const issues = calls.find(
    (call) => call.operation === "entities.list" && call.input.type === "issue",
  )!;
  assert.deepEqual(issues.input.select, ["projectId", "status"]);
  assert.deepEqual(
    calls.filter((call) => call.operation === "entities.types").map((call) => call.input),
    [{ installationId: "planning" }, { template: "onto", requireTypes: true }],
  );
  await assert.rejects(
    readProjectPage(host, "foreign"),
    (error) => error instanceof Response && error.status === 409,
  );
});

test("view resolves parent titles and uses complete category order for move actions", () => {
  const demo = demoProjectPage(),
    first = demo.issues[0];
  const completed = {
    ...first,
    id: "completed",
    status: "done" as const,
    title: "Prior work",
    position: 0,
  };
  const child = { ...first, parentId: completed.id, position: 1 };
  const model = projectPageView(demo.projects, [completed, child]);
  assert.equal(model.cards[0].openIssues, 1);
  assert.equal(model.groups[0].issues.length, 1);
  assert.match(model.groups[0].issues[0].metadata, /Sub-issue of Prior work/);
  assert.equal(model.groups[0].issues[0].moveUp, true);
  assert.equal(model.groups[0].issues[0].moveDown, false);
});
