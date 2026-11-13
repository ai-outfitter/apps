import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { expect, test, type Page } from "@playwright/test";
import { type TypeDefinition, type Graph } from "../src/lib/graph";

const origin = "https://wiki.outfitter.example";
const stamp = { revision: 1, createdBy: "test", updatedBy: "test", createdAt: 0, updatedAt: 0 };
const graph: Graph = {
  canEdit: false,
  home: { organizationId: "73000000-0000-4000-8000-000000000001" },
  types: [{
    id: "71000000-0000-4000-8000-000000000013",
    name: "Entity",
    title: "Entities",
    category: "node",
    body: "## Entities\\n\\n- **Reusable** guidance in Markdown.",
    properties: [],
    archived: false,
    ...stamp,
    seedVersion: 1,
  } as TypeDefinition],
  nodes: [],
  edges: [],
};
async function setup(page: Page) {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"));
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/graph/snapshot")) {
      await route.fulfill({ json: graph });
      return;
    }
    await fulfillFrom(route, await app.call(url.pathname + url.search, { userId: "owner", organizationId: "org", role: "owner" }, {
      method: request.method(),
      ...(request.postData() ? { body: request.postDataJSON() } : {}),
    }));
  });
  return app;
}

test("settings type administration links to concise guides without raw Markdown at desktop and mobile widths", async ({ page }) => {
  const app = await setup(page);
  try {
    await page.goto(`${origin}/settings`);
    const administration = page.locator("#type-administration");
    const entities = administration.getByText("Entities", { exact: true });
    await expect(entities).toBeVisible();
    await expect(administration.getByText(/##|\*\*|^- /m)).toHaveCount(0);
    await expect(administration.getByRole("link", { name: "Read type guide" }).first()).toHaveAttribute("href", /\/types\//);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
