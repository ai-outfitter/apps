import { expect, signIn, story } from "./evidence";

// Workshop Alpha's value story: from a sentence to a CAD model and its handoff,
// run against Workshop standalone. Design turns go to whatever model endpoint the
// running app is configured with (INFERENCE_BASE_URL).
const step = {
  start: "workshop-alpha-value-step-1",
  design: "workshop-alpha-value-step-2",
  revise: "workshop-alpha-value-step-3",
  handoff: "workshop-alpha-value-step-4",
} as const;

story(
  {
    slug: "workshop-alpha-value-story",
    title: "Describe a part, get a CAD model, revise it and hand it off",
    actor: "member",
    criteria: {
      [step.start]: "1. Signs in and finds their projects",
      [step.design]: "2. Describes a part and gets a CAD model",
      [step.revise]: "3. Revises the model with a follow-up",
      [step.handoff]: "4. Sees parts, cost and the handoff package",
    },
  },
  async ({ page, evidence }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await evidence.capture(page, { criterion: step.start, route: "/login", state: "sign-in" });
    await signIn(page);
    await expect(page.getByLabel("What should we make?")).toBeVisible();
    await evidence.capture(page, { criterion: step.start, route: "/" });

    await page.getByLabel("What should we make?").fill("A desk status button enclosure, 80 mm square, with a big round button on top");
    await page.getByRole("button", { name: "Create model" }).click();
    await expect(page.locator("#agent-status")).toContainText("Saved revision 1", { timeout: 120_000 });
    await expect(page.locator("#geometry-status")).toContainText("geometry ready", { timeout: 60_000 });
    await evidence.capture(page, { criterion: step.design, state: "model-created" });
    await page.getByLabel("What should we make or change?").fill("Make it 90 mm square");
    await page.getByRole("button", { name: "Update model" }).click();
    await expect(page.locator("#agent-status")).toContainText("Saved revision 2", { timeout: 120_000 });
    await expect(page.locator("#agent-history li")).toHaveCount(2);
    await expect(page.locator("#geometry-status")).toContainText("geometry ready", { timeout: 60_000 });
    await evidence.capture(page, { criterion: step.revise, state: "revision-2" });
    const project = new URL(page.url()).pathname.match(/^\/projects\/[^/]+/)?.[0];
    expect(project).toBeTruthy();
    await page.goto(`${project}/design`);
    await expect(page.locator("main h1").first()).toBeVisible();
    await evidence.capture(page, { criterion: step.revise, route: `${project}/design` });

    for (const section of ["parts", "release"]) {
      await page.goto(`${project}/${section}`);
      await expect(page.locator("main h1").first()).toBeVisible();
      await evidence.capture(page, { criterion: step.handoff, route: `${project}/${section}` });
    }
    evidence.limitation("Captured against Workshop running standalone under astro dev with a local database, not a production installation.");
    evidence.limitation("Design answers came from the model endpoint the capture was configured with; the bundle's receipt names it.");
  },
);
