import { expect, signIn, story } from "./evidence";

// Onto Alpha's value story: keep an organization's shared context as a graph
// people and agents read, run against Onto standalone.
const step = {
  start: "onto-alpha-value-step-1",
  add: "onto-alpha-value-step-2",
  explore: "onto-alpha-value-step-3",
  contexts: "onto-alpha-value-step-4",
} as const;

story(
  {
    slug: "onto-alpha-value-story",
    title: "Record shared context and explore it as a knowledge graph",
    actor: "member",
    criteria: {
      [step.start]: "1. Signs in and sees the organization's shared context",
      [step.add]: "2. Adds a product with its documentation",
      [step.explore]: "3. Explores it in the graph explorer",
      [step.contexts]: "4. Reads the knowledge graphs and types agents use",
    },
  },
  async ({ page, evidence }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await evidence.capture(page, { criterion: step.start, route: "/login", state: "sign-in" });
    await signIn(page);
    await expect(page.locator("main h1").first()).toBeVisible();
    await evidence.capture(page, { criterion: step.start, route: "/" });
    await page.goto("/overview");
    await expect(page.getByText("Add product").first()).toBeVisible();
    await evidence.capture(page, { criterion: step.start, route: "/overview" });

    await page.getByText("Add product").first().click();
    await page.getByLabel("Name").fill("Field sensor node");
    await page.getByLabel("Documentation (Markdown)").fill("A solar-powered soil moisture and temperature node for small farms.\n\n- LoRa uplink\n- Two-year battery life");
    await evidence.capture(page, { criterion: step.add, state: "form-filled" });
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Field sensor node").first()).toBeVisible();
    await evidence.capture(page, { criterion: step.add, state: "saved" });

    await page.goto("/graph");
    await expect(page.locator("main h1").first()).toContainText("Graph explorer");
    await evidence.capture(page, { criterion: step.explore, route: "/graph" });

    for (const route of ["/contexts", "/types"]) {
      await page.goto(route);
      await expect(page.locator("main h1").first()).toBeVisible();
      await evidence.capture(page, { criterion: step.contexts, route });
    }
    evidence.limitation("Captured against Onto running standalone under astro dev with a local database and its standard data, not a production installation.");
  },
);
