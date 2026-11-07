import { test, expect, type Page } from "@playwright/test";
import { defined } from "@ai-outfitter/app-test/assertions";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom, isPlatformIdentityRequest } from "@ai-outfitter/app-test/playwright";
const origin = "https://software-foundry.outfitter.example";

async function servePackage(mode: "demo" | "operational") {
  return appWorker(
    "software-foundry",
    appArtifact(new URL("..", import.meta.url), mode),
  );
}

// Routed per context so tabs opened from the page reach the same worker.
async function fromWorker(
  page: Page,
  app: Awaited<ReturnType<typeof servePackage>>,
  api: (url: URL) => unknown,
) {
  await page.context().route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const handled = await api(url);
    if (handled)
      return route.fulfill(handled as Parameters<typeof route.fulfill>[0]);
    const response = await app.fetch(url.href);
    return fulfillFrom(route, response);
  });
}

test("operational milestones list issues, pull requests and recorded runs with honest empty and error states", async ({
  page,
}, testInfo) => {
  const app = await servePackage("operational");
  const errors: string[] = [];
  const requested: URL[] = [];
  let canEdit = true;
  let down = false;
  page.on("pageerror", (error) => errors.push(error.message));
  const runId = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  const bootstraps: URL[] = [];
  const view = () => ({
    connected: true, canEdit,
    repositories: ["team/one", "team/two"].map((name) => ({
      name,
    })),
    scopes: [],
  });
  const milestone = {
    number: 3,
    title: "Accessible command menu",
    description: "Every command is reachable.",
    state: "open",
    openItems: 2,
    closedItems: 1,
    dueOn: "2026-10-30T07:00:00Z",
    updatedAt: "2026-10-06T12:00:00Z",
    url: "https://github.com/team/one/milestone/3",
  };
  const list = (repository: string, state: string | null) => ({
    repository,
    state,
    milestones: repository === "team/one" ? [milestone] : [],
    truncated: false,
  });
  const detail = (repository: string) => ({
    repository,
    milestone,
    truncated: false,
    pullRequestsListed: true,
    issues: [
      {
        number: 42,
        title: "Keyboard navigation",
        state: "open",
        updatedAt: milestone.updatedAt,
        url: "https://github.com/team/one/issues/42",
        runs: [
          { id: runId, workflowId: "issue-to-merge-workspace", title: "#42", status: "failed", updatedAt: 1 },
          { id: "legacy-run", title: "#42", status: "running", updatedAt: 0 },
        ],
      },
      {
        number: 39,
        title: "Focus trap",
        state: "closed",
        updatedAt: milestone.updatedAt,
        url: "https://github.com/team/one/issues/39",
        runs: [],
      },
    ],
    pullRequests: [
      {
        number: 45,
        title: "Announce results",
        state: "open",
        draft: true,
        updatedAt: milestone.updatedAt,
        url: "https://github.com/team/one/pull/45",
      },
    ],
  });
  const refused = "GitHub App repository authorization failed";
  // The page bootstrap: the view, the list and the selected milestone in one
  // response. Members are refused and fall back to the view.
  function bootstrap(url: URL) {
    bootstraps.push(url);
    if (down) return { status: 503, body: "GitHub unavailable" };
    const requestedRepository = url.searchParams.get("repository") ?? "";
    const repository = ["team/one", "team/two"].includes(requestedRepository)
      ? requestedRepository
      : "team/one";
    const number = url.searchParams.get("milestone");
    return {
      json: {
        page: "milestones",
        plugin: view(),
        milestones: {
          repository,
          state: url.searchParams.get("state"),
          list: list(repository, url.searchParams.get("state")),
          detail: !number
            ? null
            : number === "4"
              ? { error: refused, status: 403 }
              : detail(repository),
        },
      },
    };
  }
  await fromWorker(page, app, (url) => {
    if (url.pathname === "/api/plugins/github") return { json: view() };
    if (url.pathname === "/api/apps/software-foundry/bootstrap") return bootstrap(url);
    if (url.pathname !== "/api/apps/software-foundry/milestones") return null;
    requested.push(url);
    if (down) return { status: 503, body: "GitHub unavailable" };
    if (url.searchParams.get("milestone") === "4")
      return { status: 403, body: refused };
    const repository = defined(
      url.searchParams.get("repository"),
      "repository",
    );
    expect(["team/one", "team/two"]).toContain(repository);
    if (!url.searchParams.has("milestone"))
      return { json: list(repository, url.searchParams.get("state")) };
    return { json: detail(repository) };
  });
  try {
    await page.goto(`${origin}/milestones?repository=team/unapproved`);
    await expect(
      page.getByRole("link", { name: "Milestones", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#milestone-repository option")).toHaveCount(2);
    await expect(page.locator("#milestone-list")).toContainText(
      "Accessible command menu",
    );
    await expect(page.locator("#milestone-list")).toContainText(
      "1 of 3 closed",
    );
    await expect(page.locator("#milestone-detail")).toBeHidden();
    // The first render is one bootstrap request, for the first approved repository.
    expect(bootstraps).toHaveLength(1);
    expect(requested).toHaveLength(0);
    await expect(page).toHaveURL(/repository=team%2Fone/);

    // Modified clicks keep browser link behavior; only a plain primary click is
    // handled in the page. A document listener runs after the link's handler,
    // records whether it took over, then stops the synthetic navigation.
    const milestoneLink = page.getByRole("link", {
      name: "Accessible command menu",
    });
    const handled = await milestoneLink.evaluate((link) => {
      const result: Record<string, boolean> = {};
      const record = (event: Event) => {
        result.last = event.defaultPrevented;
        event.preventDefault();
      };
      document.addEventListener("click", record);
      for (const [name, init] of Object.entries({
        ctrl: { ctrlKey: true },
        meta: { metaKey: true },
        shift: { shiftKey: true },
        alt: { altKey: true },
      })) {
        link.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, ...init }),
        );
        result[name] = result.last;
      }
      document.removeEventListener("click", record);
      delete result.last;
      return result;
    });
    expect(handled).toEqual({
      ctrl: false,
      meta: false,
      shift: false,
      alt: false,
    });
    await expect(page).not.toHaveURL(/milestone=/);
    await expect(page.locator("#milestone-detail")).toBeHidden();

    // A plain click stays in this document instead of reloading it.
    await page.evaluate(() => Object.assign(window, { samePage: true }));
    await milestoneLink.click();
    await expect(page).toHaveURL(/milestone=3/);
    expect(await page.evaluate(() => "samePage" in window)).toBe(true);
    await expect(page.locator("#milestone-detail-heading")).toHaveText(
      "Accessible command menu",
    );
    await expect(page.locator("#milestone-issues tr")).toHaveCount(2);
    await expect(page.locator("#milestone-issues")).toContainText(
      "Issue to review · Failed",
    );
    await expect(
      page.locator("#milestone-issues a.workflow-link"),
    ).toHaveAttribute("href", new RegExp(`/workflows/issue-to-merge-workspace/runs/${runId}$`));
    await expect(page.locator("#milestone-issues span.workflow-link")).toHaveCount(1);
    await expect(page.locator("#milestone-issues")).toContainText(
      "None recorded",
    );
    await expect(page.locator("#milestone-pulls")).toContainText("Draft");
    await expect(page.locator("#milestone-pulls-empty")).toBeHidden();
    // Roles are described, never offered as controls that imply dispatch.
    const roles = page.getByRole("region", {
      name: "Agent roles and current support",
    });
    await expect(roles).toContainText("Not available");
    await expect(roles).toContainText(
      "reviews the exact published PR revision",
    );
    await expect(roles).toContainText(
      "There is no standalone milestone review action.",
    );
    await expect(
      page.locator(".ui-content button:not(#milestone-refresh)"),
    ).toHaveCount(0);
    // Content scrolls inside the app frame, so capture each lower region in view.
    const capture = async (name: string) => {
      await page.screenshot({
        path: testInfo.outputPath(`milestones-${name}.png`),
        fullPage: true,
      });
      await page.locator("#milestone-issues").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`milestones-${name}-issues.png`),
      });
      await page.locator("#milestone-pulls").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`milestones-${name}-pulls.png`),
      });
      await roles.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`milestones-${name}-roles.png`),
      });
    };
    await capture("desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await capture("mobile");
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goBack();
    await expect(page.locator("#milestone-detail")).toBeHidden();
    const beforeDeepLink = requested.filter((url) => url.searchParams.get("milestone") === "3").length;
    await page.goto(`${origin}/milestones?repository=team/one&milestone=3`);
    await expect(page.locator("#milestone-detail-heading")).toHaveText(
      "Accessible command menu",
    );
    await expect(page.locator("#milestone-issues tr")).toHaveCount(2);
    // A deep link renders the list and the milestone from the bootstrap alone.
    expect(requested.filter((url) => url.searchParams.get("milestone") === "3").length).toBe(beforeDeepLink);
    expect(bootstraps.at(-1)?.searchParams.get("milestone")).toBe("3");

    await page.locator("#milestone-repository").selectOption("team/two");
    await expect(page.locator("#milestone-list-empty")).toHaveText(
      "No open milestones in team/two.",
    );
    await expect(page.locator("#milestone-detail")).toBeHidden();
    await expect(page).not.toHaveURL(/milestone=/);
    await page.locator("#milestone-state").selectOption("closed");
    await expect(page.locator("#milestone-list-empty")).toHaveText(
      "No closed milestones in team/two.",
    );
    expect(requested.at(-1)?.searchParams.get("state")).toBe("closed");

    down = true;
    await page.locator("#milestone-refresh").click();
    await expect(page.locator("#milestone-notice")).toContainText(
      "GitHub unavailable",
    );
    await expect(page.locator("#milestone-list-empty")).toHaveText(
      "Milestones could not be loaded.",
    );
    await page.goto(`${origin}/milestones?repository=team/one&milestone=3`);
    await expect(page.locator("#milestone-notice")).toContainText(
      "GitHub unavailable",
    );
    await expect(page.locator("#milestone-summary")).toHaveText(
      "Milestone could not be loaded: GitHub unavailable",
    );
    await expect(page.locator("#milestone-github")).toBeHidden();
    down = false;
    // A stale milestone link fails on its own while the list still loads.
    await page.goto(`${origin}/milestones?repository=team/one&milestone=4`);
    await expect(page.locator("#milestone-list")).toContainText(
      "Accessible command menu",
    );
    await expect(page.locator("#milestone-summary")).toHaveText(
      "Milestone could not be loaded: GitHub App repository authorization failed",
    );
    await expect(page.locator("#milestone-issues tr")).toHaveCount(0);

    canEdit = false;
    down = false;
    await page.goto(`${origin}/milestones`);
    await expect(page.locator("#milestone-repository")).toBeEnabled();
    await expect(page.locator("#milestone-list")).toContainText("Accessible command menu");
    expect(errors).toEqual([]);
  } finally {
    // Late asset requests must not reach a disposed worker. After a timeout the
    // context is already closed; don't let cleanup mask the step that hung.
    await page
      .context()
      .unrouteAll({ behavior: "ignoreErrors" })
      .catch(() => {});
    await app.dispose();
  }
});

