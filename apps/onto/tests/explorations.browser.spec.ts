import { fulfillFrom, routeReadOnly } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, type Page, test } from "@playwright/test";

const origin = "https://wiki.outfitter.example";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const actions = "/api/internal/actions/v1/call";
const shots = process.env.EXPLORATION_SCREENSHOTS;
// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;

async function setup(page: Page) {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"));
  await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} });
  const action = async (name: string, input: object) => (await app.call(actions, owner, { method: "POST", body: { action: name, input } })).json() as Promise<Json>;
  const { types } = await action("graph.read", {});
  const type = (name: string) => types.find((row: Json) => row.name === name)?.id as string;
  const node = (ref: string, typeName: string, title: string, slug: string) => ({ operation: "create", ref, type: "graph-node", attributes: { typeId: type(typeName), title, slug } });
  const edge = (ref: string, typeName: string, fromId: string, toId: string) => ({ operation: "create", ref, type: "graph-edge", attributes: { typeId: type(typeName), fromId, toId } });
  await action("graph.apply", { requestKey: "explore-browser", operations: [
    node("$sunny", "Organization", "Sunny", "sunny"),
    node("$kit", "Offering", "Sunny home kit", "sunny-home-kit"),
    node("$pro", "Offering", "Sunny pro", "sunny-pro"),
    node("$sensor", "Product", "SNY-1 sensor", "sny-1"),
    node("$firmware", "Project", "SNY-1 firmware", "sny-1-firmware"),
    node("$case", "Project", "SNY-1 enclosure", "sny-1-enclosure"),
    node("$rival", "Organization", "Ecowitt", "ecowitt"),
    node("$rival-sensor", "Product", "Ecowitt soil sensor", "ecowitt-soil"),
    edge("$e1", "offered_by", "$kit", "$sunny"),
    edge("$e2", "offered_by", "$pro", "$sunny"),
    edge("$e3", "packages_product", "$kit", "$sensor"),
    edge("$e4", "produces", "$firmware", "$sensor"),
    edge("$e5", "produces", "$case", "$sensor"),
    edge("$e6", "alternative_for", "$rival-sensor", "$kit"),
    edge("$e7", "developed_by", "$rival-sensor", "$rival"),
  ] });
  // An agent's change goes through the same document over graph.mutate.
  const agent = async (input: object) => action("graph.mutate", {
    query: "mutation M($input: MutateExplorationInput!) { mutateExploration(input: $input) { revision } }", variables: { input },
  });
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    await fulfillFrom(route, await app.call(url.pathname + url.search, owner, {
      method: request.method(), ...(request.postData() ? { body: request.postDataJSON() } : {}),
    }));
  });
  // An agent proposing a record stages it in a change batch; it is not written.
  const stage = async (proposals: object[]) => action("graph.mutate", {
    query: "mutation S($input: StageChangesInput!) { stageChanges(input: $input) { id } }", variables: { input: { title: "Competitors", proposals } },
  });
  // The sidebar announces each finished reply; the page reads the exploration again.
  const replied = () => page.evaluate(() => dispatchEvent(new Event("outfitter:agent-replied:wiki-map")));
  return { app, agent, stage, type, replied };
}

