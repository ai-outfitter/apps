import { test, expect } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
const id = (n: number) =>
  `33000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "https://planning.alpha.localhost";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
for (const width of [1440, 390])
  test(`Project requirements show structured criteria and preview selected work at ${width}px`, async ({
    page,
  }, info) => {
    const app = await appWorker(
      "planning",
      appArtifact(new URL("..", import.meta.url), "operational"),
      "planning",
      {
        workflowHost: () => ({
          async call(operation, raw) {
            const action = operation.replace("entities.", "");
            const { installationId: _installationId, ...input } = raw as Record<
              string,
              unknown
            >;
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
        }),
      },
    );
    const created = await app.call("/api/apps/planning/projects", owner, {
      method: "POST",
      body: { name: "Graph-backed context", goals: "Useful work" },
    });
    expect(created.status).toBe(200);
    const { id: projectId } = (await created.json()) as { id: string };
    const node = (id: string, typeId: string, title: string, body = "") => ({
      ref: { installationId: "wiki", type: "graph-node", id },
      revision: 2,
      title,
      attributes: { typeId, body, summary: "Proposed scope" },
      references: [],
    });
    const requirement = node(
        id(2),
        "requirement-type",
        "Render bounded context",
        JSON.stringify({
          statement: "Render selected context",
          status: "proposed",
        }),
      ),
      criterion = node(
        id(3),
        "criterion-type",
        "Exclude unrelated records",
        JSON.stringify({
          condition: "Preview selected work",
          expectedOutcome: "Only selected requirements appear",
        }),
      );
    const requests: Record<string, unknown>[] = [];
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path === "/api/apps/planning/work-context") {
        if (request.method() === "POST") {
          requests.push(request.postDataJSON());
          if (requests.length > 1)
            return route.fulfill({
              status: 413,
              body: "Narrow the selected scope",
            });
          return route.fulfill({
            json: {
              description:
                "# Implement bounded context\n\nCondition: Preview selected work\nExpected outcome: Only selected requirements appear",
              gaps: [],
              warnings: ["Recipe is proposed"],
            },
          });
        }
        return route.fulfill({
          json: {
            wiki: { installationId: "wiki", hostname: "wiki.example" },
            nodes: [requirement, criterion],
            requirements: [requirement],
            criteria: [criterion],
            types: [
              {
                ref: { id: "requirement-type" },
                attributes: { name: "Requirement" },
              },
              {
                ref: { id: "criterion-type" },
                attributes: { name: "AcceptanceCriterion" },
              },
              {
                ref: { id: "edge-type" },
                attributes: { name: "has_acceptance_criterion" },
              },
            ],
            edges: [
              {
                attributes: {
                  fromId: id(2),
                  toId: id(3),
                  typeId: "edge-type",
                },
              },
            ],
            definitions: [
              node(id(4), "definition-type", "Implementation brief"),
            ],
            gaps: [],
          },
        });
      }
      if (path === "/api/apps/planning")
        return route.fulfill({
          json: {
            projects: [
              {
                id: projectId,
                name: "Graph-backed context",
                goals: "Useful work",
                revision: 1,
              },
            ],
            issues: [],
          },
        });
      if (path === "/api/apps/planning/use-cases/context")
        return route.fulfill({ json: { hostname: "wiki.example" } });
      if (path.startsWith("/api/")) return route.fulfill({ json: [] });
      return fulfillFrom(
        route,
        await app.dispatch(
          "",
          new Request(request.url(), {
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
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/projects/${projectId}`);
      await expect(
        page.getByRole("heading", {
          name: "Requirements and acceptance criteria",
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Expected outcome: Only selected requirements appear", {
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Preview work package" }).click();
      await expect(
        page.getByText("Select at least one requirement."),
      ).toBeVisible();
      expect(requests).toHaveLength(0);
      await page
        .getByRole("checkbox", { name: "Render bounded context" })
        .check();
      await page.getByRole("button", { name: "Preview work package" }).click();
      await expect(page.locator("#work-preview-output")).toContainText(
        "Only selected requirements appear",
      );
      expect(requests).toEqual([
        {
          projectId,
          requirementIds: [id(2)],
          definitionId: id(4),
        },
      ]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`planning-work-preview-${width}.png`),
        fullPage: true,
      });
      await expect(page.locator("#work-context-status")).toContainText(
        "Recipe is proposed",
      );
      await page.getByRole("button", { name: "Preview work package" }).click();
      await expect(page.locator("#work-context-status")).toContainText(
        "Narrow the selected scope",
      );
      await expect(page.locator("#work-preview-output")).toBeHidden();
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await app.dispose();
    }
  });
