import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { expect, test, type Page } from "@playwright/test";
import { core, type Graph } from "../src/lib/graph";

const origin = "https://wiki.outfitter.example";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const secondId = "74000000-0000-4000-8000-000000000099";
async function setup(page: Page, invalid: boolean, mount = "") {
  const app = await appWorker(
    "wiki-map",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  const snapshot = await app.call("/api/apps/wiki-map/graph/snapshot", owner);
  const graph = (await snapshot.json()) as Graph;
  const anchor = graph.nodes.find((node) => node.typeId === core.offering)!;
  const lens = graph.nodes.find((node) => node.typeId === core.knowledgeGraph)!;
  // Keep this navigation fixture explicitly in the legacy property format;
  // standard JSON declaration ordering and body formats may evolve independently.
  lens.body = "";
  lens.properties = { root_type: "Offering", pattern: JSON.stringify({relationships:["offered_by"],max_depth:4}) };
  const second = structuredClone(lens);
  second.id = secondId;
  second.title = "Another lens";
  graph.nodes.push(second);
  if (invalid) {
    second.properties.root_type = "Product";
    graph.edges.push({
      ...graph.edges[0],
      id: "74000000-0000-4000-8000-000000000098",
      typeId: core.lensFor,
      fromId: second.id,
      toId: anchor.id,
    });
    lens.properties.pattern = JSON.stringify({
      relationships: ["missing_relationship"],
      max_depth: 4,
    });
    graph.canEdit = false;
  }
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/graph/snapshot")) {
      await route.fulfill({ json: graph });
      return;
    }
    await fulfillFrom(
      route,
      await app.call((mount && url.pathname.startsWith(`${mount}/`) ? url.pathname.slice(mount.length) : url.pathname) + url.search, owner, {
        method: request.method(),
        ...(request.postData() ? { body: request.postDataJSON() } : {}),
      }),
    );
  });
  return { app, anchor, lens };
}

test("invalid lenses report errors and graph links preserve browser history", async ({ page }) => {
  const { app, anchor, lens } = await setup(page, true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const entity = `${origin}/offerings/${anchor.id}`;
  const first = `${entity}/knowledge-graphs/${lens.id}`;
  const second = `${entity}/knowledge-graphs/${secondId}`;
  try {
    // Existing query bookmarks arrive at the new graph directory.
    await page.goto(`${entity}?tab=graphs`);
    await expect(page).toHaveURL(`${entity}/knowledge-graphs`);
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await page.getByRole("navigation", { name: "Knowledge graphs", exact: true }).getByRole("link", { name: lens.title, exact: true }).click();
    await expect(page).toHaveURL(first);
    await expect(page.getByRole("alert")).toContainText("missing_relationship");
    await page.locator("#graph").getByRole("link", { name: "Another lens", exact: true }).click();
    await expect(page).toHaveURL(second);
    await expect(page.locator("svg [data-graph-node]").first()).toBeVisible();
    expect(await page.locator("svg [data-graph-node]").count()).toBeGreaterThan(1);
    await page.reload();
    await expect(page.locator("svg [data-graph-node]").first()).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(first);
    await expect(page.getByRole("alert")).toContainText("missing_relationship");
    await page.goForward();
    await expect(page).toHaveURL(second);
    await expect(page.locator("#graph").getByRole("link", { name: "Another lens", exact: true })).toHaveAttribute("aria-current", "page");
    await page.goBack();
    await page.getByRole("link", { name: "Open graph definition" }).click();
    await expect(page.getByRole("alert")).toContainText("missing_relationship");
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});

test("knowledge graphs lead with their instances, and an instance opens its graph", async ({ page }) => {
  const { app, lens } = await setup(page, false);
  try {
    await page.goto(`${origin}/contexts`);
    const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: lens.title, exact: true }) });
    const instance = row.getByRole("cell").getByRole("link").first();
    await expect(instance).toHaveAttribute("href", new RegExp(`/knowledge-graphs/${lens.id}$`));
    await row.getByRole("rowheader").getByRole("link", { name: lens.title, exact: true }).click();
    await expect(page).toHaveURL(`${origin}/knowledge-graphs/${lens.id}`);
    await expect(page.getByText("How this graph is built", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Traversal" })).toBeHidden();
    // The definition's own graph view lists the same instances instead of an empty state.
    await page.goto(`${origin}/knowledge-graphs/${lens.id}/knowledge-graphs`);
    await page.locator(".knowledge-graph-instances a").first().click();
    await expect(page).toHaveURL(new RegExp(`/knowledge-graphs/${lens.id}$`));
    await expect(page.locator("svg [data-graph-node]").first()).toBeVisible();
    expect(await page.locator("svg [data-graph-node]").count()).toBeGreaterThan(1);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});

test("graph routes keep view navigation and a usable mobile layout", async ({ page }) => {
  const { app, anchor, lens } = await setup(page, false);
  const entity = `${origin}/offerings/${anchor.id}`;
  try {
    await page.goto(`${entity}/knowledge-graphs/${lens.id}`);
    await expect(page.locator("svg [data-graph-node]").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /attach/i })).toHaveCount(0);
    await expect(page.locator(".graph-section .graph-section")).toHaveCount(0);
    await expect(page.locator(".graph-section .knowledge-graph-stage")).toHaveCount(0);
    await expect(page.locator(".knowledge-graph-page")).toHaveCSS("border-top-width", "0px");
    await expect(page.locator(".knowledge-graph-detail")).toHaveCSS("border-top-width", "0px");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("svg [data-graph-node]").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("navigation", { name: "Entity views" }).getByRole("link", { name: "Connections", exact: true }).click();
    await expect(page).toHaveURL(`${entity}/connections`);
    await expect(page.getByRole("heading", { name: "Immediate connections" })).toBeVisible();
    await page.getByRole("navigation", { name: "Entity views" }).getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page).toHaveURL(entity);
    await page.goBack();
    await expect(page).toHaveURL(`${entity}/connections`);
    await page.goto(`${entity}/knowledge-graphs/missing`);
    await expect(page.getByRole("alert")).toHaveText("This knowledge graph is not available for this entity.");
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});

