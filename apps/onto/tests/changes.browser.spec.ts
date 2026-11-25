import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { expect, type Page, test } from "@playwright/test";
import { create, update } from "./fixtures/relators";
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
      await expect(page.getByRole("button", { name: "Proposals (1)", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".change-line").getByRole("link", { name: "First hardware and firmware milestone", exact: true }))
        .toHaveAttribute("href", `/documents/${documentId}?batch=${batch.id}`);
      await page.getByRole("button", { name: "Graph (1)", exact: true }).click();
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
      await expect(page.locator(".change-anchor")).toContainText("New records need not connect to anything.");
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
      await expect(proposedLink).toHaveAttribute("href", `/documents/${documentId}?batch=${batch.id}`);
      await proposedLink.click();
      await expect(page).toHaveURL(`${origin}/documents/${documentId}?batch=${batch.id}`);
      await expect(page.getByRole("heading", { level: 1, name: "First hardware and firmware milestone", exact: true })).toBeVisible();
      await expect(page.locator(".batch-proposed-line")).toHaveText("Proposed in Hardware milestone research, not saved");
      const proposal = page.locator(".node-reader");
      await expect(proposal.getByRole("heading", { name: "Proposed acceptance checks", exact: true })).toBeVisible();
      await expect(proposal.locator("strong").filter({ hasText: "printed enclosure" })).toBeVisible();
      await expect(proposal.getByRole("listitem").filter({ hasText: "Record bench evidence" })).toBeVisible();
      await expect(page.getByText("Entity not found", { exact: true })).toHaveCount(0);
      await info.attach("proposed-document", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      if (process.env.WIKI_SCREENSHOTS)
        await page.screenshot({ path: `${process.env.WIKI_SCREENSHOTS}/hardware-mcp-wiki-preview.png`, fullPage: true });
    });
    await test.step("approve explicitly and open the saved entity", async () => {
      await page.locator(".batch-item-decision").getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.locator(".batch-proposed-line")).toHaveText("Saved from Hardware milestone research");
      await page.locator(".batch-proposed-line").getByRole("link").click();
      await expect(page.locator(".change-line")).toContainText("Approved by a member");
      await page.goto(`${origin}/documents/${documentId}`);
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
      proposal("$t-storyboard", "graph-type", { id: storyboardType, category: "node", name: "FixtureStoryboard", title: "Storyboards", body: "A type.", properties: [] }),
      proposal("$t-shot", "graph-type", { id: shotType, category: "node", name: "Shot", title: "Shots", body: "A type.", properties: [] }),
      proposal("$t-shot-of", "graph-type", { id: shotOf, category: "edge", name: "shot_of", title: "shot of", body: "A type.", properties: [], ontology: { version: 2, endpoints: { from: [shotType], to: [storyboardType] } } }),
      proposal("$board", "graph-node", { typeId: "$t-storyboard", title: "Find your spot" }),
      proposal("$shot", "graph-node", { typeId: "$t-shot", title: "Choose a place" }),
      proposal("$edge", "graph-edge", { typeId: "$t-shot-of", fromId: "$shot", toId: "$board" }),
    ] });
    await action("batch.submit", { batchId: batch.id });
    await proxyTo(page, app);
    await page.goto(`${origin}/changes/${batch.id}`);
    await page.getByRole("button", { name: /^Graph/ }).click();
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

