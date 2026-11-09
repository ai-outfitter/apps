import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, type Route, test } from "@playwright/test";

const origin = "https://planning.alpha.localhost";
const projectId = "31000000-0000-4000-8000-000000000001";
const issueId = "31000000-0000-4000-8000-000000000002";
const submissionId = "31000000-0000-4000-8000-000000000003";
const head = "a".repeat(40);
const criterion = {
  ref: { installationId: "wiki", type: "graph-node", id: "criterion" },
  revision: 3,
  title: "No unrelated records",
  condition: "Preview selected project scope",
  expectedOutcome: "Only selected requirements appear",
};
const preview = {
  title: "Render project context",
  description: "# Render project context\n\nOnly selected requirements appear",
  criteria: [criterion],
  digest: "b".repeat(64),
  gaps: [],
};

for (const width of [1440, 390]) {
  test(`Submit frozen work, inspect evidence and accept at ${width}px`, async ({
    page,
  }, info) => {
    const app = await appWorker(
      "planning",
      appArtifact(new URL("..", import.meta.url), "operational"),
    );
    let submitted = false,
      evaluated = false,
      reviewed = false,
      accepted = false,
      large = false;
    const requests: { action: string; input: Record<string, unknown> }[] = [];
    const state = () => ({
      submission: {
        id: submissionId,
        title: preview.title,
        snapshot: preview,
        accepted: accepted ? { verified: true } : null,
      },
      freshness: { stale: false },
      blockers: [],
      execution: {
        issue: { url: "https://github.com/example/project/issues/42" },
        run: {
          status: "complete",
          url: "https://foundry.example/workflows?run=test",
        },
        pullRequests: [
          {
            number: 43,
            repository: "example/project",
            url: "https://github.com/example/project/pull/43",
            headSha: head,
            mergeSha: "c".repeat(40),
            merged: true,
            state: "closed",
            reviews: [],
            checks: {
              check_runs: [
                {
                  id: 7,
                  name: "Acceptance tests",
                  head_sha: head,
                  status: "completed",
                  conclusion: "success",
                },
              ],
            },
          },
        ],
        evidence: { images: [] },
      },
      evaluations: evaluated
        ? [
            {
              criterion: { id: criterion.ref.id },
              result: "passed",
              candidateCommit: head,
            },
          ]
        : [],
    });
    async function readWork(route: Route, input: Record<string, unknown>) {
          if (input.view === "snapshot") return route.fulfill({ json: preview });
          if (input.view === "evidence") return route.fulfill({ json: { execution: state().execution, executionSource: { source: "live" } } });
          if (input.view === "acceptance") return route.fulfill({ json: { execution: state().execution } });
          if (input.view === "evaluations") return route.fulfill({ json: state().evaluations });
          if (large) return route.fulfill({ json: { summary: true, submission: { id: submissionId, title: preview.title, accepted }, notice: "Open separate sections",
            blockers: ["Wiki projection requires refresh"], readbackViews: ["snapshot", "evidence", "acceptance", "evaluations"] } });
          return route.fulfill({ json: state() });
    }
    async function handleAction(route: Route, body: (typeof requests)[number]) {
      switch (body.action) {
        case "project.context":
          return route.fulfill({
            json: {
              project: { title: "Graph-backed context" },
              definitions: [
                { ref: { id: "definition" }, title: "Implementation brief" },
              ],
            },
          });
        case "work.destinations":
          return route.fulfill({
            json: {
              foundries: [
                {
                  installationId: "foundry",
                  projects: [{ id: "target", name: "Sandbox", ready: true }],
                },
              ],
              governances: [
                {
                  installationId: "governance",
                  controls: [
                    {
                      id: "control",
                      title: "Engineering acceptance",
                      revision: 2,
                    },
                  ],
                },
              ],
            },
          });
        case "work.submissions":
          return route.fulfill({
            json: submitted ? [{ id: submissionId, title: preview.title }] : [],
          });
        case "work.preview":
          return route.fulfill({ json: preview });
        case "work.submit":
          submitted = true;
          return route.fulfill({ json: state() });
        case "work.get":
          return readWork(route, body.input);
        case "work.refresh":
          return route.fulfill({ json: state() });
        case "work.evaluate":
          evaluated = true;
          return route.fulfill({ json: state() });
        case "work.request-review":
          reviewed = true;
          return route.fulfill({ json: state() });
        case "work.accept":
          if (!evaluated || !reviewed)
            return route.fulfill({
              status: 409,
              body: "Complete the required evaluation and Governance decision",
            });
          accepted = true;
          return route.fulfill({ json: state() });
      }
      return route.fulfill({ status: 400, body: "Unknown action" });
    }
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path === "/api/apps/planning/work") {
        const body = request.postDataJSON() as (typeof requests)[number];
        requests.push(body);
        return handleAction(route, body);
      }
      if (path === "/api/apps/planning")
        return route.fulfill({
          json: {
            projects: [],
            issues: [
              { id: issueId, projectId, title: "Render bounded context" },
            ],
          },
        });
      if (path.startsWith("/api/")) return route.fulfill({ json: [] });
      return fulfillFrom(route, await app.fetch(request.url()));
    });
    try {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/projects/${projectId}/work`);
      await page
        .getByRole("combobox", { name: "Foundry project", exact: true })
        .selectOption({ label: "Sandbox" });
      await page
        .getByRole("combobox", { name: "Acceptance policy", exact: true })
        .selectOption({ label: "Engineering acceptance" });
      await page.getByRole("button", { name: "Preview submission" }).click();
      await expect(
        page.getByRole("heading", { name: "Review work package" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Submit to Foundry" }),
      ).toBeDisabled();
      expect(requests.filter((x) => x.action === "work.submit")).toHaveLength(
        0,
      );
      await page
        .getByRole("checkbox", { name: "I approve this scope" })
        .check();
      await page.getByRole("button", { name: "Submit to Foundry" }).click();
      await expect(
        page.getByRole("link", { name: "example/project #43" }),
      ).toBeVisible();
      await expect(
        page.getByText("Not accepted.", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Check decision and accept work" })
        .click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Complete the required evaluation" }),
      ).toBeVisible();
      await page
        .getByLabel("Result for No unrelated records")
        .selectOption("passed");
      await page
        .getByLabel("Evaluation method for No unrelated records")
        .fill(
          "The provider's acceptance suite checks the bounded fixture against the selected requirement.",
        );
      await page
        .getByLabel("Evidence for No unrelated records")
        .selectOption({ label: "Acceptance tests: success" });
      await page.getByRole("button", { name: "Record evaluation" }).click();
      await expect(
        page.getByText("Recorded result: passed", { exact: true }),
      ).toBeVisible();
      await page
        .getByLabel("Acceptance recommendation")
        .fill(
          "The criterion passes for this exact candidate; review the evidence before deciding.",
        );
      await page
        .getByRole("button", { name: "Request acceptance review" })
        .click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Acceptance review requested" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Check decision and accept work" })
        .click();
      await expect(
        page.getByText("Accepted. Deployment is recorded separately.", {
          exact: true,
        }),
      ).toBeVisible();
      expect(
        requests.find((x) => x.action === "work.evaluate")?.input
          .candidateCommit,
      ).toBe(head);
      expect(
        requests.find((x) => x.action === "work.submit")?.input.expectedDigest,
      ).toBe(preview.digest);
      await page.reload();
      await page
        .getByRole("combobox", { name: "Work package", exact: true })
        .selectOption(submissionId);
      await expect(
        page.getByText("Accepted. Deployment is recorded separately.", {
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.getByText("Accepted. Deployment is recorded separately.", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`work-acceptance-${width}.png`),
        fullPage: true,
      });
      large = true;
      await page.reload();
      await page.getByRole("combobox", { name: "Work package", exact: true }).selectOption(submissionId);
      await expect(page.getByText("Wiki projection requires refresh", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Submitted scope", exact: true }).click();
      await expect(page.locator("#execution-result pre")).toHaveText(preview.description);
      await page.getByRole("button", { name: "Current evidence", exact: true }).click();
      await expect(page.getByRole("link", { name: "example/project #43" })).toBeVisible();
      await page.getByRole("button", { name: "Acceptance record", exact: true }).click();
      await expect(page.getByText("Acceptance recorded. Deployment is recorded separately.", { exact: true })).toBeVisible();
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await app.dispose();
    }
  });
}
