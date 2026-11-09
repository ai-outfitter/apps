import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { test, expect } from "@playwright/test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { fulfillFrom, routeReadOnly, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
const origin = "https://planning.alpha.localhost";
const wiki = {
  installationId: "wiki",
  hostname: "wiki.alpha.localhost",
  writable: true,
};
for (const width of [1440, 390])
  test(`Planning sidebar opens user problems, customer segments and Wiki at ${width}px`, async ({
    page,
  }, info) => {
    const graph = discoveryFixture();
    const app = await appWorker(
      "planning",
      appArtifact(new URL("..", import.meta.url), "operational"),
      "planning-discovery",
      {
        workflowHost: () => ({
          async call(operation, input) {
            if (operation === "entities.types")
              return {
                ok: true,
                value: ["graph-type", "graph-node", "graph-edge"].map(
                  (type) => ({
                    installationId: "wiki",
                    template: "wiki-map",
                    collection:
                      type === "graph-type"
                        ? "types"
                        : type === "graph-node"
                          ? "nodes"
                          : "edges",
                    hostname: wiki.hostname,
                    type,
                    writable: true,
                    title: type,
                    description: "",
                    schema: {},
                  }),
                ),
              };
            if (operation === "entities.list" || operation === "entities.get")
              return readFixtureRecords(operation, input, graph);
            return { ok: false, status: 403, message: "Outside scope" };
          },
        }),
      },
    );
    const scope = {
      organizationId: "org",
      installationId: app.installationId,
      userId: "reader",
      packageHash: "test",
      phase: "interactive" as const,
      expiresAt: Date.now() + 600000,
    };
    // These assertions inspect the response before any browser JavaScript runs.
    const initial = await app.call(
      "/opportunities",
      { userId: "reader", organizationId: "org", role: "member" },
      { workflowHost: scope },
    );
    expect(initial.status).toBe(200);
    expect(await initial.text()).toContain("Choosing useful work is difficult");
    const detailHtml = await app.call(
      "/opportunities/problem-1",
      { userId: "reader", organizationId: "org", role: "member" },
      { workflowHost: scope },
    );
    expect(await detailHtml.text()).toContain(
      'href="../customer-segments/related-segment"',
    );
    expect((await app.call("/opportunities")).status).toBe(401);
    const missing = await app.call(
      "/opportunities/not-found",
      { userId: "reader", organizationId: "org", role: "member" },
      { workflowHost: scope },
    );
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Opportunity not found.");
    const apiRequests: string[] = [];
    await page.route(`${origin}/**`, async (route) => {
      if (await fulfillPlatformIdentity(route)) return;
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path.startsWith("/api/")) apiRequests.push(path);
      return fulfillFrom(
        route,
        await app.call(
          path,
          { userId: "reader", organizationId: "org", role: "member" },
          { workflowHost: scope },
        ),
      );
    });
    try {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/opportunities`);
      await expect(
        page.getByRole("heading", {
          name: "Choosing useful work is difficult",
        }),
      ).toBeVisible();
      await expect(page.getByText("View in Wiki ↗")).toHaveCount(0);
      await expect(page.locator(".planning-pill")).toContainText(
        "Customer segment: Product teams",
      );
      await expect(page.locator("#discovery")).toHaveJSProperty(
        "tagName",
        "DIV",
      );
      await expect(page.locator(".knowledge-graph-stage")).toHaveCount(0);
      await page.locator("#discovery-records a").click();
      await expect(page).toHaveURL(`${origin}/opportunities/problem-1`);
      await expect(
        page.getByRole("group", {
          name: "Relationships for Choosing useful work is difficult",
        }),
      ).toBeVisible();
      await expect(page.locator(".knowledge-graph-viewport svg")).toContainText(
        "Product teams",
      );
      const svg = page.getByRole("img", {
        name: "Choosing useful work is difficult: knowledge graph",
        exact: true,
      });
      await expect(svg.locator("[data-graph-node]")).toHaveCount(2);
      await expect(
        svg.locator('[data-graph-node="related-segment"]'),
      ).toHaveAttribute("href", "/customer-segments/related-segment");
      const widthBefore = Number(await svg.getAttribute("width"));
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      expect(Number(await svg.getAttribute("width"))).toBeGreaterThan(
        widthBefore,
      );
      await page
        .getByRole("button", { name: "Fit graph", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Expand graph", exact: true })
        .click();
      await expect(page.locator(".knowledge-graph-expanded")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".knowledge-graph-expanded")).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.reload();
      await expect(page.locator(".intro h1")).toHaveText(
        "Choosing useful work is difficult",
      );
      await expect(
        page.getByRole("link", { name: "Wiki ↗", exact: true, includeHidden: true }),
      ).toHaveAttribute("href", "https://wiki.alpha.localhost/");
      await page.screenshot({
        path: info.outputPath(`opportunities-${width}.png`),
        fullPage: true,
      });
      if (width < 600)
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
      await page
        .getByRole("link", { name: "Customer segments", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Small teams", exact: true }),
      ).toBeVisible();
      await expect(page.locator("#discovery-records")).toContainText(
        "Small teams",
      );
      await expect(page.locator(".knowledge-graph-stage")).toHaveCount(0);
      await page
        .locator('#discovery-records a[href="./customer-segments/segment-1"]')
        .click();
      await expect(page).toHaveURL(`${origin}/customer-segments/segment-1`);
      await expect(page.locator(".intro h1")).toHaveText("Small teams");
      await expect(page.locator(".knowledge-graph-viewport svg")).toContainText(
        "Product teams",
      );
      await page
        .getByRole("link", { name: "← All customer segments", exact: true })
        .click();
      await expect(page).toHaveURL(`${origin}/customer-segments`);
      await expect(page.locator("#discovery-records a").first()).toBeVisible();
      expect(apiRequests).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`customer-segments-${width}.png`),
        fullPage: true,
      });
    } finally {
      // The router may still be fetching a page; let it fail quietly.
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await app.dispose();
    }
  });
test("discovery demo remains read-only without calling APIs", async ({
  page,
}) => {
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "demo"),
  );
  await routeReadOnly(page, origin, app);
  try {
    await page.goto(`${origin}/opportunities`);
    await expect(
      page.getByRole("heading", {
        name: "Teams struggle to choose useful work",
      }),
    ).toBeVisible();
    await page.locator("#discovery-records a").click();
    await expect(page.locator(".intro h1")).toHaveText(
      "Teams struggle to choose useful work",
    );
    await page.goto(`${origin}/customer-segments`);
    await expect(
      page.getByRole("heading", { name: "Small project teams" }),
    ).toBeVisible();
  } finally {
    await app.dispose();
  }
});

function discoveryFixture() {
  const node = (
    id: string,
    title: string,
    attributes: EntityRecord["attributes"],
  ) => ({
    ref: { installationId: "wiki", type: "graph-node", id },
    revision: 1,
    title,
    attributes,
    references: [],
  });
  return {
    "graph-type": [
      node("problem-type", "Problem", { name: "Problem", category: "node" }),
      node("segment-type", "Customer segment", {
        name: "CustomerSegment",
        category: "node",
      }),
    ],
    "graph-node": [
      node("problem-1", "Choosing useful work is difficult", {
        typeId: "problem-type",
        summary: "Existing Wiki context",
      }),
      node("segment-1", "Small teams", {
        typeId: "segment-type",
        summary: "Existing Wiki context",
      }),
      node("related-segment", "Product teams", { typeId: "segment-type" }),
    ],
    "graph-edge": [
      node("problem-edge", "Affects", {
        fromId: "problem-1",
        toId: "related-segment",
      }),
      node("segment-edge", "Affects", {
        fromId: "segment-1",
        toId: "related-segment",
      }),
    ],
  };
}

function matchesFixtureFilter(record: EntityRecord, filter: Record<string, unknown> = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "nodeId") return record.attributes.fromId === value || record.attributes.toId === value;
    if (key === "archived") return !!record.attributes.archived === value;
    return record.attributes[key] === value;
  });
}

function readFixtureRecords(operation: string, input: unknown, graph: ReturnType<typeof discoveryFixture>) {
              const body = input as {
                installationId: string;
                type: string;
                id?: string;
                filter?: Record<string, unknown>;
                select?: string[];
                offset?: number;
                limit?: number;
              };
              if (body.installationId !== "wiki")
                return { ok: false as const, status: 403, message: "Outside scope" };
              const rows = graph[body.type as keyof typeof graph] ?? [];
              if (operation === "entities.get") {
                const record = rows.find((row) => row.ref.id === body.id);
                return record
                  ? { ok: true as const, value: record }
                  : { ok: false as const, status: 404, message: "Missing" };
              }
              return { ok: true as const, value: fixturePage(rows, body) };
}
function fixturePage(rows: EntityRecord[], input: { filter?: Record<string, unknown>; select?: string[]; offset?: number; limit?: number }) {
  const offset = input.offset ?? 0;
  return rows.filter(row => matchesFixtureFilter(row, input.filter))
    .slice(offset, offset + (input.limit ?? 50))
    .map(row => input.select ? { ...row, attributes: Object.fromEntries(input.select.map(key => [key, row.attributes[key]])) } : row);
}
