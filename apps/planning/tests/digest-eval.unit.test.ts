import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildCases, parseExport, readExport } from "../evals/project-digest/cases";
import { grade, mentions } from "../evals/project-digest/grade";

const fixture = (name: string) => fileURLToPath(new URL(`../evals/project-digest/fixtures/${name}.json`, import.meta.url));

async function cases() {
  return buildCases(await readExport(fixture("older")), await readExport(fixture("newer")));
}

test("two exports become one case per project, diffed by the production digest", async () => {
  const [onboarding, billing, dashboards] = await cases();
  assert.equal(onboarding.project, "Customer onboarding");
  assert.deepEqual(onboarding.changes.shipped.map((issue) => issue.title), ["Invite flow for organization admins"]);
  assert.deepEqual(onboarding.changes.started.map((issue) => issue.title), ["Welcome checklist"]);
  assert.deepEqual(onboarding.changes.reopened.map((issue) => issue.title), ["Fix the sign-up email typo"]);
  assert.deepEqual(onboarding.changes.added.map((issue) => issue.title), ["Import teammates from Google Workspace"]);
  assert.deepEqual(onboarding.changes.removed.map((issue) => issue.title), ["Sample project on first login"]);
  assert.ok(onboarding.knownTitles.includes("Sample project on first login"), "removed titles are still known");
  assert.equal(billing.changed, false, "an unchanged project gets no digest, as in production");
  assert.deepEqual(dashboards.changes.added.map((issue) => issue.title), ["Daily active users chart"], "a project new since the older export starts empty");
  assert.deepEqual(dashboards.changes.started.map((issue) => issue.title), ["Daily active users chart"]);
  const [first] = await buildCases(null, await readExport(fixture("newer")));
  assert.equal(first.since, null, "without an older export each case is a first digest");
});

test("the production entity export format reads like the local one", () => {
  const data = parseExport({
    source: { installationId: "i1" },
    projects: [{ ref: { id: "p1" }, revision: 3, title: "Launch", attributes: { name: "Launch", createdAt: 1, updatedAt: 5 } }],
    issues: [{ ref: { id: "x1" }, revision: 2, title: "Ship", attributes: { projectId: "p1", title: "Ship", category: "stone", status: "done", createdAt: 1, updatedAt: 9 } }],
  });
  assert.equal(data.installationId, "i1");
  assert.equal(data.projects[0].revision, 3);
  assert.equal(data.issues[0].id, "x1");
  assert.equal(data.takenAt, 9);
});

test("exports from different installations are refused", async () => {
  const newer = await readExport(fixture("newer"));
  await assert.rejects(buildCases({ ...newer, installationId: "other" }, newer), /same installation/);
});

test("titles match by their words, not exact strings", () => {
  assert.ok(mentions("We shipped the invite flow for org admins", "Invite flow"));
  assert.ok(mentions("The invite flow for organization admins is live.", "Invite flow for organization admins"));
  assert.ok(!mentions("Billing work continues", "Invite flow"));
});

test("a grounded answer that leads with what shipped passes every check", async () => {
  const [onboarding] = await cases();
  const result = grade(onboarding, {
    headline: "Invite flow for organization admins shipped",
    summary: "The invite flow for organization admins is done. The welcome checklist is now in progress. The sign-up email typo fix was reopened, and the sample project on first login was removed.",
  });
  assert.equal(result.pass, true, JSON.stringify(result.checks));
});

test("invented issues, a buried lead and skipped setbacks each fail", async () => {
  const [onboarding] = await cases();
  const result = grade(onboarding, {
    headline: "A busy day for onboarding",
    summary: 'The team worked on "Single sign-on for enterprise" and kept going. Later, the invite flow for organization admins shipped.',
  });
  const failed = result.checks.filter((check) => !check.pass).map((check) => check.name);
  assert.deepEqual(failed, ["no-invented-issues", "leads-with-shipped", "covers-changes", "calls-out-setbacks"]);
  assert.equal(grade(onboarding, { headline: "" }).checks[0].name, "contract");
});
