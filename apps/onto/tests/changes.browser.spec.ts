import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { expect, type Page, test } from "@playwright/test";
import { create } from "./fixtures/relators";
import { core } from "../src/lib/graph";

const origin = "https://wiki.outfitter.example";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const agent = { ...owner, entityWriter: "outfitter/eval" };
const documentId = "7b0e0000-0000-4000-8000-000000000091";
const workflowHost = { organizationId: "org", installationId: "onto-installation", userId: "owner", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 60_000 };

/** A fresh Onto worker and a way to call its batch actions as an agent. */
async function openApp() {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "onto-installation", {
    workflowHost: () => ({ call: async () => { throw new Error("Unexpected host call"); } }),
  });
  const action = async (name: string, input: object) => {
    const response = await app.call("/api/internal/actions/v1/call", agent, { method: "POST", body: { action: name, input } });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<{ batch: { id: string; state: string }; operations: { recordId: string | null }[] }>;
  };
  return { app, action };
}

/** Serve the page from the worker as the owner. */
async function proxyTo(page: Page, app: Awaited<ReturnType<typeof openApp>>["app"]) {
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/platform/threads" && url.searchParams.get("view") === "snapshot") {
      await route.fulfill({ json: { thread: null, entries: [], before: null } });
      return;
    }
    await fulfillFrom(route, await app.call(url.pathname + url.search, owner, {
      workflowHost,
      method: request.method(),
      ...(request.postData() ? { body: request.postDataJSON() } : {}),
    }));
  });
  // HTTP development hostnames do not expose crypto.randomUUID.
  await page.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { value: undefined }));
}

