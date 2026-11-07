import { fulfillFrom, routeReadOnly, openAccountMenuFor } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import type { WorkflowHostResult } from "@ai-outfitter/app-sdk/workflow-host";
import { expect, test, type Page } from "@playwright/test";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const origin = "https://wiki.outfitter.example";
const scope = {
  organizationId: "org",
  installationId: "wiki-map-installation",
  userId: "owner",
  packageHash: "hash",
  phase: "interactive" as const,
  expiresAt: Date.now() + 3_600_000,
};
/** An isolated Planning entities provider. Onto owns this contract fixture, so
 * browser tests do not require the private Planning source or a built package. */
function planningFixture() {
  type Project = { ref: { installationId: string; type: string; id: string }; revision: number; title: string; attributes: Record<string, unknown>; references: never[] };
  const projects = new Map<string, Project>();
  return {
    async call(path: string, _actor: typeof owner, options?: { method?: string; body?: Record<string, unknown> }) {
      const op = path.split("/").at(-1), input = options?.body ?? {};
      if (op === "types") return Response.json([{ type: "project", title: "Planning project", description: "A project", schema: {}, writable: true }]);
      if (op === "list") return Response.json([...projects.values()].slice(Number(input.offset ?? 0), Number(input.offset ?? 0) + Number(input.limit ?? 100)));
      if (op === "create") {
        const attributes = input.attributes as Record<string, unknown>;
        const project: Project = { ref: { installationId: "planning-installation", type: "project", id: crypto.randomUUID() }, revision: 1, title: String(attributes.name), attributes: { ...attributes }, references: [] };
        projects.set(project.ref.id, project);
        return Response.json(project);
      }
      if (op === "get" || op === "update") {
        const project = projects.get(String(input.id));
        if (!project) return new Response("Project not found", { status: 404 });
        if (op === "update") {
          if (input.revision !== project.revision) return new Response("Project changed", { status: 409 });
          project.attributes = { ...project.attributes, ...(input.attributes as Record<string, unknown>) };
          project.revision++;
        }
        return Response.json(project);
      }
      return new Response("Unsupported Planning operation", { status: 404 });
    },
    async dispose() {},
  };
}

async function operational(page: Page, planningAvailable = true) {
  const planning = planningFixture();
  const app = await appWorker(
    "wiki-map",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "wiki-map-installation",
    {
      workflowHost: () => {
        if (!planningAvailable) return { async call(): Promise<WorkflowHostResult> { return { ok: true, value: [] }; } };
        return {
        async call(operation, input): Promise<WorkflowHostResult> {
          const op = String(operation).slice("entities.".length);
          const data = input as { installationId?: string } & Record<
            string,
            unknown
          >;
          if (
            !String(operation).startsWith("entities.") ||
            (op !== "types" && data.installationId !== "planning-installation")
          )
            return { ok: false, status: 403, message: "Not allowed" };
          const { installationId: _installation, ...body } = data;
          const response = await planning.call(
            `/api/internal/entities/v1/${op}`,
            owner,
            op === "types" ? {} : { method: "POST", body },
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
              op === "types"
                ? (value as Record<string, unknown>[]).map((t) => ({
                    ...t,
                    installationId: "planning-installation",
                  }))
                : value,
          };
        },
      };
      },
    },
  );
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    await fulfillFrom(
      route,
      await app.call(url.pathname + url.search, owner, {
        method: request.method(),
        ...(request.postData() ? { body: request.postDataJSON() } : {}),
        workflowHost: scope,
      }),
    );
  });
  return {
    app,
    planning,
    async dispose() {
      await page.unrouteAll({ behavior: "wait" });
      await Promise.all([app.dispose(), planning.dispose()]);
    },
  };
}