test("demo milestones render fixtures read-only in the same shell", async ({
  page,
}, testInfo) => {
  const app = await servePackage("demo");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fromWorker(page, app, (url) => {
    if (isPlatformIdentityRequest(url)) return null;
    expect(url.pathname.startsWith("/api/")).toBe(false);
    return null;
  });
  page.on("request", (request) => expect(request.method()).toBe("GET"));
  try {
    await page.goto(`${origin}/milestones`);
    await expect(page.locator("#milestone-repository")).toHaveValue(
      "northstar/platform",
    );
    await expect(page.locator("#milestone-list")).toContainText(
      "Accessible command menu",
    );
    // The sidebar links the project's milestones too; open the list's.
    await page
      .locator("#milestone-list")
      .getByRole("link", { name: "Accessible command menu" })
      .click();
    await expect(page.locator("#milestone-issues tr")).toHaveCount(4);
    await expect(page.locator("#milestone-issues")).toContainText(
      "Issue to review · Completed",
    );
    // Fixture runs have no workflow page, so they are not links.
    await expect(page.locator("#milestone-issues a.workflow-link")).toHaveCount(
      0,
    );
    await expect(page.locator("#milestone-pulls")).toContainText("Merged");
    await expect(page.locator("body")).not.toContainText(
      /\bdemo\b|\bstaged\b|sample data/i,
    );
    await page.screenshot({
      path: testInfo.outputPath("milestones-demo.png"),
      fullPage: true,
    });
    await page
      .locator("#milestone-repository")
      .selectOption("northstar/interface");
    await expect(page.locator("#milestone-list")).toContainText(
      "Design tokens everywhere",
    );
    await page.goto(`${origin}/settings`);
    await page.getByRole("link", { name: "Open milestones" }).click();
    await expect(page.locator("#milestone-list")).toContainText(
      "Accessible command menu",
    );
    expect(errors).toEqual([]);
  } finally {
    // Late asset requests must not reach a disposed worker. After a timeout the
    // context is already closed; don't let cleanup mask the step that hung.
    await page
      .context()
      .unrouteAll({ behavior: "ignoreErrors" })
      .catch(() => {});
    await app.dispose();
  }
});
