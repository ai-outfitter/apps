import { expect, test } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import {
  organizationControlPilot,
  personalControlPilot,
  pilotId,
  personTypeId,
} from "../scripts/control-pilots";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const origin = "https://wiki.outfitter.example";

test("structured control shows missing graph paths and recomputes after connection changes", async ({
  page,
}, info) => {
  const app = await appWorker(
    "onto",
    appArtifact(new URL("../../onto/", import.meta.url), "operational"),
  );
  try {
    const call = async (input: unknown) =>
      app.call("/api/internal/actions/v1/call", owner, {
        method: "POST",
        body: { action: "graph.apply", input },
      });
    const initialize = await app.call("/api/internal/app-initialize", owner, {
      method: "POST",
      body: {},
    });
    expect(initialize.status, await initialize.text()).toBe(200);
    const a = "10000000-0000-4000-8000-000000000001",
      b = "10000000-0000-4000-8000-000000000002",
      org = "10000000-0000-4000-8000-000000000003";
    const personal = personalControlPilot(
        { id: a, name: "Alex" },
        { id: b, name: "Blair" },
      ),
      organization = organizationControlPilot(a, org);
    const nodes = [
      { id: a, typeId: personTypeId, title: "Alex" },
      { id: b, typeId: personTypeId, title: "Blair" },
      {
        id: org,
        typeId: "71000000-0000-4000-8000-000000000001",
        title: "Example organization",
      },
      ...personal.nodes,
      ...organization.nodes,
    ];
    const result = await call({
      requestKey: "structured-pilots",
      operations: [
        ...nodes.map((attributes, i) => ({
          operation: "create",
          type: "graph-node",
          ref: `$n${i}`,
          attributes,
        })),
        ...[...personal.edges, ...organization.edges].map((attributes, i) => ({
          operation: "create",
          type: "graph-edge",
          ref: `$e${i}`,
          attributes,
        })),
      ],
    });
    expect(result.status, await result.text()).toBe(200);
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      await fulfillFrom(
        route,
        await app.call(url.pathname + url.search, owner, {
          method: request.method(),
          ...(request.postData() ? { body: request.postDataJSON() } : {}),
        }),
      );
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/control-definitions/${pilotId(303)}`);
      await page.getByRole("tab", { name: "Technical", exact: true }).click();
      const requirements = page.locator("section").filter({ has: page.getByRole("heading", { name: "Data readiness", exact: true }) });
      await expect(requirements.getByRole("row").filter({ hasText: /source service/i })).toContainText("Connected");

      await expect(requirements).toContainText("No executable source relation is bound.");
      await page.screenshot({
        path: info.outputPath(`structured-org-${width}.png`),
        fullPage: true,
      });
      await page.goto(`${origin}/control-definitions/${pilotId(203)}`);
      await page.getByRole("tab", { name: "Technical", exact: true }).click();
      await expect(page.locator("section").filter({ has: page.getByRole("heading", { name: "Data readiness", exact: true }) }).getByRole("row").filter({ hasText: /source service/i })).toContainText("Missing");
      await expect(page.locator("section").filter({ has: page.getByRole("heading", { name: "Stored definition", exact: true }) })).toContainText('"programs"');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`structured-personal-${width}.png`),
        fullPage: true,
      });
    }
    const removed = await call({
      requestKey: "remove-source",
      operations: [
        {
          operation: "update",
          type: "graph-edge",
          id: pilotId(318),
          ref: "$source",
          revision: 1,
          attributes: { archived: true },
        },
      ],
    });
    expect(removed.status, await removed.text()).toBe(200);
    await page.goto(`${origin}/control-definitions/${pilotId(303)}`);
    await page.getByRole("tab", { name: "Technical", exact: true }).click();
    await expect(page.locator("section").filter({ has: page.getByRole("heading", { name: "Data readiness", exact: true }) }).getByRole("row").filter({ hasText: /source service/i })).toContainText("Missing");
    const restored = await call({
      requestKey: "restore-source",
      operations: [
        {
          operation: "update",
          type: "graph-edge",
          id: pilotId(318),
          ref: "$source",
          revision: 2,
          attributes: { archived: false },
        },
      ],
    });
    expect(restored.status, await restored.text()).toBe(200);
    await page.reload();
    await page.getByRole("tab", { name: "Technical", exact: true }).click();
    await expect(page.locator("section").filter({ has: page.getByRole("heading", { name: "Data readiness", exact: true }) }).getByRole("row").filter({ hasText: /source service/i })).toContainText("Connected");
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
