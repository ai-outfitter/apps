import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { expect, test } from "@playwright/test";
import { core } from "../src/lib/graph";

const origin = "https://wiki.outfitter.example";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const agent = { ...owner, entityWriter: "outfitter/eval" };
const documentId = "7b0e0000-0000-4000-8000-000000000091";

test("read a proposed document from Changes before approving its saved entity", async ({ page }, info) => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"), "wiki-map-installation", {
    workflowHost: () => ({ call: async () => { throw new Error("Unexpected host call"); } }),
  });
  const workflowHost = { organizationId: "org", installationId: "wiki-map-installation", userId: "owner", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 60_000 };
  const action = async (name: string, input: object) => {
    const response = await app.call("/api/internal/actions/v1/call", agent, {
      method: "POST", body: { action: name, input },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<{
      batch: { id: string; state: string };
      operations: { recordId: string | null }[];
    }>;
  };
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
    const batchUrl = `${origin}/changes/${batch.id}`;
    await test.step("read the proposal while it has no saved entity", async () => {
      await page.goto(`${origin}/changes`);
      await expect(page.getByRole("button", { name: "Ask Onto", exact: true })).toBeEnabled();
      await page.getByRole("link", { name: "Hardware milestone research", exact: true }).click();
      await expect(page).toHaveURL(batchUrl);
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
