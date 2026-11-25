import assert from "node:assert/strict";
import { copyFileSync, globSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { projectRequirements, agentPlan } from "./inference-fixture.mjs";
import { callTool } from "./mcp.mjs";

export function observePlanningHost(box, db) {
  const { id } = db.prepare("SELECT id FROM app_installations WHERE template='planning' AND organizationId IS NOT NULL").get();
  const entries = join(dirname(box.databases.platform), "entries");
  const path = join(entries, id + ".mjs");
  renameSync(path, join(entries, "original-planning-entry.mjs"));
  copyFileSync(new URL("./fixtures/observed-planning-entry.mjs", import.meta.url), path);
}

// Only move the timestamps of this fixture's board item. The actual completion,
// project/owner report chain and personal brief all use their public documents.
function dateCompletion(box, installationId, issueId, date) {
  const directory = join(dirname(box.databases.platform), "apps", installationId, "d1");
  const paths = globSync("**/*.sqlite", { cwd: directory }).filter(p => !p.endsWith("metadata.sqlite"));
  assert.equal(paths.length, 1, directory);
  const store = new DatabaseSync(join(directory, paths[0]));
  try {
    store.exec("PRAGMA busy_timeout=5000");
    const at = Date.parse(date + "T18:00:00Z"); // noon or 1pm in Chicago
    const changed = store.prepare("UPDATE planning_issues SET createdAt=?, updatedAt=? WHERE installationId=? AND id=? AND status='done'")
      .run(at - 3600000, at, installationId, issueId);
    assert.equal(changed.changes, 1);
    return at;
  } finally { store.close(); }
}

export async function keystoneJourney({ box, mcp, db, feature, initialIssue, title }) {
  const installs = db.prepare("SELECT id, template FROM app_installations WHERE organizationId IS NOT NULL").all();
  for (const app of ["planning", "software-foundry", "governance"]) assert.ok(installs.some(row => row.template === app), app);
  const calls = [];
  async function document(scope, app, name, input, field, tool) {
    calls.push({ scope, app, document: name });
    const args = { scope, app, document: name, variables: { input } };
    if (tool === "graph_query") args.includeIdentifiers = true;
    const result = await callTool(mcp, tool, args);
    assert.ok(!result.refused && result.value?.data?.[field] != null, name + ": " + result.text);
    return result.value.data[field];
  }
  const planning = (name, input, field) => document("box", "planning", name, input, field, "graph_mutate");
  // The Planning document accepts lowercase slugs. Preserve the model's original
  // identifiers in the recorded completion and use the same mapping on each edge.
  const requirements = projectRequirements.map(row => ({
    ...row, key: row.key.toLowerCase(), dependsOn: row.dependsOn.map(key => key.toLowerCase()),
  }));
  const artifact = JSON.parse(readFileSync(join(box.out, "feature-plan.json"), "utf8"));
  for (const requirement of requirements) {
    const repository = requirement.target.repository;
    assert.ok(artifact.citations.some(c => c.repository === repository), repository);
    assert.ok(artifact.plan.changes.includes(repository + ": " + requirement.statement), repository);
    assert.ok(initialIssue.body.includes(repository), repository);
  }
  const project = await planning("CreateProject", { name: "Keystone service installation across Apple clients and cluster",
    goals: agentPlan?.goal ?? "Ship one working installation path from flake defaults through charts, cluster reconciliation and both native clients.",
    requirements }, "createProject");
  const delivery = await document("box", "planning", "ProjectDelivery", { projectId: project.id }, "projectDelivery", "graph_query");
  assert.equal(delivery.requirements.length, requirements.length);
  for (const expected of requirements) {
    const actual = delivery.requirements.find(row => row.key === expected.key);
    assert.equal(actual?.target.repository, expected.target.repository);
    assert.deepEqual(actual.dependsOn, expected.dependsOn);
    assert.deepEqual(actual.acceptanceCriteria, expected.acceptanceCriteria);
  }
  const intake = await planning("CreateIntake", { requestId: crypto.randomUUID(), projectId: project.id, kind: "user-story", title,
    description: initialIssue.body, sourceUrls: [initialIssue.html_url, feature.artifacts[0].url] }, "createIntake");
  assert.equal(intake.projectId, project.id);
  assert.equal(intake.routing?.state, "complete", intake.routingError);
  assert.deepEqual(intake.routes.map(route => route.kind), ["prioritization"]);
  assert.deepEqual(intake.sourceUrls, [initialIssue.html_url, feature.artifacts[0].url]);
  const items = [];
  for (const requirement of requirements) {
    const item = await planning("CreateIssue", { projectId: project.id, title: requirement.title, category: "stone",
      description: requirement.target.repository + "\n" + initialIssue.html_url }, "createIssue");
    items.push(item);
  }
  // One fixture completion is progress on the project. The dependent rollout
  // and native client work remain open on the same board.
  const [board, ...pending] = items;
  await planning("UpdateIssue", { projectId: project.id, id: board.id, revision: board.revision,
    title: board.title, description: board.description, category: "stone", status: "done" }, "updateIssue");
  const timezone = "America/Chicago";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());
  const date = new Date(Date.parse(today + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);
  const observedAt = dateCompletion(box, installs.find(i => i.template === "planning").id, board.id, date);
  const task = await planning("GenerateDailyReports", { date, timezone }, "generateDailyReports");
  const home = sections => document("personal", "forerunner", "DailyHome", { sections, timezone }, "dailyHome", "graph_query");
  // Wait only in the test for the asynchronous public run to make its report visible.
  let source;
  for (let attempt = 0; attempt < 20; attempt++) {
    const page = await home(["review"]);
    assert.equal(page.yesterday.period.date, date);
    source = page.yesterday.organizations.find(org => org.scope === "box");
    if (source?.work.some(row => row.title === board.title)) break;
    await sleep(500);
  }
  assert.ok(source?.href, JSON.stringify(source));
  assert.deepEqual(source.work.filter(w => w.title === board.title), [{ title: board.title, kind: "Completed issue observation", url: "/o/box/planning/projects/" + project.id }]);
  assert.ok(!source.work.some(w => w.title === title || pending.some(item => item.title === w.title)));
  const brief = await document("personal", "forerunner", "GenerateDailyBrief", { timezone }, "generateDailyBrief", "graph_mutate");
  const reopened = await home(["digest"]);
  assert.equal(reopened.briefState, "saved", JSON.stringify(brief));
  assert.equal(reopened.brief.revision, brief.revision);
  assert.ok(reopened.brief.markdown.includes(board.title), reopened.brief.markdown);
  assert.ok(reopened.brief.markdown.includes(source.href));
  const trace = readFileSync(join(box.out, "planning-host.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(trace.some(row => row.operation === "workflow.start"), "Planning host recorder saw the workflow");
  const governance = installs.find(row => row.template === "governance");
  const directed = trace.filter(row => row.app === "governance" || row.installationId === governance.id);
  return { installed: installs.map(i => i.template).sort(), calls, projectId: project.id, intakeId: intake.id,
    sourceIssue: initialIssue.html_url, route: intake.routes[0].kind, foundryRun: feature.run.id, completedItem: board.title, openItems: pending.map(item => item.title), requirements: delivery.requirements.map(({ key, target, dependsOn }) => ({ key, repository: target.repository, dependsOn })),
    date, timezone, observedAt, task, source, brief, markdown: reopened.brief.markdown,
    governanceObservation: { planningHostCalls: trace.length, directed, scope: "Direct calls from the installed org Planning worker; deterministic inference." } };
}