for (const mount of ["/o/unsupervised/wiki-map", "/apps/wiki-installation"]) {
  test(`graph links stay within the ${mount} installation`, async ({ page }) => {
    const { app, anchor, lens } = await setup(page, false, mount);
    const entity = `${origin}${mount}/offerings/${anchor.id}`;
    try {
      await page.goto(`${entity}/knowledge-graphs/${lens.id}`);
      await expect(page.locator("svg [data-graph-node]").first()).toBeVisible();
      await expect(page.getByRole("link", { name: "Open graph definition" })).toHaveAttribute("href", new RegExp(`^${mount}/knowledge-graphs/`));
      await page.locator("#graph").getByRole("link", { name: "Another lens", exact: true }).click();
      await expect(page).toHaveURL(`${entity}/knowledge-graphs/${secondId}`);
      await page.getByRole("navigation", { name: "Entity views" }).getByRole("link", { name: "Overview", exact: true }).click();
      await expect(page).toHaveURL(entity);
      await page.goBack();
      await expect(page).toHaveURL(`${entity}/knowledge-graphs/${secondId}`);
      await expect(page.locator("svg [data-graph-node]").first()).toBeVisible();
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await app.dispose();
    }
  });
}

test("an older graph is adjusted only into a new copy", async ({ page }) => {
  const { app, anchor, lens } = await setup(page, false);
  try {
    await page.goto(`${origin}/offerings/${anchor.id}/knowledge-graphs/${lens.id}`);
    await page.getByRole("link", { name: "Adjust this graph" }).click();
    await expect(page.getByText("Save as new")).toBeVisible();
    await expect(page.getByRole("button", { name: `Update ${lens.title}` })).toHaveCount(0);
    await page.waitForLoadState("networkidle");
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});

test("a saved graph is reshaped with page controls and updated in place", async ({ page }) => {
  const { app, anchor, lens } = await setup(page, false);
  // Only a graph stored as a JSON definition can be updated in place.
  const stored = {
    name: "Offering context",
    purpose: "What an offering depends on.",
    rootTypes: ["Offering", "Product"],
    selection: { relationships: JSON.parse(String(lens.properties.pattern)).relationships, maxDepth: 2, maxNodes: 100 },
  };
  lens.body = JSON.stringify(stored);
  const entity = `${origin}/offerings/${anchor.id}`;
  const updates: { id: string; attributes: { body: string } }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/graph/update")) updates.push(request.postDataJSON());
  });
  try {
    await page.goto(`${entity}/knowledge-graphs/${lens.id}`);
    // Each control opens a new address; let a page finish loading before the next change.
    const settled = () => page.waitForLoadState("networkidle");
    await settled();
    await page.getByRole("link", { name: "Adjust this graph" }).click();
    await expect(page).toHaveURL(new RegExp(`graph=${lens.id}`));
    await settled();
    const controls = page.getByRole("group", { name: "Shape this graph" });
    await expect(controls.locator(".knowledge-graph-chip").first()).toBeVisible();
    await controls.getByRole("combobox", { name: "Stop at type" }).selectOption("Product");
    await expect(page).toHaveURL(/stop=Product/);
    await expect(controls.getByText("stop at Product")).toBeVisible();
    await settled();
    await page.getByLabel("Depth").fill("3");
    await page.getByLabel("Depth").dispatchEvent("change");
    await expect(page).toHaveURL(/depth=3/);
    await expect(page).toHaveURL(/stop=Product/);
    await settled();
    await page.getByRole("button", { name: `Update ${lens.title}` }).click();
    await expect(page).toHaveURL(`${entity}/knowledge-graphs/${lens.id}`);
    await settled();
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(lens.id);
    const saved = JSON.parse(updates[0].attributes.body);
    expect(saved.selection.stopAtTypes).toEqual(["Product"]);
    expect([saved.name, saved.purpose, saved.rootTypes]).toEqual([stored.name, stored.purpose, stored.rootTypes]);
    expect(saved.selection.maxDepth).toBe(3);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
