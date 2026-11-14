import { queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import { expect, test } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import {
  canonicalReleaseProject,
  projectReleasesFixture,
  releaseId,
  releaseProviders,
} from "./fixtures/project-releases";

const origin = "https://planning.example";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const projectResult = (input: { installationId: string; id: string }) =>
  input.installationId === "planning" && input.id === releaseId(9)
    ? { ok: true as const, value: canonicalReleaseProject }
    : { ok: false as const, status: 404, message: "Project not found" };
for (const width of [1440, 390])
  test(`review Wiki-backed release and evidence inside Planning at ${width}px`, async ({
    browser,
  }, info) => {
    const graph = projectReleasesFixture();
    let unavailable = false;
    async function graphReply(input: { action: string; input?: unknown }) {
      if (unavailable) return {ok:false as const,status:503,message:"Wiki unavailable"};
      if (input.action === "graph.query") return {ok:true as const,value:await queryGraph({version:1,installationId:"wiki",...graph,selection:null,truncated:false,missingTypes:[]} as never, input.input as never)};
      expect(input.action).toBe("graph.read");
      return {ok:true as const,value:{version:1,installationId:"wiki",...graph,selection:null,truncated:false,missingTypes:[]}};
    }
    const app = await appWorker(
      "planning",
      appArtifact(new URL("..", import.meta.url), "operational"),
      "planning",
      {
        workflowHost: (scope) => ({
          async call(operation, raw) {
            expect(scope.organizationId).toBe("org");
            const input = raw as {
              installationId: string;
              id: string;
              action: string;
              readOnly: boolean;
            };
            if (operation === "entities.types")
              return { ok: true, value: releaseProviders() };
            if (operation === "entities.get") return projectResult(input);
            if (operation === "entities.list") return { ok: true, value: [] };
            expect(operation).toBe("actions.call");
            expect(input).toMatchObject({
              installationId: "wiki",
              readOnly: true,
            });
            return graphReply(input);
          },
        }),
      },
    );
    const context = await browser.newContext({
      viewport: { width, height: 1050 },
      javaScriptEnabled: false,
    });
    const page = await context.newPage();
    const foreignRequests: string[] = [];
    page.on("request", (request) => {
      if (
        !request.url().startsWith(origin) &&
        !request.url().startsWith("https://evidence.example/bundle/")
      )
        foreignRequests.push(request.url());
    });
    const screenshot = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("https://evidence.example/**", (route) =>
      route.fulfill({ contentType: "image/png", body: screenshot }),
    );
    await page.route(`${origin}/**`, async (route) =>
      fulfillFrom(
        route,
        await app.call(
          new URL(route.request().url()).pathname +
            new URL(route.request().url()).search,
          owner,
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
      ),
    );
    const project = `/projects/${releaseId(9)}`;
    const evidence = `${project}/evidence`;
    const releases = `${project}/releases`;
    try {
      await page.goto(origin + project);
      await page.getByRole("link", { name: "Review evidence", exact: true }).click();
      await expect(page).toHaveURL(origin + evidence);
      await expect(
        page.getByRole("heading", { name: "Evidence inventory" }),
      ).toBeVisible();
      await expect(page.locator("article")).toContainText(
        "Sensor tests are pending",
      );
      await expect(page.getByText("Foreign evidence")).toHaveCount(0);
      await expect(page.locator("article img")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Check a plant — abc12345" }),
      ).toBeVisible();
      await expect(page.locator(".planning-evidence-grid img")).toHaveCount(1);
      await expect(page.getByText("Foreign demonstration")).toHaveCount(0);
      await expect(page.locator('article a[href^="javascript:"]')).toHaveCount(
        0,
      );
      await page.screenshot({
        path: info.outputPath(`release-evidence-${width}.png`),
        fullPage: true,
      });
      await page.goto(origin + project);
      await page.locator("details.planning-project-details > summary").click();
      await page
        .getByRole("link", { name: "Press release", exact: true })
        .click();
      await expect(page).toHaveURL(origin + releases);
      await expect(
        page.getByRole("heading", { name: "Know when your plant needs care" }),
      ).toBeVisible();
      await expect(page.locator("article")).toContainText("draft · Revision 1");
      await expect(page.locator("article")).toContainText("(hypothetical)");
      await expect(page.locator(".planning-evidence-grid")).toHaveCount(0);
      await expect(page.locator("article")).toContainText("Shipping date");
      await expect(page.getByText("Foreign press release")).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(`press-release-${width}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      graph.nodes[2].body =
        "## Evidence inventory\n\nNew source evidence is visible after reload.";
      graph.nodes[2].revision = 2;
      await page.goto(origin + evidence);
      await expect(page.locator("article")).toContainText(
        "New source evidence is visible after reload",
      );
      await expect(page.locator("article")).toContainText("Revision 2");
      expect(
        (await page.goto(`${origin}${evidence}?bundle=${releaseId(6)}`))?.status(),
      ).toBe(404);
      await expect(page.getByRole("alert")).toContainText(
        "not linked to the selected project",
      );
      // Old evidence links on the press release page land on the evidence page.
      expect(
        (await page.goto(`${origin}${releases}?bundle=${releaseId(6)}`))?.status(),
      ).toBe(404);
      await expect(page.getByRole("alert")).toContainText(
        "not linked to the selected project",
      );
      expect(
        (await page.goto(`${origin}${releases}?release=${releaseId(5)}`))?.status(),
      ).toBe(404);
      unavailable = true;
      expect((await page.goto(origin + evidence))?.status()).toBe(503);
      await expect(page.getByRole("alert")).toContainText("unavailable");
      expect((await page.goto(origin + releases))?.status()).toBe(503);
      await expect(page.getByRole("alert")).toContainText("unavailable");
      expect((await app.call(releases)).status).toBe(401);
      expect((await app.call(evidence)).status).toBe(401);
      expect(foreignRequests).toEqual([]);
    } finally {
      await context.close();
      await app.dispose();
    }
  });

test("read-only Planning demo exposes a synthetic release review without an owner host", async ({
  page,
}) => {
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "demo"),
  );
  await page.route(`${origin}/**`, async (route) =>
    fulfillFrom(
      route,
      await app.call(
        new URL(route.request().url()).pathname +
          new URL(route.request().url()).search,
      ),
    ),
  );
  try {
    const project = `${origin}/projects/00000000-0000-4000-8000-000000000001`;
    await page.goto(`${project}/releases`);
    await expect(
      page.getByText(
        "Read-only demo · These press release records are synthetic.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "A shared place to choose the next useful step",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Wiki source", exact: true }),
    ).toHaveCount(0);
    await page.goto(`${project}/evidence`);
    await expect(
      page.getByText("Read-only demo · These evidence records are synthetic."),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Evidence inventory" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Wiki source", exact: true }),
    ).toHaveCount(0);
  } finally {
    await app.dispose();
  }
});