test("a member and an agent change one exploration, and the page shows the agent's change", async ({ page }) => {
  const { app, agent, stage, type, replied } = await setup(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/graph`);
    await page.getByLabel("Start from").selectOption({ label: "Sunny · Organization" });
    await page.getByRole("button", { name: "Explore" }).click();
    await expect(page).toHaveURL(/\/explore\/sunny-/);
    const slug = page.url().split("/explore/")[1];
    await expect(page.getByRole("heading", { level: 1, name: "Sunny" })).toBeVisible();
    // The member opens offerings from the organization.
    await page.getByRole("navigation", { name: "Explore from Sunny" }).getByRole("button", { name: "Offerings" }).click();
    await expect(page.locator("svg [data-graph-node]")).toHaveCount(3);
    await expect(page.getByRole("status").first()).toContainText("Opened offerings from Sunny");

    // It opens projects and competitors from every offering; the page picks it up when its reply ends.
    await agent({ slug, expectedRevision: 2, summary: "Opened projects and competitors", patch: { steps: {
      projects: { from: "*offerings", path: "projects" }, competitors: { from: "*offerings", path: "competitors" },
    } } });
    await expect(page.locator("svg [data-graph-node]")).toHaveCount(3);
    await replied();
    await expect(page.locator("svg [data-graph-node]")).toHaveCount(8);
    await expect(page.getByText("Opened projects and competitors")).toBeVisible();
    await expect(page.locator("svg .kg-node-highlight")).toHaveCount(5);
    if (shots) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: "Fit graph" }).click();
      await page.evaluate(() => { for (const element of document.querySelectorAll("*")) element.scrollTop = 0; });
      await page.screenshot({ path: `${shots}/exploration-agent-desktop.png` });
    }

    // Selecting a node offers what can be opened from it; hiding it updates the view.
    await page.locator("svg [data-graph-node]", { hasText: "Sunny pro" }).click();
    await page.getByRole("navigation", { name: "Explore from Sunny pro" }).getByRole("button", { name: "Hide" }).click();
    await expect(page.locator("svg [data-graph-node]")).toHaveCount(7);
    // A competitor the agent stages appears dashed, without anyone changing the exploration.
    const kit = (await (await app.call(`/api/apps/wiki-map/explorations/get?slug=${slug}`, owner)).json() as Json).picture.nodes.find((n: Json) => n.key === "Offering:sunny-home-kit");
    await stage([
      { operation: { operation: "create", ref: "$rival", type: "graph-node", attributes: { typeId: type("Product"), title: "Rachio soil probe" } } },
      { operation: { operation: "create", ref: "$alt", type: "graph-edge", attributes: { typeId: type("alternative_for"), fromId: "$rival", toId: kit.id } } },
    ]);
    await replied();
    await expect(page.locator("svg .kg-node-proposed")).toHaveCount(1);
    await page.locator("svg [data-graph-node]", { hasText: "Rachio soil probe" }).click();
    await expect(page.getByRole("link", { name: "Review the change batch" })).toBeVisible();
    if (shots) {
      await page.evaluate(() => { for (const element of document.querySelectorAll("*")) element.scrollTop = 0; });
      await page.screenshot({ path: `${shots}/exploration-proposed-desktop.png`, fullPage: false });
    }
    await page.getByText("Steps").click();
    await expect(page.getByText("Hidden: sunny-pro")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    if (shots) {
      await page.evaluate(() => { for (const element of document.querySelectorAll("*")) element.scrollTop = 0; });
      await page.screenshot({ path: `${shots}/exploration-mobile.png` });
      await page.goto(`${origin}/graph`);
      await expect(page.getByRole("link", { name: "Sunny" })).toBeVisible();
      await page.screenshot({ path: `${shots}/explorations-list-mobile.png` });
    }
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});

test("the read-only demo opens a synthetic exploration with live-looking pull requests and a proposed competitor", async ({ page }) => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "demo"));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await routeReadOnly(page, origin, app);
    await page.goto(`${origin}/graph`);
    await page.getByRole("link", { name: "Fernway offerings" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Fernway offerings" })).toBeVisible();
    // Fernway, 2 offerings, the product, 2 projects, a repository, 2 pull requests, a competitor, its company and a proposed one.
    await expect(page.locator("svg [data-graph-node]")).toHaveCount(12, { timeout: 15_000 });
    await expect(page.locator("svg .kg-node-proposed")).toHaveCount(1);
    if (shots) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: "Fit graph" }).click();
      await page.evaluate(() => { for (const element of document.querySelectorAll("*")) element.scrollTop = 0; });
      await page.screenshot({ path: `${shots}/onto-demo-exploration-desktop.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => { for (const element of document.querySelectorAll("*")) element.scrollTop = 0; });
      await page.screenshot({ path: `${shots}/onto-demo-exploration-mobile.png` });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    // A visitor's click changes this page's copy only.
    await page.locator("svg [data-graph-node]", { hasText: "Fernway for growers" }).click();
    await page.getByRole("navigation", { name: "Explore from Fernway for growers" }).getByRole("button", { name: "Hide" }).click();
    // Hiding it also drops the proposal staged against it.
    await expect(page.locator("svg [data-graph-node]")).toHaveCount(10);
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