test("create a canonical project, document a dependency, and read an agent update", async ({
  page,
}) => {
  const runtime = await operational(page);
  try {
    await page.goto(`${origin}/overview`);
    await page
      .getByRole("link", { name: "Create/link project", exact: true })
      .click();
    await page.getByLabel("Project name", { exact: true }).fill("Meze");
    await page
      .getByLabel("Documentation (Markdown)", { exact: true })
      .fill("## Outcome\n\nExplore health data.");
    await page
      .getByRole("button", { name: "Save project", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Meze", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Outcome", exact: true }),
    ).toBeVisible();
    const nodeId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;
    const projects = (await (
      await runtime.planning.call("/api/internal/entities/v1/list", owner, {
        method: "POST",
        body: { type: "project" },
      })
    ).json()) as { ref: { id: string }; revision: number }[];
    expect(projects).toHaveLength(1);
    const node = (await (
      await runtime.app.call("/api/internal/entities/v1/get", owner, {
        method: "POST",
        body: { type: "graph-node", id: nodeId },
      })
    ).json()) as {
      revision: number;
      references: { installationId: string; type: string; id: string }[];
    };
    expect(node.references[0].id).toBe(projects[0].ref.id);
    await page
      .getByRole("button", { name: "Add dependency", exact: true })
      .click();
    await page.getByLabel("Name", { exact: true }).fill("Apple Health");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Apple Health", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator("section")
        .filter({
          has: page.getByRole("heading", { name: "Dependencies", exact: true }),
        }),
    ).toContainText("proposed");
    const update = await runtime.planning.call(
      "/api/internal/entities/v1/update",
      owner,
      {
        method: "POST",
        body: {
          type: "project",
          id: projects[0].ref.id,
          revision: projects[0].revision,
          attributes: { goals: "Validate the health-data opportunity" },
        },
      },
    );
    expect(update.status).toBe(200);
    const context = await runtime.app.call(
      "/api/internal/entities/v1/update",
      owner,
      {
        method: "POST",
        body: {
          type: "graph-node",
          id: nodeId,
          revision: node.revision,
          attributes: {
            body: "## Agent progress\n\nDependency documented; implementation remains proposed.",
          },
          references: node.references,
        },
      },
    );
    expect(context.status).toBe(200);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Agent progress", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Link repository", exact: true }).click();
    await page.getByLabel("GitHub repository URL", { exact: true }).fill("https://github.com/example/monorepo");
    await page.getByLabel("Directory within repository (optional)", { exact: true }).fill("apps/meze");
    await page.getByRole("button", { name: "Save repository link", exact: true }).click();
    await expect(page.getByRole("link", { name: "Browse source", exact: true })).toHaveAttribute("href", "https://github.com/example/monorepo/tree/main/apps/meze");
    await expect(page).toHaveURL(new RegExp(`/projects/${nodeId}$`));
    await page.getByRole("link", { name: "Connections", exact: true }).click();
    await expect(page.locator(".graph-relations")).toContainText(
      "Apple Health",
    );
    if (process.env.WIKI_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.WIKI_SCREENSHOTS}/graph-desktop.png`,
        fullPage: true,
      });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".graph-viewport")).toBeHidden();
    await expect(page.locator(".graph-relations")).toBeVisible();
  } finally {
    await runtime.dispose();
  }
});

test("two same-named people remain separate and searchable", async ({
  page,
}) => {
  const runtime = await operational(page);
  try {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      await page.goto(`${origin}/overview`);
      await page.getByRole("link", { name: "Add person", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Shen");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Shen", exact: true }),
      ).toBeVisible();
      ids.push(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!);
    }
    expect(ids[0]).not.toBe(ids[1]);
    await page.goto(`${origin}/overview`);
    await page.getByRole("searchbox").fill("Shen");
    await expect(
      page.getByRole("link", { name: "Shen", exact: true }),
    ).toHaveCount(2);
  } finally {
    await runtime.dispose();
  }
});

test("preview includes standard context pages without operational API calls", async ({
  page,
}) => {
  const app = await appWorker(
    "wiki-map",
    appArtifact(new URL("..", import.meta.url), "demo"),
  );
  try {
    await routeReadOnly(page, origin, app);
    await page.goto(origin);
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.getByRole("heading", { name: "Outfitter", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Organization charter", exact: true })).toBeVisible();
    await page.locator("#sidebar").getByRole("link", { name: "Knowledge graphs", exact: true }).click();
    const contexts = page.getByRole("table");
    await expect(contexts.getByRole("columnheader", { name: "Instances", exact: true })).toBeVisible();
    for (const name of ["Role operating context", "Decision context", "Delivery context"])
      await expect(contexts.getByRole("rowheader", { name, exact: true }).getByRole("link", { name, exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Browse organizations", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/organizations`);
    await expect(page.getByLabel("Search organizations", { exact: true })).toBeVisible();
    await page.goto(`${origin}/overview`);
    await expect(page).toHaveURL(`${origin}/overview`);
    await expect(
      page.getByRole("heading", {
        name: "Projects and shared context",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Create/link project", exact: true }),
    ).toHaveCount(0);
    for (const name of ["Outfitter", "Unsupervised"])
      await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
    const types = page
      .locator("section")
      .filter({
        has: page.getByRole("heading", { name: "Types", exact: true }),
      });
    for (const name of [
      "Entities",
      "Projects",
      "People",
      "Organizations",
      "Technologies",
    ])
      await expect(
        types.getByRole("link", { name, exact: true }),
      ).toBeVisible();
    await page.goto(`${origin}/organizations/73000000-0000-4000-8000-000000000001`);
    const projects = page.locator("section").filter({ has: page.getByRole("heading", { name: "Projects", exact: true, level: 2 }) });
    await projects.getByRole("link", { name: "Software Foundry", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/projects/73000000-0000-4000-8000-000000000013`);
    await expect(page.getByRole("link", { name: "Browse source", exact: true })).toHaveAttribute("href", "https://github.com/ai-outfitter/apps/tree/main/apps/software-foundry");
    await page.goto(`${origin}/organizations`);
    await expect(page).toHaveURL(`${origin}/organizations`);
    await expect(page.getByLabel("Search organizations", { exact: true })).toBeVisible();
    await page.goto(`${origin}/overview`);
    await types.getByRole("link", { name: "Projects", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "For agents", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "All types", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Graph building blocks", exact: true }),
    ).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});

test("organization connects recent decisions, products, offerings and success measures", async ({ page }) => {
  const runtime = await operational(page);
  try {
    const org = "73000000-0000-4000-8000-000000000001";
    const create = async (type: string, attributes: Record<string, unknown>) => {
      const response = await runtime.app.call("/api/internal/entities/v1/create", owner, { method: "POST", body: { type, attributes } });
      expect(response.status).toBe(200);
      return (await response.json() as { ref: { id: string } }).ref.id;
    };
    const { core } = await import("../src/lib/graph");
    const person = await create("graph-node", { typeId: core.person, title: "Review Owner" });
    const assignment = await create("graph-node", { typeId: core.roleAssignment, title: "Review Owner — CEO" });
    const decision = await create("graph-node", { typeId: core.decisionRecord, title: "Set review growth goals", properties: { status: "decided" } });
    const ceo = "f1fa1826-8521-58cb-ba9d-60658e672a25";
    const goal = "dd14dec8-b7a6-5069-80f6-fe732e79607f";
    for (const [typeId, fromId, toId] of [
      [core.assignedTo, assignment, person], [core.assignsRole, assignment, ceo], [core.scopedTo, assignment, org],
      [core.madeBy, decision, person], [core.underAssignment, decision, assignment], [core.scopedTo, decision, org], [core.establishes, decision, goal],
    ]) await create("graph-edge", { typeId, fromId, toId });
    await page.goto(`${origin}/organizations/${org}`);
    const section = (name: string) => page.locator("section.graph-section").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(section("Recent decisions").getByRole("link", { name: "Set review growth goals", exact: true })).toBeVisible();
    await expect(section("Recent decisions")).toContainText("Review Owner");
    await expect(section("Recent decisions")).toContainText("Chief Executive Officer");
    for (const product of ["Outfitter inference service", "Outfitter resident agent service"])
      await expect(section("Products").getByRole("link", { name: product, exact: true })).toHaveCount(1);
    await expect(section("Offerings")).toContainText("Provider cost + markup (rate not specified)");
    await expect(section("Offerings")).toContainText("Role-based pricing");
    await expect(section("Goals")).toContainText("Monthly inference revenue");
    await section("Recent decisions").getByRole("link", { name: "Set review growth goals", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/decision-records/${decision}`);
    await expect(section("Goals established")).toContainText("10K monthly inference revenue");
    await expect(section("Acting under role assignment")).toContainText("Review Owner — CEO");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await runtime.dispose();
  }
});