test("walk a batch page by page: open a proposed node, approve it there, go to the next", async ({ page }) => {
  const { app, action } = await openApp();
  const storyboardType = "7b0e0000-0000-4000-8000-0000000000b1";
  const shotType = "7b0e0000-0000-4000-8000-0000000000b2";
  const shotOf = "7b0e0000-0000-4000-8000-0000000000b3";
  const property = (name: string) => ({ name, type: "number", description: name, required: false });
  const proposal = (ref: string, type: string, attributes: object, extra: object = {}) => ({ operation: create(ref, type, attributes), ...extra });
  try {
    const plan = "7b0e0000-0000-4000-8000-0000000000b4";
    await action("graph.apply", { requestKey: "plan", operations: [create("$plan", "graph-node", { id: plan, typeId: core.document, title: "Launch plan", summary: "Three videos." })] });
    const { batch } = await action("batch.open", { title: "Launch videos", source: { kind: "agent-task", ref: "changes-browser-walk" } });
    await action("batch.add", { batchId: batch.id, proposals: [
      proposal("$t-storyboard", "graph-type", { id: storyboardType, category: "node", name: "FixtureStoryboard", title: "Storyboards", body: "The plan for one video.", properties: [] }),
      proposal("$t-shot", "graph-type", { id: shotType, category: "node", name: "Shot", title: "Shots", body: "One beat of a storyboard.", properties: [property("duration_seconds")] }),
      proposal("$t-shot-of", "graph-type", { id: shotOf, category: "edge", name: "shot_of", title: "shot of", body: "A type.", properties: [], ontology: { version: 2, endpoints: { from: [shotType], to: [storyboardType] } } }),
      proposal("$board", "graph-node", { typeId: "$t-storyboard", title: "Find your spot" }),
      proposal("$shot", "graph-node", { typeId: "$t-shot", title: "Choose a place", properties: { duration_seconds: 4 } },
        { reason: "The launch plan opens on this shot.", confidence: 0.8, evidence: [{ provider: "web", recordId: "plan", quote: "Open on the balcony." }] }),
      proposal("$shot-2", "graph-node", { typeId: "$t-shot", title: "Read the light" }),
      proposal("$edge", "graph-edge", { typeId: "$t-shot-of", fromId: "$shot", toId: "$board" }),
      { operation: update("$plan", "graph-node", plan, 1, { summary: "Four videos." }) },
    ] });
    await action("batch.submit", { batchId: batch.id });
    await proxyTo(page, app);
    await page.goto(`${origin}/changes/${batch.id}`);
    const lines = page.locator(".change-line");
    await expect(lines).toHaveCount(7);
    await expect(lines.nth(0)).toContainText("Storyboards");
    await expect(lines.filter({ hasText: "Choose a place" })).toContainText("Choose a place → shot of → Find your spot");
    await lines.getByRole("link", { name: "Storyboards", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Storyboards", exact: true })).toBeVisible();
    await expect(page.locator(".batch-proposed-line")).toHaveText("Proposed in Launch videos, not saved");
    await expect(page.getByRole("link", { name: "Next: Shots →", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "All proposals", exact: true }).click();
    await lines.getByRole("link", { name: "Choose a place", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/shots/%24shot?batch=${batch.id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Choose a place", exact: true })).toBeVisible();
    await expect(page.locator(".batch-proposed-line")).toHaveText("Proposed in Launch videos, not saved");
    await expect(page.locator(".node-facts")).toContainText("Duration seconds");
    await expect(page.locator(".node-facts")).toContainText("4");
    await expect(page.locator(".batch-item")).toContainText("The launch plan opens on this shot.");
    await expect(page.locator(".batch-item")).toContainText("80% confident");
    await expect(page.locator(".batch-item-edges")).toContainText("Choose a place → shot of → Find your spot");
    const related = page.locator(".node-relationships");
    await expect(related.locator("dt")).toContainText("proposed");
    await expect(related.getByRole("link", { name: "Find your spot", exact: true })).toHaveAttribute("href", `/fixture-storyboards/%24board?batch=${batch.id}`);
    await page.locator(".batch-item-decision").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.locator(".batch-proposed-line")).toHaveText("Saved from Launch videos");
    await expect(page.locator(".batch-item-decision")).toContainText("Approved by a member");
    await page.getByRole("link", { name: "Next: Read the light →", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Read the light", exact: true })).toBeVisible();
    await expect(page.locator(".batch-proposed-line")).toHaveText("Proposed in Launch videos, not saved");
    await page.getByRole("link", { name: "← Previous: Choose a place", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Choose a place", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "All proposals", exact: true }).click();
    await expect(lines.filter({ hasText: "Choose a place" }).locator("> .change-state")).toHaveText("Approved by a member");
    await lines.getByRole("link", { name: "Launch plan", exact: true }).click();
    await expect(page.locator(".batch-proposed-line")).toHaveText("Changes proposed in Launch videos, not saved");
    await expect(page.locator(".node-summary")).toHaveText("Three videos.");
    await expect(page.locator(".batch-changes tbody tr")).toHaveText(["summaryThree videos.Four videos."]);
    await page.getByRole("link", { name: "All proposals", exact: true }).click();
    await page.getByRole("button", { name: "Approve all 6", exact: true }).click();
    await expect(lines.filter({ hasText: "Read the light" }).locator("> .change-state")).toHaveText("Approved by a member");
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});

test("submit a member draft from Changes and correct a validation failure", async ({ page }) => {
  const { app, action } = await openApp();
  try {
    const anchor = "7b0e0000-0000-4000-8000-000000000123";
    await action("graph.apply", {requestKey:"anchor", operations:[create("$anchor", "graph-node", {
      id:anchor, typeId:core.person, title:"Reviewer", slug:"reviewer",
    })]});
    const { batch } = await action("batch.open", { title: "Draft field notes", anchors:["Person:reviewer"] });
    await action("batch.add", {batchId:batch.id, proposals:[{operation:create("$field", "graph-node", {
      id:documentId, typeId:core.document, title:"Field note",
    })}]});
    await proxyTo(page, app);
    await page.goto(`${origin}/changes/${batch.id}`);
    const submit = page.getByRole("button", {name:"Submit for review"});
    await submit.click();
    await expect(page.getByRole("alert")).toContainText(/anchor.*Field note/i);
    await expect(submit).toBeEnabled();
    await expect(page.locator("#changes")).toContainText("Collecting");
    await action("batch.add", { batchId:batch.id, replace:true, proposals:[{operation:update("$field", "graph-node", anchor, 1, {summary:"Reviewed field note."})}] });
    let requests = 0;
    page.on("request", request => { if (request.url().endsWith("/batches/submit")) requests++; });
    await submit.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(page.locator("#changes")).toContainText("Waiting for review");
    expect(requests).toBe(1);
    await expect(submit).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#changes")).toContainText("Waiting for review");
  } finally {
    await page.unrouteAll({behavior:"wait"});
    await app.dispose();
  }
});
