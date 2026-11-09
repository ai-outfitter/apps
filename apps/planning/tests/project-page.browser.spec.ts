import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import { withPlatform } from "./platform-document";

const origin = "https://planning.alpha.localhost";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
for (const width of [1440, 390])
  test(`Project directory and detail render primary HTML without JavaScript at ${width}px`, async ({
    browser,
  }) => {
    const queries: { operation: string; input: Record<string, unknown> }[] = [];
    const app = await appWorker(
      "planning",
      appArtifact(new URL("..", import.meta.url), "operational"),
      "planning",
      {
        workflowHost: (scope) => withPlatform(app, () => owner, scope, {
          async call(operation, raw) {
            expect(scope.organizationId).toBe(owner.organizationId);
            expect(scope.installationId).toBe("planning");
            const { installationId, ...input } = raw as Record<string, unknown>;
            if (operation !== "entities.types")
              expect(installationId).toBe("planning");
            queries.push({ operation, input: operation === "entities.types" ? raw as Record<string, unknown> : input });
            const action = operation.replace("entities.", "");
            const response = await app.call(
              `/api/internal/entities/v1/${action}`,
              owner,
              action === "types"
                ? { method: "GET" }
                : { method: "POST", body: input },
            );
            if (!response.ok)
              return {
                ok: false,
                status: response.status,
                message: await response.text(),
              };
            const value = await response.json();
            return {
              ok: true,
              value:
                action === "types"
                  ? (value as Record<string, unknown>[]).map((type) => ({
                      ...type,
                      installationId: "planning",
                      template: "planning",
                    }))
                  : value,
            };
          },
        }, (operation, raw) => queries.push({ operation, input: raw as Record<string, unknown> })),
      },
    );
    const created = await app.call("/api/apps/planning/projects", owner, {
      method: "POST",
      body: {
        name: "Server rendered project",
        goals: "Visible without client loading",
        userStories: "People can inspect context before interacting",
      },
    });
    expect(created.status).toBe(200);
    const project = (await created.json()) as { id: string };
    const issue = await app.call("/api/apps/planning/issues", owner, {
      method: "POST",
      body: {
        projectId: project.id,
        title: "Server rendered issue",
        description: "Issue description is in initial HTML",
        category: "stone",
      },
    });
    expect(issue.status).toBe(200);
    const foreign = await app.dispatch(
      "",
      new Request(`${origin}/api/apps/planning/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-outfitter-user": "other",
          "x-outfitter-organization": "other-org",
          "x-outfitter-installation": "other-planning",
          "x-outfitter-role": "owner",
        },
        body: JSON.stringify({ name: "Other organization project" }),
      }),
    );
    expect(foreign.status).toBe(200);
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width, height: 1000 },
    });
    const page = await context.newPage();
    const browserDataRequests: string[] = [];
    await page.route(`${origin}/**`, async (route) => {
      if (await fulfillPlatformIdentity(route)) return;
      const request = route.request();
      if (new URL(request.url()).pathname.startsWith("/api/"))
        browserDataRequests.push(request.url());
      await fulfillFrom(
        route,
        await app.dispatch(
          "",
          new Request(request.url(), {
            redirect: "manual",
            method: request.method(),
            headers: {
              ...request.headers(),
              "x-outfitter-user": owner.userId,
              "x-outfitter-organization": owner.organizationId,
              "x-outfitter-installation": "planning",
              "x-outfitter-role": owner.role,
            },
          }),
          {
            workflowHost: {
              ...owner,
              installationId: "planning",
              packageHash: "fixture",
              phase: "interactive",
              expiresAt: Date.now() + 3600000,
            },
          },
        ),
      );
    });
    try {
      expect((await page.goto(`${origin}/projects`))?.status()).toBe(200);
      const card = page
        .locator("#project-cards")
        .getByRole("link", { name: /Server rendered project/ });
      await expect(card).toBeVisible();
      await expect(
        page.locator("#project-cards .planning-org-project").filter({ hasText: "Server rendered project" }).locator(".planning-status"),
      ).toBeVisible();
      await expect(page.getByText("Other organization project")).toHaveCount(0);
      // Wiki discovery once per request: the page itself, and the Projects and
      // OrganizationGoals documents it reads through the platform.
      expect(
        queries.filter((q) => q.operation === "entities.types").map((q) => q.input),
      ).toEqual([{ template: "wiki-map" }, { template: "wiki-map" }, { template: "wiki-map" }]);
      await page.screenshot({ path: test.info().outputPath(`projects-${width}.png`), fullPage: true });
      queries.length = 0;
      expect(
        (await page.goto(`${origin}/projects/${project.id}`))?.status(),
      ).toBe(200);
      await expect(page.locator("#project-documents")).toContainText(
        "Visible without client loading",
      );
      await expect(
        page.getByRole("heading", {
          name: "Server rendered issue",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator("#issue-list")).toContainText(
        "Issue description is in initial HTML",
      );
      expect(
        queries
          .filter((q) => q.operation === "entities.get")
          .map((q) => q.input.id),
      ).toEqual([project.id]);
      const issueQueries = queries.filter(
        (q) => q.operation === "entities.list" && q.input.type === "issue",
      );
      expect(issueQueries).toHaveLength(1);
      expect(issueQueries[0].input.filter).toEqual({ projectId: project.id });
      expect(browserDataRequests).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`project-detail-${width}.png`), fullPage: true });
      const missing = "00000000-0000-4000-8000-000000000099";
      expect((await page.goto(`${origin}/projects/${missing}`))?.status()).toBe(
        404,
      );
      await expect(
        page.getByRole("status").filter({ hasText: "Project not found" }),
      ).toBeVisible();
      expect((await app.call("/projects")).status).toBe(401);
      expect((await app.call(`/projects/${project.id}`)).status).toBe(401);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await context.close();
      await app.dispose();
    }
  });
