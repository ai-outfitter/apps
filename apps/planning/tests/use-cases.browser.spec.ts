import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { test, expect } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom, routeReadOnly } from "@ai-outfitter/app-test/playwright";
const origin = "https://planning.alpha.localhost";
for (const width of [1440, 390]) {
  test(`use cases can be authored, edited and archived at ${width}px`, async ({
    page,
  }, info) => {
    const app = await appWorker(
      "planning",
      appArtifact(new URL("..", import.meta.url), "operational"),
    );
    const state: { row: EntityRecord | null } = { row: null };
    const activeRows = () =>
      state.row && !state.row.attributes.archived ? [state.row] : [];
    let setup = false;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(`${origin}/**`, async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path === "/api/apps/planning/use-cases/context") {
        expect(req.method()).toBe("POST");
        setup = true;
        await route.fulfill({
          json: {
            installationId: "wiki",
            hostname: "wiki.alpha.localhost",
            writable: true,
          },
        });
        return;
      }
      if (path === "/api/apps/planning") {
        await route.fulfill({
          json: {
            projects: [
              {
                id: "project",
                name: "Improve planning",
                installationId: "planning",
              },
              {
                id: "other",
                name: "Other project",
                installationId: "planning",
              },
            ],
          },
        });
        return;
      }
      if (path === "/api/apps/planning/discovery/use-cases")
        return route.fulfill({
          json: {
            records: activeRows(),
            graph: { nodes: [], edges: [], types: [] },
          },
        });
      if (path === "/api/apps/planning/use-cases") {
        expect(new URL(req.url()).searchParams.has("projectId")).toBe(false);
        if (req.method() === "POST") {
          expect(setup).toBe(true);
          const body = req.postDataJSON();
          state.row = {
            ref: { installationId: "wiki", type: "graph-node", id: "record" },
            references: [],
            title: body.title,
            revision: (state.row?.revision ?? 0) + 1,
            attributes: {
              properties: {
                project_id: body.projectId,
                planning_installation_id: "planning",
              },
              summary: body.summary,
              body: JSON.stringify(body.document),
              archived: body.archived ?? false,
            },
          };
          await route.fulfill({ json: state.row });
        } else
          await route.fulfill({
            json: activeRows(),
          });
        return;
      }
      await fulfillFrom(
        route,
        await app.dispatch(
          "",
          new Request(req.url(), {
            headers: {
              "x-outfitter-user": "owner",
              "x-outfitter-organization": "org",
              "x-outfitter-installation": app.installationId,
              "x-outfitter-role": "owner",
            },
          }),
        ),
      );
    });
    try {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/use-cases`);
      await expect(
        page.getByRole("button", { name: "Set up use cases" }),
      ).toHaveCount(0);
      await expect(page.locator("#wiki-select")).toHaveCount(0);
      await expect(page.locator("#use-case-project")).not.toBeVisible();
      await page
        .getByRole("button", { name: "New use case", exact: true })
        .click();
      const form = page.locator("#use-case-editor");
      await form
        .getByLabel("Title", { exact: true })
        .fill("Choose useful work");
      await form.getByLabel("Actor", { exact: true }).fill("Team member");
      await form
        .getByLabel("Goal", { exact: true })
        .fill("Find an unblocked task that supports the project");
      await form
        .getByLabel("Main flow", { exact: true })
        .fill("Review the goal, then choose an issue.");
      await form
        .getByLabel("Success criteria", { exact: true })
        .fill("The selected issue supports a project goal.");
      await page.screenshot({
        path: info.outputPath(`use-case-editor-${width}.png`),
        fullPage: true,
      });
      await form.getByRole("button", { name: "Save to Wiki" }).click();
      await expect(
        page.getByRole("heading", { name: "Choose useful work", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".knowledge-graph-stage")).toHaveCount(0);
      await page.locator("#use-case-list summary").click();
      await expect(page.locator(".knowledge-graph-stage")).toHaveCount(1);
      await expect(page.locator(".planning-pills")).toContainText(
        "Improve planning",
      );
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await form
        .getByLabel("Title", { exact: true })
        .fill("Choose valuable work");
      await form.getByRole("button", { name: "Save to Wiki" }).click();
      await expect(
        page.getByRole("heading", {
          name: "Choose valuable work",
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`use-case-saved-${width}.png`),
        fullPage: true,
      });
      await page.locator("#use-case-list summary").click();
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Archive", exact: true }).click();
      await expect(page.locator("#use-case-empty")).toBeVisible();
      expect(state.row?.attributes.archived).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await app.dispose();
    }
  });
}
test("use-case demo is read-only and never calls an API", async ({ page }) => {
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "demo"),
  );
  await routeReadOnly(page, origin, app, {});
  try {
    await page.goto(`${origin}/use-cases`);
    await expect(
      page.getByRole("heading", { name: "Choose the next issue", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New use case", exact: true }),
    ).toBeDisabled();
    await page.locator("#use-case-list summary").click();
    await expect(page.locator("svg [data-graph-node]")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Edit", exact: true }),
    ).toBeDisabled();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
