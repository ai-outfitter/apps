import { wikiGraphFixture } from "@ai-outfitter/app-test/wiki-fixture";
import { expect, test, type Page } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";

const origin = "https://planning.alpha.localhost";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const uuid = (n: number) =>
  `94000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (
  n: number,
  type: string,
  attributes: EntityRecord["attributes"],
  references: EntityRecord["references"] = [],
): EntityRecord => ({
  ref: { installationId: "wiki", type, id: uuid(n) },
  title: String(attributes.title ?? attributes.name),
  revision: 1,
  attributes,
  references,
});
function matchesProvider(provider: { template?: string; installationId: string }, raw: unknown) {
  const selector = (raw ?? {}) as { template?: string; installationId?: string };
  return (!selector.template || provider.template === selector.template) &&
    (!selector.installationId || provider.installationId === selector.installationId);
}
async function fixture(
  page: Page,
  mode: "products" | "empty" | "failure" | "anonymous" | "unauthorized" | "forbidden" = "products",
) {
  const names = [
    "Organization",
    "KnowledgeGraph",
    "Product",
    "Offering",
    "Project",
    "developed_by",
    "offered_by",
    "packages_product",
    "part_of",
  ];
  const types = names.map((name, i) =>
    row(100 + i, "graph-type", { name, category: i < 5 ? "node" : "edge" }),
  );
  const type = (name: string) =>
    types.find((t) => t.attributes.name === name)!.ref.id;
  const nodes = [
    row(1, "graph-node", {
      typeId: type("Organization"),
      title: "Outfitter",
      properties: { organization_id: "org" },
    }),
    row(2, "graph-node", {
      typeId: type("KnowledgeGraph"),
      title: "Organization overview",
      slug: "organization-overview",
      properties: {
        root_type: "Organization",
        pattern: JSON.stringify({
          max_depth: 3,
          relationships: [
            {
              type: "developed_by",
              direction: "incoming",
              from_type: "Product",
              to_type: "Organization",
            },
            {
              type: "offered_by",
              direction: "incoming",
              from_type: "Offering",
              to_type: "Organization",
            },
            {
              type: "packages_product",
              direction: "outgoing",
              from_type: "Offering",
              to_type: "Product",
            },
            {
              type: "part_of",
              direction: "incoming",
              from_type: "Project",
              to_type: "Product",
            },
          ],
        }),
      },
    }),
  ];
  const edges: EntityRecord[] = [];
  const requests: string[] = [];
  const calls: string[] = [];
  const discoveryInputs: unknown[] = [];
  const listInputs: { type: string; filter?: Record<string, unknown> }[] = [];
  const canonicalProjects: EntityRecord[] = [];
  const recordsFor = (type: string) =>
    (
      ({
        "graph-type": types,
        "graph-node": nodes,
        "graph-edge": edges,
        project: canonicalProjects,
      }) as Record<string, EntityRecord[]>
    )[type] ?? [];
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "planning-home-ssr",
    {
      workflowHost: (scope) => ({
        async call(operation, raw) {
          expect(scope.organizationId).toBe("org");
          expect(scope.installationId).toBe("planning-home-ssr");
          calls.push(operation);
          const failure = fixtureFailure(mode);
          if (failure) return failure;
          if (operation === "entities.types") {
            discoveryInputs.push(raw);
            return {
              ok: true,
              value: [
                ...["graph-type", "graph-node", "graph-edge"].map(
                  (type, i) => ({
                    installationId: "wiki",
                    type,
                    template: "onto",
                    slug: "onto",
                    collection: ["types", "nodes", "edges"][i],
                    title: type,
                    description: "fixture",
                    schema: {},
                    writable: true,
                  }),
                ),
                {
                  installationId: "planning-home-ssr",
                  type: "project",
                  template: "planning",
                  collection: "projects",
                  title: "Projects",
                  description: "fixture",
                  schema: {},
                  writable: true,
                },
              ].filter((provider) => matchesProvider(provider, raw)),
            };
          }
          if (operation === "actions.call") return { ok: true, value: wikiGraphFixture("wiki", { types, nodes, edges }) };
          if (operation === "entities.get") {
            const input = raw as { type: string; id: string };
            const record = recordsFor(input.type).find(
              (record) => record.ref.id === input.id,
            );
            return fixtureRecordResult(record);
          }
          if (operation === "entities.list") {
            const input = raw as {
              type: string;
              filter?: Record<string, unknown>;
              offset?: number;
              limit?: number;
            };
            listInputs.push(input);
            return { ok: true, value: fixturePage(recordsFor(input.type), input) };
          }
          throw new Error(`Unexpected read operation: ${operation}`);
        },
      }),
    },
  );
  if (mode === "products") {
    const created = await app.call("/api/apps/planning/projects", owner, {
      method: "POST",
      body: { name: "Launch", goals: "Ship planning" },
    });
    expect(created.status).toBe(200);
    const project = (await created.json()) as { id: string };
    canonicalProjects.push({
      ref: {
        installationId: app.installationId,
        type: "project",
        id: project.id,
      },
      title: "Launch",
      revision: 1,
      attributes: { name: "Launch", goals: "Ship planning" },
      references: [],
    });
    for (let i = 0; i < 8; i++) {
      nodes.push(
        row(10 + i, "graph-node", {
          typeId: type("Product"),
          title: i ? `Product ${i + 1}` : "Team planning",
          summary: "Product description",
        }),
      );
      edges.push(
        row(200 + i, "graph-edge", {
          typeId: type("developed_by"),
          fromId: uuid(10 + i),
          toId: uuid(1),
        }),
      );
    }
    nodes.push(
      row(30, "graph-node", { typeId: type("Offering"), title: "Team plan" }),
      row(31, "graph-node", { typeId: type("Project"), title: "Launch" }, [
        { installationId: app.installationId, type: "project", id: project.id },
      ]),
      row(32, "graph-node", {
        typeId: type("Project"),
        title: "Wiki-only project",
      }),
      row(40, "graph-node", {
        typeId: type("Organization"),
        title: "Other company",
        properties: { organization_id: "other-org" },
      }),
      row(41, "graph-node", {
        typeId: type("Product"),
        title: "Other company product",
      }),
    );
    for (const [n, relation, from, to] of [
      [220, "offered_by", 30, 1],
      [221, "packages_product", 30, 10],
      [222, "part_of", 31, 10],
      [223, "part_of", 32, 10],
      [224, "developed_by", 41, 40],
    ] as const)
      edges.push(
        row(n, "graph-edge", {
          typeId: type(relation),
          fromId: uuid(from),
          toId: uuid(to),
        }),
      );
    await page.route(`${origin}/**`, async (route) => {
      if (await fulfillPlatformIdentity(route)) return;
      const request = route.request();
      if (new URL(request.url()).pathname.startsWith("/api/"))
        requests.push(request.url());
      await fulfillFrom(
        route,
        await app.dispatch(
          "",
          new Request(request.url(), {
            method: request.method(),
            headers: {
              ...request.headers(),
              "x-outfitter-user": "owner",
              "x-outfitter-organization": "org",
              "x-outfitter-installation": app.installationId,
              "x-outfitter-role": "owner",
            },
            body: request.postData() ?? undefined,
          }),
          {
            workflowHost: {
              ...owner,
              installationId: app.installationId,
              packageHash: "fixture",
              phase: "interactive",
              expiresAt: Date.now() + 3600000,
            },
          },
        ),
      );
    });
    return { app, calls, discoveryInputs, listInputs, requests, projectId: project.id };
  }
  await page.route(`${origin}/**`, async (route) => {
    if (await fulfillPlatformIdentity(route)) return;
    const request = route.request();
    if (new URL(request.url()).pathname.startsWith("/api/"))
      requests.push(request.url());
    await fulfillFrom(
      route,
      await app.dispatch(
        "",
        new Request(request.url(), {
          method: request.method(),
          headers:
            mode === "anonymous"
              ? request.headers()
              : {
                  ...request.headers(),
                  "x-outfitter-user": "owner",
                  "x-outfitter-organization": "org",
                  "x-outfitter-installation": app.installationId,
                  "x-outfitter-role": "owner",
                },
          body: request.postData() ?? undefined,
        }),
        {
          workflowHost: {
            ...owner,
            installationId: app.installationId,
            packageHash: "fixture",
            phase: "interactive",
            expiresAt: Date.now() + 3600000,
          },
        },
      ),
    );
  });
  return { app, calls, discoveryInputs, listInputs, requests, projectId: "" };
}

for (const width of [1440, 390])
  test(`Product HTML renders all groups and scoped links without JavaScript at ${width}px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width, height: 1000 },
    });
    const page = await context.newPage();
    const { app, discoveryInputs, listInputs, requests, projectId } = await fixture(page);
    try {
      const response = await page.goto(origin);
      expect(response?.status()).toBe(200);
      await expect(page.locator(".planning-product-section")).toHaveCount(8);
      await expect(
        page.getByRole("heading", { name: "Product 8", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Team planning", exact: true }),
      ).toHaveAttribute("href", `/apps/onto/products/${uuid(10)}`);
      await expect(
        page.getByRole("link", { name: "Team plan", exact: true }),
      ).toHaveAttribute("href", `/apps/onto/offerings/${uuid(30)}`);
      const projects = page.getByRole("table", {
        name: "Projects for Team planning",
      });
      await expect(projects.getByRole("columnheader")).toHaveCount(1);
      await expect(
        projects.getByRole("link", { name: "Launch", exact: true }),
      ).toHaveAttribute("href", `./projects/${projectId}`);
      await expect(
        projects.getByRole("link", { name: "Wiki-only project", exact: true }),
      ).toHaveAttribute("href", `/apps/onto/projects/${uuid(32)}`);
      await expect(page.getByText("No projects linked yet.")).toHaveCount(7);
      await expect(
        page.getByText("Other company product", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText(/Ready to plan|Ready to implement|Needs planning/),
      ).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`product-${width}.png`), fullPage: true });
      expect(requests).toEqual([]);
      expect(discoveryInputs).toEqual([
        { template: "onto", requireTypes: true },
        { template: "wiki-map" },
        { installationId: "planning-home-ssr" },
      ]);
      expect(
        listInputs.filter((input) =>
          ["graph-node", "graph-edge"].includes(input.type),
        ).length,
      ).toBeGreaterThan(0);
      for (const input of listInputs.filter((input) =>
        ["graph-node", "graph-edge"].includes(input.type),
      ))
        expect(
          Object.keys(input.filter ?? {}).some((key) =>
            ["typeId", "slug", "nodeId", "fromId", "toId"].includes(key),
          ),
        ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await app.dispose();
      await context.close();
    }
  });

test("Product initialization makes no browser data requests with JavaScript enabled", async ({
  page,
}) => {
  const { app, requests } = await fixture(page);
  try {
    await page.goto(origin);
    await expect(
      page.getByRole("heading", { name: "Product 8", exact: true }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(requests).toEqual([]);
  } finally {
    await app.dispose();
  }
});

for (const mode of ["empty", "failure", "anonymous", "unauthorized", "forbidden"] as const)
  test(`Product SSR handles ${mode}`, async ({ page }) => {
    const { app, calls, requests } = await fixture(page, mode);
    try {
      const response = await page.goto(origin);
      if (mode === "anonymous") {
        expect(response?.status()).toBe(200);
        await expect(page.getByRole("status")).toHaveText("Open Planning through your organization to view its products.");
        expect(calls).toEqual([]);
      } else if (mode === "unauthorized" || mode === "forbidden") {
        expect(response?.status()).toBe(mode === "unauthorized" ? 401 : 403);
        expect(calls).toContain("entities.types");
      } else if (mode === "failure") {
        expect(response?.status()).toBe(503);
        await expect(page.getByRole("status")).toContainText(
          "Product context is unavailable",
        );
      } else {
        expect(response?.status()).toBe(200);
        await expect(page.getByRole("status")).toHaveText("No products yet.");
      }
      await expect(page.locator(".planning-product-section")).toHaveCount(0);
      expect(requests).toEqual([]);
    } finally {
      await app.dispose();
    }
  });

function matchesFixtureFilter(record: EntityRecord, filter: Record<string, unknown> = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "nodeId") return record.attributes.fromId === value || record.attributes.toId === value;
    if (key === "archived") return !!record.attributes.archived === value;
    return record.attributes[key] === value;
  });
}

function fixturePage(rows: EntityRecord[], input: { filter?: Record<string, unknown>; offset?: number; limit?: number }) {
  const offset = input.offset ?? 0;
  return rows.filter(record => matchesFixtureFilter(record, input.filter)).slice(offset, offset + (input.limit ?? 100));
}

function fixtureRecordResult(record: EntityRecord | undefined) {
  return record ? { ok: true as const, value: record } : { ok: false as const, status: 404, message: "Record not found" };
}

function fixtureFailure(mode: string) {
  const statuses: Record<string, number> = { failure: 503, unauthorized: 401, forbidden: 403 };
  const status = statuses[mode];
  return status ? { ok: false as const, status, message: "Fixture context unavailable" } : null;
}