for (const planningAvailable of [true, false]) {
test(`document an external project with Planning ${planningAvailable ? "installed" : "absent"}`, async ({ page }, testInfo) => {
  const runtime = await operational(page, planningAvailable);
  try {
    await page.goto(`${origin}/page?new=project`);
    await page.getByLabel("How would you like to start?").selectOption("standalone");
    await page.getByLabel("Project name", { exact: true }).fill("Example client recommendations");
    await page.getByLabel("Documentation (Markdown)").fill("## Client goal\n\nImprove recommendations.");
    await page.screenshot({ path: testInfo.outputPath("external-project-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Example client recommendations", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Client goal", exact: true })).toBeVisible();
    const nodeId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)!;
    const node = await (await runtime.app.call("/api/internal/entities/v1/get", owner, { method: "POST", body: { type: "graph-node", id: nodeId } })).json() as { references: unknown[] };
    expect(node.references).toEqual([]);
    const projects = await (await runtime.planning.call("/api/internal/entities/v1/list", owner, { method: "POST", body: { type: "project" } })).json();
    expect(projects).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/page?new=project`);
    await page.getByLabel("How would you like to start?").selectOption("standalone");
    await page.screenshot({ path: testInfo.outputPath("external-project-mobile.png"), fullPage: true });
  } finally {
    await runtime.dispose();
  }
});
}
test("graph explorer filters records and opens a direct neighborhood", async ({ page }) => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "demo"));
  try {
    await routeReadOnly(page, origin, app);
    await page.goto(`${origin}/graph`);
    await expect(page.getByRole("heading", { name: "Graph explorer" })).toBeVisible();
    const sidebar = page.locator("#wiki-sidebar-records");
    await expect(sidebar.getByText("Entities", { exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Meze", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Other project", exact: true })).toHaveCount(0);
    const projects = sidebar.getByRole("link", { name: "Projects", exact: true });
    await projects.click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true, level: 1 })).toBeVisible();
    await page.locator("#graph").getByRole("link", { name: "Meze", exact: true }).click();
    const meze = sidebar.getByRole("link", { name: "Meze", exact: true });
    await expect(meze).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Other project", exact: true })).toHaveCount(0);
    expect(await meze.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeLessThan(
      await projects.evaluate(element => parseFloat(getComputedStyle(element).fontSize)),
    );
    await page.locator("#graph").getByRole("link", { name: "Graph", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/knowledge-graphs$/);
    await expect(page.getByRole("heading", { name: "Meze", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("list", { name: "Knowledge graphs for Meze", exact: true }).getByRole("link", { name: "Project context", exact: true })).toBeVisible();
    const sharedContext = sidebar.getByRole("list", { name: "Knowledge graphs for Meze", exact: true }).getByRole("link", { name: "Delivery context", exact: true });
    await expect(sharedContext).toBeVisible();
    await sharedContext.click();
    await expect(page.getByRole("heading", { name: "Delivery context", exact: true })).toBeVisible();
    await expect(page.locator(".knowledge-graph-viewport svg a").first()).toBeVisible();
    await page.goto(`${origin}/graph`);
    // Laying out the whole demo Wiki (80+ records) takes about 2s locally and can pass 5s on CI runners.
    await expect(page.locator(".knowledge-graph-viewport svg a").first()).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Search", { exact: true }).fill("Meze");
    await expect(page.getByRole("status").first()).toContainText("1 entities");
    await page.getByLabel("Search", { exact: true }).clear();
    await page.getByLabel("Starting entity").selectOption({ label: "Meze" });
    const graphSelect = page.locator(".graph-explorer-filters label").last().locator("select");
    await expect(graphSelect).toBeEnabled();
    await graphSelect.selectOption({ label: "Project context" });
    await expect(page.getByRole("status").first()).toContainText("5 entities · 4 relationships");
    await expect(page.locator(".knowledge-graph-viewport svg a").filter({ hasText: "Apple" }).first()).toBeVisible();
    await expect(page.locator(".knowledge-graph-viewport svg a").first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setViewportSize({ width: 1440, height: 900 });
  } finally { await app.dispose(); }
});

test("Wiki links preserve the shell across graph, entity, and history navigation", async ({ page }, testInfo) => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "demo"));
  const documentLoads: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentLoads.push(request.url());
  });
  try {
    await routeReadOnly(page, origin, app);
    await page.goto(`${origin}/graph`);
    const rootLink = page.locator("#wiki-sidebar-records").getByRole("link", { name: "Meze", exact: true });
    await page.evaluate(() => Reflect.set(window, "wikiTestShell", { sidebar: document.getElementById("sidebar") }));
    await page.locator("#sidebar").getByRole("link", { name: "Projects", exact: true }).click();
    await page.locator("#graph").getByRole("link", { name: "Meze", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Meze", exact: true })).toBeVisible();
    await expect(rootLink).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(/\/projects\/[^/]+$/);
    const sidebarGraph = page.locator("#wiki-sidebar-records").getByRole("link", { name: "Project context", exact: true });
    await sidebarGraph.click();
    await expect(page.getByRole("heading", { name: "Project context", exact: true })).toBeVisible();
    await expect(sidebarGraph).toHaveAttribute("aria-current", "page");
    await expect(rootLink).toHaveAttribute("aria-current", "page");
    await page.locator(".knowledge-graph-viewport svg a").filter({ hasText: "Meze" }).first().click();
    await expect(page.getByRole("heading", { name: "Meze", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Connections", exact: true }).click();
    await expect(page).toHaveURL(/\/connections$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/projects\/[^/]+$/);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Project context", exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("heading", { name: "Meze", exact: true })).toBeVisible();
    await openAccountMenuFor(page, "Wiki settings");
    await page.locator("#sidebar").getByRole("link", { name: "Wiki settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Download graph and notes", exact: true })).toBeVisible();
    await page.locator("#sidebar").getByRole("link", { name: "Types", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Types", exact: true })).toBeVisible();
    await expect(rootLink).toHaveCount(0);
    await expect(sidebarGraph).toHaveCount(0);
    await page.locator("#sidebar").getByRole("link", { name: "Graph explorer", exact: true }).click();
    await expect(page.locator(".knowledge-graph-viewport svg a").first()).toBeVisible();
    expect(await page.evaluate(() => {
      const shell = Reflect.get(window, "wikiTestShell");
      return shell?.sidebar === document.getElementById("sidebar");
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("wiki-shell-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect(page.locator("#sidebar")).toHaveClass(/open/);
    await page.screenshot({ path: testInfo.outputPath("wiki-shell-mobile.png"), animations: "disabled" });
    await page.locator("#sidebar").getByRole("link", { name: "Types", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Types", exact: true })).toBeVisible();
    await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
    expect(documentLoads).toHaveLength(1);
  } finally { await app.dispose(); }
});