test("read a proposed document from Changes before approving its saved entity", async ({ page }, info) => {
  const { app, action } = await openApp();
  try {
    const { batch } = await action("batch.open", {
      title: "Hardware milestone research",
      source: { kind: "discovery-run", ref: "changes-browser-test" },
    });
    await action("batch.add", { batchId: batch.id, proposals: [{
      operation: {
        operation: "create", type: "graph-node", ref: "$milestone",
        attributes: {
          id: documentId, typeId: core.document, title: "First hardware and firmware milestone",
          body: "## Proposed acceptance checks\n\nInspect the **printed enclosure** before flashing firmware.\n\n- Verify Wi-Fi provisioning\n- Record bench evidence",
        },
      },
    }] });
    const submitted = await action("batch.submit", { batchId: batch.id });
    expect(submitted.batch.state).toBe("awaiting_review");
    expect(submitted.operations[0].recordId).toBeNull();
    const absent = await app.call("/api/internal/entities/v1/get", owner, {
      method: "POST", body: { type: "graph-node", id: documentId },
    });
    expect(absent.status).toBe(404);

    await proxyTo(page, app);
    const batchUrl = `${origin}/changes/${batch.id}`;
    await test.step("read the proposal while it has no saved entity", async () => {
      await page.goto(`${origin}/changes`);
      await expect(page.getByRole("button", { name: "Ask Onto", exact: true })).toBeEnabled();
      await page.getByRole("link", { name: "Hardware milestone research", exact: true }).click();
      await expect(page).toHaveURL(batchUrl);
      await page.setViewportSize({ width: 1920, height: 1000 });
      const widths = await page.locator("#changes").evaluate(element => {
        const content = element.closest(".ui-content")!;
        const style = getComputedStyle(content);
        return { batch: element.getBoundingClientRect().width, available: content.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
      });
      expect(widths.batch).toBeGreaterThan(960);
      expect(Math.abs(widths.batch - widths.available)).toBeLessThan(2);
      await expect(page.getByRole("button", { name: "Graph (1)", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Expand graph", exact: true }).click();
      const viewport = page.locator(".knowledge-graph-viewport");
      await expect(page.locator(".knowledge-graph-expanded")).toBeVisible();
      await expect(viewport.locator("svg a")).toHaveCount(1);
      for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      const before = await viewport.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop, width: element.scrollWidth, client: element.clientWidth }));
      expect(before.width).toBeGreaterThan(before.client);
      const box = (await viewport.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const pointBefore = await viewport.locator("svg").evaluate((element, point) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height };
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await page.mouse.wheel(0, -100);
      await expect.poll(() => viewport.locator("svg").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(pointBefore.width);
      const pointAfter = await viewport.locator("svg").evaluate((element, point) => {
        const rect = element.getBoundingClientRect();
        return { x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height };
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      expect(Math.abs(pointAfter.x - pointBefore.x)).toBeLessThan(0.002);
      expect(Math.abs(pointAfter.y - pointBefore.y)).toBeLessThan(0.002);
      await page.mouse.wheel(0, 100);
      await expect.poll(() => viewport.locator("svg").evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(pointBefore.width + 1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 50, { steps: 5 });
      await page.mouse.up();
      expect(await viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(before.left);
      expect(await viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(before.top);
      await expect(page).toHaveURL(batchUrl);
      await page.getByRole("button", { name: "Fit graph", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(page.locator(".knowledge-graph-expanded")).toHaveCount(0);
      await page.getByRole("button", { name: "Review & anchors", exact: true }).click();
      await page.getByText("Anchor nodes (0)", { exact: true }).click();
      await page.getByRole("button", { name: "Save anchors", exact: true }).click();
      await expect(page.locator(".change-validation")).toContainText("Passing");
      await page.getByRole("button", { name: "Graph (1)", exact: true }).click();
      await expect(page.getByRole("button", { name: "Ask Onto", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Ask Onto", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Onto chat", exact: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("textbox", { name: "Message Onto" })).toBeEditable();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await info.attach(`ask-wiki-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
        if (process.env.WIKI_SCREENSHOTS)
          await page.screenshot({ path: `${process.env.WIKI_SCREENSHOTS}/ask-wiki-${width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole("button", { name: "Close Onto chat", exact: true }).click();
      const proposedLink = page.locator(".knowledge-graph-viewport svg a").filter({ hasText: "First hardware and firmware milestone" });
      await expect(proposedLink).toHaveAttribute("href", /^#/);
      await proposedLink.click();
      expect(new URL(page.url()).pathname).toBe(`/changes/${batch.id}`);
      const proposal = page.locator(".change-operation").filter({ hasText: "First hardware and firmware milestone" });
      await expect(proposal.getByRole("heading", { name: "Proposed acceptance checks", exact: true })).toBeVisible();
      await expect(proposal.locator("strong").filter({ hasText: "printed enclosure" })).toBeVisible();
      await expect(proposal.getByRole("listitem").filter({ hasText: "Record bench evidence" })).toBeVisible();
      await expect(page.getByText("Entity not found", { exact: true })).toHaveCount(0);
      await info.attach("proposed-document", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      if (process.env.WIKI_SCREENSHOTS)
        await page.screenshot({ path: `${process.env.WIKI_SCREENSHOTS}/hardware-mcp-wiki-preview.png`, fullPage: true });
    });
    await test.step("approve explicitly and open the saved entity", async () => {
      await page.getByRole("button", { name: "Approve all 1", exact: true }).click();
      const savedLink = page.locator(".change-operation").getByRole("link", { name: "First hardware and firmware milestone", exact: true });
      await expect(savedLink).toHaveAttribute("href", `/documents/${documentId}`);
      await expect(page.locator(".knowledge-graph-viewport svg a").filter({ hasText: "First hardware and firmware milestone" })).toHaveAttribute("href", `/documents/${documentId}`);
      await savedLink.click();
      await expect(page.getByRole("heading", { level: 1, name: "First hardware and firmware milestone", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Proposed acceptance checks", exact: true })).toBeVisible();
    });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});

test("records of a type proposed in the same batch show that type in the batch graph", async ({ page }) => {
  const { app, action } = await openApp();
  const storyboardType = "7b0e0000-0000-4000-8000-0000000000a1";
  const shotType = "7b0e0000-0000-4000-8000-0000000000a2";
  const shotOf = "7b0e0000-0000-4000-8000-0000000000a3";
  const proposal = (ref: string, type: string, attributes: object) => ({ operation: create(ref, type, attributes) });
  try {
    const { batch } = await action("batch.open", { title: "Storyboard types", source: { kind: "agent-task", ref: "changes-browser-types" } });
    await action("batch.add", { batchId: batch.id, proposals: [
      proposal("$t-storyboard", "graph-type", { id: storyboardType, category: "node", name: "Storyboard", title: "Storyboards", body: "A type.", properties: [] }),
      proposal("$t-shot", "graph-type", { id: shotType, category: "node", name: "Shot", title: "Shots", body: "A type.", properties: [] }),
      proposal("$t-shot-of", "graph-type", { id: shotOf, category: "edge", name: "shot_of", title: "shot of", body: "A type.", properties: [], ontology: { version: 2, endpoints: { from: [shotType], to: [storyboardType] } } }),
      proposal("$board", "graph-node", { typeId: "$t-storyboard", title: "Find your spot" }),
      proposal("$shot", "graph-node", { typeId: "$t-shot", title: "Choose a place" }),
      proposal("$edge", "graph-edge", { typeId: "$t-shot-of", fromId: "$shot", toId: "$board" }),
    ] });
    await action("batch.submit", { batchId: batch.id });
    await proxyTo(page, app);
    await page.goto(`${origin}/changes/${batch.id}`);
    const graph = page.locator(".knowledge-graph-viewport svg");
    await expect(graph.locator("a").filter({ hasText: "Choose a place" })).toContainText("Shots");
    await expect(graph.locator("a").filter({ hasText: "Find your spot" })).toContainText("Storyboards");
    await expect(graph).toContainText("shot_of");
    await expect(graph).not.toContainText("Entity");
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
