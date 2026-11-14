import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { expect, test } from "@playwright/test";
import { core } from "../src/lib/graph";

const origin = "https://wiki.outfitter.example";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const forerunner = { ...owner, actor: { kind: "app" as const, id: "forerunner" } };
const partOf = "71000000-0000-4000-8000-000000000032";
const uuid = (n: number) => `7d0e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (ref: string, n: number, typeId: string, title: string, extra: object = {}) =>
  ({ operation: "create", type: "graph-node", ref, attributes: { id: uuid(n), typeId, title, ...extra } });
type Json = Record<string, unknown>;

test("see the ontology steward's findings beside a submitted batch's proposals", async ({ page }, info) => {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "onto-installation", {
    workflowHost: () => ({ call: async (operation, input) => {
      const body = input as Json;
      if (operation === "workflow.start") return { ok: true, value: { id: body.id, workflow: body.workflow, created: true } };
      if (operation === "workflow.collect") return { ok: true, value: { run: "complete", steps: { review: "complete" } } };
      if (operation === "inference.generate") return { ok: true, value: { output: {
        summary: "2 findings: VEG-05 is NASA's experiment, not Artera's project.",
        findings: [{ ref: "$nasa", rule: "organization.unrelated", severity: "warning", message: "NASA has no relationship to Artera.", fix: "Relate NASA in_segment Astronauts." }],
      } } };
      return { ok: false, status: 400, message: `Unexpected ${operation}` };
    } }),
  });
  const workflowHost = { organizationId: "org", installationId: "onto-installation", userId: "owner", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 600_000 };
  const action = async (name: string, input: object, identity: object = owner) => {
    const response = await app.call("/api/internal/actions/v1/call", identity as typeof owner, { method: "POST", body: { action: name, input }, workflowHost });
    expect(response.status, await response.clone().text()).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: JSON responses under test.
    return response.json() as Promise<Record<string, any>>;
  };
  try {
    const { types } = await action("graph.read", {});
    const organization = types.find((type: Json) => type.id === core.organization);
    await action("graph.apply", { requestKey: "bind", operations: [
      { operation: "update", ref: "$org-type", type: "graph-type", id: core.organization, revision: organization.revision,
        attributes: { properties: [...organization.properties.filter((p: {name:string}) => p.name !== "organization_id"), { name: "organization_id", type: "string", description: "Platform organization", required: false }] } },
      node("$artera", 1, core.organization, "Artera", { properties: { organization_id: "org" } }),
    ] });
    const { batch } = await action("batch.open", { title: "Space crop research", source: { kind: "discovery-run", ref: "browser" },
      policy: { kind: "confidence", threshold: 0.95, version: "test-1" } }, forerunner);
    const cite = [{ provider: "web", recordId: "nasa.gov/veg-05", quote: "VEG-05 grows dwarf tomatoes on the ISS." }];
    await action("batch.add", { batchId: batch.id, proposals: [
      { operation: node("$nasa", 10, core.organization, "NASA"), evidence: cite, confidence: 0.8 },
      { operation: node("$veg", 11, core.project, "VEG-05"), evidence: cite, confidence: 0.8, reason: "A space crop experiment." },
      { operation: { operation: "create", type: "graph-edge", ref: "$veg-nasa", attributes: { id: uuid(12), typeId: partOf, fromId: "$veg", toId: "$nasa" } }, evidence: cite, confidence: 0.8 },
    ] }, forerunner);
    await action("batch.submit", { batchId: batch.id, summary: "NASA's space crop experiments" }, forerunner);
    await expect.poll(async () => (await action("batch.get", { batchId: batch.id })).batch.review?.state).toBe("complete");

    await page.route(`${origin}/**`, async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/api/platform/threads" && url.searchParams.get("view") === "snapshot") {
        await route.fulfill({ json: { thread: null, entries: [], before: null } });
        return;
      }
      await fulfillFrom(route, await app.call(url.pathname + url.search, owner, {
        workflowHost, method: request.method(), ...(request.postData() ? { body: request.postDataJSON() } : {}),
      }));
    });
    await test.step("the batch card says what the steward found", async () => {
      await page.goto(`${origin}/changes`);
      await expect(page.locator(".change-batch").filter({ hasText: "Space crop research" })).toContainText("Steward: 1 error, 1 warning");
    });
    await test.step("the batch page shows each finding beside its proposal, and decides nothing", async () => {
      await page.goto(`${origin}/changes/${batch.id}`);
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Ontology review", exact: true })).toBeVisible();
      await expect(page.getByText("2 findings: VEG-05 is NASA's experiment, not Artera's project.")).toBeVisible();
      await expect(page.locator(".change-review")).toContainText(/run [0-9a-f-]{36}/);
      await page.getByRole("button", { name: /^Proposals/ }).click();
      const project = page.locator(".change-operation").filter({ hasText: "A space crop experiment." });
      await expect(project.locator(".change-finding-error")).toContainText("project.foreign");
      await expect(project).toContainText("Waiting");
      await expect(page.locator(".change-operation").filter({ has: page.locator(".change-finding-warning") })).toContainText("NASA has no relationship to Artera.");
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await info.attach(`batch-review-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
        if (process.env.WIKI_SCREENSHOTS)
          await page.screenshot({ path: `${process.env.WIKI_SCREENSHOTS}/batch-review-${width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await info.attach("batch-review-proposal", { body: await project.screenshot(), contentType: "image/png" });
      if (process.env.WIKI_SCREENSHOTS) await project.screenshot({ path: `${process.env.WIKI_SCREENSHOTS}/batch-review-proposal.png` });
    });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
