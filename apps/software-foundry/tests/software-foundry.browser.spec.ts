import { defined } from "@ai-outfitter/app-test/assertions";
import { test, expect, type Route } from "@playwright/test";
import { gunzipSync } from "node:zlib";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom, openAccountMenuFor } from "@ai-outfitter/app-test/playwright";
const packageDirectory = new URL("..", import.meta.url);
let worker: Awaited<ReturnType<typeof appWorker>>;
test.beforeAll(async () => {
  worker = await appWorker(
    "software-foundry",
    appArtifact(packageDirectory, "operational"),
  );
});
test.afterAll(async () => {
  await worker?.dispose();
});

test("Foundry combines repositories with per-issue progress, optional filters and independent pagination", async ({
  page,
}, testInfo) => {
  const submissions: {
    workflow: string;
    inputs: Record<
      string,
      { repository: string; number: number; title: string }
    >;
  }[] = [];
  const queries: URL[] = [];
  const bootstraps: URL[] = [];
  const errors: string[] = [];
  let githubDown = false;
  let repoDown = true;
  let canEdit = true;
  let running = true;
  let enabled = true;
  page.on("pageerror", (error) => errors.push(error.message));
  const issue = (repository: string, number: number, title: string) => ({
    number,
    title,
    url: `https://github.com/${repository}/issues/${number}`,
    createdAt: "2025-01-01",
    updatedAt: "2026-10-01",
  });
  // A v2 issue-to-review run as GET /api/workflow-runs returns it.
  const run = (
    id: string,
    repository: string,
    number: number,
    title: string,
    status: "running" | "complete",
  ) => ({
    id,
    workflow: { id: "issue-to-review" },
    status,
    updatedAt: Date.now(),
    inputs: id === "closed-run"
      ? {"triage.inputs.event":{repository:{full_name:repository},issue:{number,title}}}
      : { "triage.inputs.issue": { repository, number, title } },
  });
  const approved = () =>
    enabled ? ["outfitter/one", "outfitter/two", "outfitter/three"] : [];
  const view = () => ({
    connected: true, login: "outfitter", canEdit,
    repositories: approved().map((name) => ({
      name,
      canDraft: true,
    })),
    scopes: [],
  });
  async function githubFixture(route: Route, url: URL) {
    if (url.pathname === "/api/plugins/github") {
      if (githubDown)
        return route.fulfill({ status: 503, body: "GitHub unavailable" });
      return route.fulfill({ json: view() });
    }
  }
  // The page bootstrap: admins get the view and every approved repository's
  // first page; members are refused and fall back to the view.
  async function bootstrapFixture(route: Route, url: URL) {
    bootstraps.push(url);
    if (githubDown)
      return route.fulfill({ status: 503, body: "GitHub unavailable" });
    const repositories = approved();
    return route.fulfill({
      json: {
        page: "issues",
        plugin: view(),
        ...(repositories.length
          ? {
              issues: issuePages(
                repositories.map((repository) => [repository, ""]),
              ),
            }
          : {}),
      },
    });
  }
  function issuesForRepository(repository: string, secondPage: boolean) {
    if (repository === "outfitter/two")
      return secondPage
        ? [issue(repository, 15, "More backlog work")]
        : [
            issue(repository, 12, "Completed fix"),
            issue(repository, 13, "Review onboarding"),
            issue(repository, 14, "Fix keyboard navigation"),
          ];
    return [
      issue(
        repository,
        12,
        repository === "outfitter/one"
          ? "Handle remainder cents"
          : "Recover integration",
      ),
    ];
  }
  // One response for every requested repository; a repository GitHub could
  // not answer is an error entry beside the others.
  function issuePages(requested: [string, string][]) {
    return {
      order: "recent",
      repositories: requested.map(([repository, cursor]) => {
        if (repository === "outfitter/three" && repoDown)
          return {
            repository,
            error: "GitHub could not return this repository's issues.",
          };
        const secondPage = cursor === "two-page-2";
        return {
          repository,
          issues: issuesForRepository(repository, secondPage),
          nextCursor:
            repository === "outfitter/two" && !secondPage ? "two-page-2" : null,
        };
      }),
    };
  }
  async function issuesFixture(route: Route, url: URL) {
    if (url.pathname === "/api/apps/software-foundry/issues") {
      queries.push(url);
      const repositories = url.searchParams.getAll("repository");
      const cursors = url.searchParams.getAll("cursor");
      expect(cursors).toHaveLength(repositories.length);
      return route.fulfill({
        json: issuePages(
          repositories.map((repository, index) => [repository, cursors[index]]),
        ),
      });
    }
  }
  async function runsFixture(route: Route) {
    if (route.request().method() === "POST") {
      submissions.push(route.request().postDataJSON());
      const issue = defined(submissions.at(-1), "last item").inputs[
        "triage.inputs.issue"
      ];
      return route.fulfill({
        status: 201,
        json: run(
          crypto.randomUUID(),
          issue.repository,
          issue.number,
          issue.title,
          "running",
        ),
      });
    }
    return route.fulfill({
      json: {
        items: [
          ...submissions.map((s, index) => {
            const issue = s.inputs["triage.inputs.issue"];
            return run(
              `submitted-${index}`,
              issue.repository,
              issue.number,
              "Submitted work",
              "running",
            );
          }),
          run(
            "run-one",
            "outfitter/one",
            12,
            "Handle remainder cents",
            running ? "running" : "complete",
          ),
          run("run-two", "outfitter/two", 12, "Completed fix", "complete"),
          run(
            "closed-run",
            "outfitter/three",
            90,
            "Closed issue with completed workflow",
            "complete",
          ),
        ],
      },
    });
  }
  async function residentFixture(route: Route, url: URL) {
    if (url.pathname === "/api/platform/features/resident-identities") {
      return route.fulfill({
        json: {
          providers: [
            {
              installationId: "resident",
              origin: "https://resident-agent.outfitter.example/",
              value: {
                available: true,
                data: {
                  residents: [
                    {
                      id: "725ea3c5-0a9a-4cde-a456-1f9b10b06cf3",
                      name: "Maple",
                      profileRef: "engineering",
                      execution: { status: "unavailable" },
                    },
                  ],
                },
              },
            },
          ],
        },
      });
    }
  }
  await page.route(
    "https://software-foundry.outfitter.example/**",
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/plugins/github")
        return githubFixture(route, url);
      if (url.pathname === "/api/apps/software-foundry/bootstrap")
        return bootstrapFixture(route, url);
      if (url.pathname === "/api/apps/software-foundry/issues")
        return issuesFixture(route, url);
      if (url.pathname === "/api/workflow-runs") return runsFixture(route);
      if (url.pathname === "/api/platform/features/resident-identities")
        return residentFixture(route, url);
      const response = await worker.fetch(request.url());
      return fulfillFrom(route, response);
    },
  );
  const row = (repo: string, number: number) =>
    page.locator(`[data-issue="outfitter/${repo}#${number}"]`);
  await page.goto("https://software-foundry.outfitter.example/issues");
  const executionIdentity = page.getByRole("combobox", {
    name: "Run Foundry as",
  });
  await expect(executionIdentity.locator("option")).toHaveCount(2);
  await executionIdentity.selectOption("725ea3c5-0a9a-4cde-a456-1f9b10b06cf3");
  await expect(page.locator("#identity-notice")).toContainText(
    "cannot run work",
  );
  await expect(page.locator("#identity-notice")).toContainText(
    "Regular execution was not substituted",
  );
  await expect(
    page.getByText("Maple unavailable: Agent Operator dispatch is not bound."),
  ).toHaveCount(5);
  await expect(page.locator("#issues button[data-control]")).toHaveCount(0);
  await executionIdentity.selectOption("regular");
  await expect(
    page.getByRole("table", { name: "Issues and workflows" }),
  ).toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveText([
    "Issue",
    "Status",
    "Updated",
    "Actions",
  ]);
  await expect(page.locator(".workflow-stages")).toHaveCount(0);
  await expect(
    row("one", 12).getByText("In progress", { exact: true }),
  ).toBeVisible();
  await expect(
    row("two", 12).getByText("Completed", { exact: true }),
  ).toBeVisible();
  await expect(row("three", 90)).toBeVisible();
  await expect(
    row("one", 12).getByRole("link", { name: "View workflow →" }),
  ).toHaveAttribute("href", "https://example/o/outfitter/workflows/issue-to-review/runs/run-one");
  await expect(row("one", 12).getByRole("button")).toHaveCount(0);
  await expect(
    page.getByText(/Could not load: outfitter\/three/),
  ).toBeVisible();
  // The first render is one bootstrap request; no per-repository requests.
  expect(bootstraps.map((url) => url.searchParams.get("page"))).toEqual([
    "issues",
  ]);
  expect(queries).toHaveLength(0);
  await page.getByRole("button", { name: "Completed", exact: true }).click();
  await expect(row("one", 12)).toHaveCount(0);
  await expect(row("two", 12)).toBeVisible();
  await page.getByRole("button", { name: "In progress", exact: true }).click();
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByText("Add filters", { exact: true }).click();
  await page
    .getByRole("checkbox", { name: "outfitter/two", exact: true })
    .check();
  await expect(page.locator(".issue-row")).toHaveCount(3);
  await page.getByRole("searchbox", { name: "Search issues" }).fill("keyboard");
  await expect(page.locator(".issue-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByText("Add filters", { exact: true }).click();
  await page.getByRole("button", { name: "Load more issues" }).click();
  await expect(row("two", 15)).toBeVisible();
  await expect(row("two", 12)).toHaveCount(1);
  // Load more is one request: the repository with a next page sends its
  // cursor, the failed one retries its first page, the finished one is left out.
  expect(
    queries.map((url) => [
      url.searchParams.getAll("repository"),
      url.searchParams.getAll("cursor"),
    ]),
  ).toEqual([
    [
      ["outfitter/two", "outfitter/three"],
      ["two-page-2", ""],
    ],
  ]);
  await row("two", 13)
    .getByRole("button", { name: "Run issue to review", exact: true })
    .click();
  await expect(
    row("two", 13).getByText("In progress", { exact: true }),
  ).toBeVisible();
  await row("two", 14)
    .getByRole("button", { name: "Run issue to review", exact: true })
    .click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(
    submissions.map(({ workflow, inputs }) => ({
      workflow,
      repository: inputs["triage.inputs.issue"].repository,
      number: inputs["triage.inputs.issue"].number,
    })),
  ).toEqual([
    { workflow: "issue-to-review", repository: "outfitter/two", number: 13 },
    { workflow: "issue-to-review", repository: "outfitter/two", number: 14 },
  ]);
  repoDown = false;
  running = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(row("three", 12)).toBeVisible();
  // Refresh reloads every approved repository's first page in one request.
  expect(
    defined(queries.at(-1), "refresh query").searchParams.getAll("repository"),
  ).toEqual(["outfitter/one", "outfitter/two", "outfitter/three"]);
  await expect(
    row("one", 12).getByText("Completed", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Could not load:/)).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("foundry-feed.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const region = page.getByRole("region", { name: "Issues and workflows" });
    expect(
      await region.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    const state = row("one", 12).locator(".status-pill");
    await expect(state).toHaveText("Completed");
    for (const cell of [
      state,
      row("one", 12).getByRole("link", { name: "View workflow →" }),
    ]) {
      const box = await cell.boundingBox();
      expect(defined(box, "bounding box").x).toBeGreaterThanOrEqual(0);
      expect(
        defined(box, "bounding box").x + defined(box, "bounding box").width,
      ).toBeLessThanOrEqual(width);
    }
  }
  await page.screenshot({
    path: testInfo.outputPath("foundry-feed-mobile.png"),
    fullPage: true,
  });
  const beforeSettings = queries.length;
  await page.getByRole("button", { name: "Open navigation" }).click();
  await openAccountMenuFor(page, "Software Foundry settings");
  await page.getByRole("link", { name: "Software Foundry settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Manage repositories ↗" }),
  ).toHaveAttribute("href", "https://example/o/outfitter/plugins/github");
  await expect(
    page.getByRole("link", { name: "Manage Forgejo ↗" }),
  ).toHaveAttribute("href", "https://example/o/outfitter/connectors/forgejo");
  await expect(
    page.getByText(/Forgejo workflow execution, pushes/),
  ).toBeVisible();
  await expect(page.getByText(/3 available repositories/)).toBeVisible();
  expect(queries.length).toBe(beforeSettings);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Issues", exact: true }).click();
  await expect(row("two", 13)).toBeVisible();
  enabled = false;
  await page.reload();
  await expect(
    page.getByText("No repositories available. Manage repository access on GitHub."),
  ).toBeVisible();
  enabled = true;
  canEdit = false;
  const beforeMember = queries.length;
  await page.reload();
  await expect(row("one", 12)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run issue to review", exact: true }),
  ).toHaveCount(0);
  expect(queries.length).toBe(beforeMember);
  githubDown = true;
  await page.reload();
  await expect(row("one", 12)).toBeVisible();
  await expect(
    page.getByText(/Repository access is unavailable/),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("Foundry retries a refused start and preserves controls during polling and sort failures", async ({
  page,
}) => {
  await page.clock.install();
  const attempts: unknown[] = [];
  const queries: URL[] = [];
  let accepted = false;
  let runRequests = 0;
  let completed = false;
  let failOldest = false;
  let releaseLoad: (() => void) | undefined;
  let holdLoad = false;
  const retryView = {
    connected: true, canEdit: true,
    repositories: ["one", "two"].map((name) => ({
      name: `outfitter/${name}`,
      canDraft: true,
    })),
    scopes: [
      {
        repositories: ["outfitter/one", "outfitter/two"],
        mode: "draft-pr",
      },
    ],
  };
  function retryPages(repositories: string[], order: string | null) {
    return {
      order,
      repositories: repositories.map((repository) =>
        failOldest && order === "oldest" && repository === "outfitter/one"
          ? {
              repository,
              error: "GitHub could not return this repository's issues.",
            }
          : {
              repository,
              issues: [
                {
                  number: 7,
                  title: "Check retry behavior",
                  url: `https://github.com/${repository}/issues/7`,
                  createdAt: "2025-01-01",
                  updatedAt: "2026-10-01",
                },
              ],
              nextCursor: "next",
            },
      ),
    };
  }
  async function retryGithubFixture(route: Route, url: URL) {
    if (url.pathname === "/api/plugins/github")
      return route.fulfill({ json: retryView });
    if (url.pathname === "/api/apps/software-foundry/bootstrap")
      return route.fulfill({
        json: {
          page: "issues",
          plugin: retryView,
          issues: retryPages(["outfitter/one", "outfitter/two"], "recent"),
        },
      });
  }
  async function retryIssuesFixture(route: Route, url: URL) {
    if (url.pathname === "/api/apps/software-foundry/issues") {
      queries.push(url);
      const repositories = url.searchParams.getAll("repository");
      if (holdLoad && repositories.includes("outfitter/one"))
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
      return route.fulfill({
        json: retryPages(repositories, url.searchParams.get("order")),
      });
    }
  }
  // The accepted run as GET /api/workflow-runs returns it.
  let workspacePause=false, resumed=false;
  const resumeAttempts: {repository:string;number:number;resume:{runId:string;requestId:string}}[]=[];
  const acceptedRun = () => ({
    id: resumed ? "resumed-run" : "accepted-run",
    workflow: {id:workspacePause ? "issue-to-merge-workspace" : "issue-to-review"},
    status: workspacePause ? resumed ? "running" : "needs-details" : completed ? "complete" : "running",
    updatedAt: Date.now(),
    inputs: workspacePause ? {"triage.inputs.event":{repository:{full_name:"outfitter/one"},issue:{number:7,title:"Check retry behavior"}}}
      : { "triage.inputs.issue": { repository: "outfitter/one", number: 7, title: "Check retry behavior" } },
  });
  async function retryRunsFixture(route: Route) {
    if (route.request().method() !== "POST")
      return route.fulfill({
        json: { items: accepted ? [acceptedRun()] : [] },
      });
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1)
      return route.fulfill({ status: 503, body: "Runner unavailable; retry." });
    accepted = true;
    return route.fulfill({ status: 201, json: acceptedRun() });
  }
  await page.route(
    "https://software-foundry.outfitter.example/**",
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if(url.pathname==="/api/apps/software-foundry/workspace-issues") {
        resumeAttempts.push(route.request().postDataJSON());
        if(resumeAttempts.length===1)return route.fulfill({status:503,body:"Resume response lost; retry."});
        resumed=true;
        return route.fulfill({status:202,json:{id:"resumed-run",workflow:"issue-to-merge-workspace"}});
      }
      if (url.pathname === "/api/workflow-runs") runRequests++;
      if (url.pathname === "/api/plugins/github" || url.pathname === "/api/apps/software-foundry/bootstrap")
        return retryGithubFixture(route, url);
      if (url.pathname === "/api/apps/software-foundry/issues")
        return retryIssuesFixture(route, url);
      if (url.pathname === "/api/workflow-runs") return retryRunsFixture(route);
      const response = await worker.fetch(request.url());
      return fulfillFrom(route, response);
    },
  );
  const row = page.locator('[data-issue="outfitter/one#7"]');
  await page.goto("https://software-foundry.outfitter.example/issues");
  await row
    .getByRole("button", { name: "Run issue to review", exact: true })
    .click();
  await expect(page.getByText("Runner unavailable; retry.")).toBeVisible();
  await row
    .getByRole("button", { name: "Run issue to review", exact: true })
    .click();
  await expect(row.getByText("In progress", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  completed = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(row.getByText("Completed", { exact: true })).toBeVisible();
  await row.getByText("Run again", { exact: true }).click();
  const action = row.getByRole("button", {
    name: "Run issue to review",
    exact: true,
  });
  await action.focus();
  const beforePoll = runRequests;
  await page.clock.fastForward(30001);
  await expect.poll(() => runRequests).toBeGreaterThan(beforePoll);
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  await expect(row.locator("details")).toHaveAttribute("open", "");
  await expect(action).toBeFocused();
  await page.getByText("Add filters", { exact: true }).click();
  failOldest = true;
  holdLoad = true;
  await page.getByRole("button", { name: "Oldest first", exact: true }).click();
  await expect.poll(() => Boolean(releaseLoad)).toBe(true);
  await expect(
    page.getByRole("button", { name: "Clear filters" }),
  ).toBeDisabled();
  holdLoad = false;
  defined(releaseLoad, "releaseLoad")();
  await expect(page.getByText(/Could not load: outfitter\/one/)).toBeVisible();
  failOldest = false;
  const beforeMore = queries.length;
  await page.getByText("Add filters", { exact: true }).click();
  await page.getByRole("button", { name: "Load more issues" }).click();
  await expect.poll(() => queries.length).toBeGreaterThan(beforeMore);
  await expect(page.getByText(/Could not load:/)).toHaveCount(0);
  // The failed repository restarts at its first page; the other continues
  // from its cursor, in the same request.
  const retried = defined(queries[beforeMore], "Load more query");
  expect(retried.searchParams.get("order")).toBe("oldest");
  expect(retried.searchParams.getAll("repository")).toEqual([
    "outfitter/one",
    "outfitter/two",
  ]);
  expect(retried.searchParams.getAll("cursor")).toEqual(["", "next"]);
  // Running again after completion starts a new run.
  if ((await row.locator("details").getAttribute("open")) === null)
    await row.getByText("Run again", { exact: true }).click();
  await row
    .getByRole("button", { name: "Run issue to review", exact: true })
    .click();
  await expect.poll(() => attempts.length).toBe(3);
  workspacePause=true;
  await page.getByRole("button",{name:"Refresh",exact:true}).click();
  await expect(row.getByText("Needs details",{exact:true})).toBeVisible();
  await row.getByText("Resume",{exact:true}).click();
  await row.getByRole("button",{name:"Resume workflow",exact:true}).click();
  await expect(page.getByText("Resume response lost; retry.")).toBeVisible();
  await row.getByRole("button",{name:"Resume workflow",exact:true}).click();
  await expect(row.getByText("In progress",{exact:true})).toBeVisible();
  expect(resumeAttempts).toHaveLength(2);
  expect(resumeAttempts[1]).toEqual(resumeAttempts[0]);
  expect(resumeAttempts[0].resume.runId).toBe("accepted-run");
  expect(resumeAttempts[0].resume.requestId).toMatch(/^[a-f0-9-]{36}$/);

});

test("Astro renders settings and serves compiled assets with restrictive page headers", async ({
  page,
}) => {
  await page.route(
    "https://software-foundry.outfitter.example/**",
    async (route) => {
      if (new URL(route.request().url()).pathname === "/api/plugins/github")
        return route.fulfill({
          json: {
            connected: true, canEdit: true, login: "outfitter",
            repositories: [{ name: "outfitter/one", canDraft: true }],
            scopes: [{ repositories: ["outfitter/one"], mode: "draft-pr" }],
          },
        });
      const response = await worker.fetch(route.request().url());
      return fulfillFrom(route, response);
    },
  );
  const response = await page.goto(
    "https://software-foundry.outfitter.example/settings",
  );
  expect(response?.headers()["content-security-policy"]).toContain(
    "style-src 'self'",
  );
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#automatic-summary")).toContainText(
    "Configure automatic issue workflows in Jobs.",
  );
  await expect(page.locator("#playground")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Software Foundry settings", exact: true, includeHidden: true }),
  ).toHaveAttribute("aria-current", "page");
  const health = await worker.fetch(
    "https://software-foundry.outfitter.example/__health",
  );
  expect(health.status).toBe(200);
  // The public operational host binds and migrates Foundry's installation database.
  expect(await health.json()).toEqual({
    app: "software-foundry",
    status: "ok",
    database: "ok",
    storage: "ok",
  });
  for (const [path, asset] of Object.entries(worker.assets)) {
    const response = await worker.fetch(
      `https://software-foundry.outfitter.example${path}`,
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(
      (asset.encoding
        ? gunzipSync(Buffer.from(asset.content, "base64"))
        : Buffer.from(asset.content, "base64")
      ).toString("base64"),
    );
  }
  expect(
    (await worker.fetch("https://software-foundry.outfitter.example/missing"))
      .status,
  ).toBe(404);
  expect(
    (
      await worker.fetch(
        "https://software-foundry.outfitter.example/settings",
        {
          method: "POST",
          headers: { Origin: "https://software-foundry.outfitter.example" },
        },
      )
    ).status,
  ).toBe(405);
});

test("Governance scopes checks to an approved repository and clears stale results on errors", async ({
  page,
}, testInfo) => {
  const origin = "https://software-foundry.outfitter.example";
  let unavailable = false;
  let empty = false;
  let setupStarted = false;
  const completed: unknown[] = [];
  const checks: URL[] = [];
  const bootstraps: URL[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const approved = () => (empty ? [] : ["team/one", "team/two"]);
  const view = () => ({
    connected: true, canEdit: true,
    repositories: approved().map((name) => ({
      name,
    })),
    scopes: [{ repositories: approved(), mode: "triage" }],
  });
  function governanceResponse(route: Route, url: URL) {
    if (unavailable)
      return route.fulfill({ status: 503, body: "GitHub unavailable" });
    if (route.request().method() === "POST") {
      completed.push(route.request().postDataJSON());
      setupStarted = true;
      return route.fulfill({ json: setupReport });
    }
    checks.push(url);
    return route.fulfill({
      json: governanceResult(url.searchParams.get("repository")),
    });
  }
  // The bootstrap names the requested approved repository, or the first.
  function bootstrapResponse(route: Route, url: URL) {
    bootstraps.push(url);
    const requested = url.searchParams.get("repository") ?? "";
    const repository = approved().includes(requested)
      ? requested
      : approved()[0];
    return route.fulfill({
      json: { page: "governance", ...(repository ? { governance: { repository } } : {}) },
    });
  }
  // Complete all on a protected branch: the app's pull request is open and
  // the ruleset waits for its merge.
  const setupReport = {
    status: "running",
    runId: "run-1",
    parts: [
      {
        step: "pull-request",
        label: "Open pull request #12",
        status: "done",
        url: "https://github.com/team/two/pull/12",
      },
      { step: "review", label: "Request review from @octocat", status: "done" },
      { step: "auto-merge", label: "Enable auto-merge", status: "done" },
      {
        step: "merge",
        label: "Merge the pull request",
        status: "waiting",
        detail:
          "Merges automatically once required checks and review pass. Press Complete all after it merges.",
      },
      {
        step: "merge-queue-after-merge",
        label: "Create the merge queue ruleset",
        status: "waiting",
        detail:
          "Waits until the file change is on main, so the change itself does not stall in the queue.",
      },
    ],
    notes: [],
    missingPermissions: [],
  };
  function governanceResult(repository: string | null) {
    expect(["team/one", "team/two"]).toContain(repository);
    return {
      repository,
      defaultBranch: "main",
      revision: "a".repeat(40),
      checkedAt: "2026-10-06T14:00:00Z",
      documents: [
        "AGENTS.md",
        "CONTRIBUTING.md",
        "DESIGN.md",
        "CODEOWNERS",
      ].map((name) => ({
        name,
        status: repository === "team/one" ? "present" : "missing",
        path: name,
      })),
      mergeQueue:
        repository === "team/one"
          ? { status: "merge-group-missing", workflows: ["ci.yml"] }
          : { status: "missing", workflows: [] },
      rules: {
        "Auto-merge available": repository === "team/one" ? "Met" : "Missing",
      },
      // team/one's organization keeps drafts by default; team/two turned it off.
      draftPullRequests: repository === "team/one",
      // team/one's installation cannot change workflow files.
      setup:
        repository === "team/one"
          ? {
              applicable: true,
              canComplete: false,
              missingPermissions: ["Workflows (write)"],
            }
          : {
              applicable: true,
              canComplete: true,
              missingPermissions: [],
              ...(setupStarted ? { report: setupReport } : {}),
            },
    };
  }
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/plugins/github") return route.fulfill({ json: view() });
    if (url.pathname === "/api/apps/software-foundry/bootstrap")
      return bootstrapResponse(route, url);
    if (url.pathname === "/api/plugins/github/governance")
      return governanceResponse(route, url);
    const response = await worker.fetch(url.href);
    return fulfillFrom(route, response);
  });
  await page.goto(`${origin}/governance?repository=team/unapproved`);
  await expect(page.locator("#governance-repository option")).toHaveCount(2);
  await expect(page.locator('[data-document="AGENTS.md"] input')).toBeChecked();
  // The app's bootstrap names the repository; the platform checks it once.
  expect(bootstraps).toHaveLength(1);
  expect(checks.map((url) => url.searchParams.get("repository"))).toEqual(["team/one"]);
  await expect(page).toHaveURL(/repository=team%2Fone/);
  await expect(
    page.getByRole("link", { name: "Governance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.locator('[data-rule="Pull requests required"] input'),
  ).toHaveJSProperty("indeterminate", true);
  const mergeQueue = page.locator('[data-rule="Merge queue required"]');
  const setup = page.locator("#governance-setup");
  const autoMerge = page.locator('[data-rule="Auto-merge available"]');
  await expect(autoMerge.locator("input")).toBeChecked();
  await test.step("a queue without merge_group triggers names the workflows and the grant setup needs", async () => {
    await expect(mergeQueue).toHaveAttribute(
      "data-status",
      "merge-group-missing",
    );
    await expect(mergeQueue.locator("input")).not.toBeChecked();
    await expect(
      mergeQueue.getByRole("link", { name: "ci.yml" }),
    ).toHaveAttribute(
      "href",
      `https://github.com/team/one/blob/${"a".repeat(40)}/.github/workflows/ci.yml`,
    );
    await expect(setup).toContainText("needs Workflows (write)");
    await expect(
      setup.getByRole("button", { name: "Complete all", exact: true }),
    ).toHaveCount(0);
  });
  await page.locator("#governance-repository").selectOption("team/two");
  await expect(autoMerge.locator("input")).not.toBeChecked();
  await expect(autoMerge.locator("input")).toHaveJSProperty(
    "indeterminate",
    false,
  );
  await expect(page.locator('[data-document="AGENTS.md"]')).toHaveAttribute(
    "data-status",
    "missing",
  );
  await expect(page).toHaveURL(/repository=team%2Ftwo/);
  await test.step("the draft policy is informational: off is not a failing check", async () => {
    const policy = page.locator('[data-policy="draft-pull-requests"]');
    await expect(policy).toHaveAttribute("data-status", "info");
    await expect(policy.locator("input")).not.toBeChecked();
    await expect(policy.locator("input")).toHaveJSProperty(
      "indeterminate",
      false,
    );
    await expect(policy).toContainText(
      "Off: agents open pull requests ready for review",
    );
  });
  await test.step("Complete all opens the app's pull request and holds the queue until it merges", async () => {
    await expect(mergeQueue).toHaveAttribute("data-status", "missing");
    await setup
      .getByRole("button", { name: "Complete all", exact: true })
      .click();
    await expect(page.locator("#governance-notice")).toContainText(
      "waiting on GitHub",
    );
    expect(completed).toEqual([
      { repository: "team/two", action: "complete-sdlc-setup" },
    ]);
    const parts = setup
      .getByRole("list", { name: "Setup parts" })
      .getByRole("listitem");
    await expect(parts).toHaveCount(5);
    await expect(
      setup.getByRole("link", { name: "Open pull request #12" }),
    ).toHaveAttribute("href", "https://github.com/team/two/pull/12");
    await expect(
      setup.locator('[data-step="merge-queue-after-merge"]'),
    ).toHaveAttribute("data-status", "waiting");
    await expect(
      setup.locator('[data-step="merge-queue-after-merge"]'),
    ).toContainText("does not stall in the queue");
    // The queue is not created early, so the row is still missing.
    await expect(mergeQueue).toHaveAttribute("data-status", "missing");
    // The open run stays visible after a refresh, and can be resumed.
    await page.locator("#governance-refresh").click();
    await expect(setup.locator('[data-step="pull-request"]')).toHaveAttribute(
      "data-status",
      "done",
    );
    await expect(
      setup.getByRole("button", { name: "Complete all", exact: true }),
    ).toBeEnabled();
  });
  unavailable = true;
  await page.locator("#governance-refresh").click();
  await expect(page.locator("#governance-notice")).toContainText(
    "GitHub unavailable",
  );
  await expect(
    page.locator('[data-document="AGENTS.md"] input'),
  ).toHaveJSProperty("indeterminate", true);
  unavailable = false;
  await page.locator("#governance-refresh").click();
  await expect(page.locator("#governance-notice")).toHaveText(
    "Repository document check complete.",
  );
  await page.screenshot({
    path: testInfo.outputPath("governance-desktop.png"),
  });
  await page
    .locator('[data-rule="Auto-merge available"]')
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("governance-delivery.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("heading", { name: "Governance", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("governance-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  empty = true;
  await page.reload();
  await expect(page.locator("#governance-notice")).toContainText(
    "No available repositories",
  );
  await expect(page.locator("#governance-refresh")).toBeDisabled();
  expect(errors).toEqual([]);
});
