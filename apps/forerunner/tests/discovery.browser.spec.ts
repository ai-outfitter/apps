import { identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHostResult } from "@ai-outfitter/app-sdk/workflow-host";
import { fulfillFrom, stayOnPage } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { wikiFixtureResult } from "@ai-outfitter/app-test/wiki-fixture";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, type Page, test } from "@playwright/test";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const scope = {
  organizationId: "org",
  installationId: "forerunner",
  userId: "owner",
  packageHash: "test",
  phase: "interactive" as const,
  expiresAt: Date.now() + 3600000,
};
const sample = {
  samples: [
    {
      format: "outfitter-forerunner-sample-v1",
      provider: "gmail",
      account: "artist@example.test",
      collectedAt: "2026-10-29T12:00:00Z",
      window: "Last 14 days; partial sample",
      collectionMethod: "agent-import",
      records: [
        {
          id: "commission-1",
          title: "Commission brief",
          text: "Please review the revised sketch.",
          date: "2026-10-28",
          participants: ["Studio client"],
        },
      ],
    },
  ],
};
async function entityResult(
  wiki: Awaited<ReturnType<typeof appWorker>>,
  operation: string,
  body: Record<string, unknown>,
): Promise<WorkflowHostResult> {
  const op = operation.slice(9),
    { installationId: _id, ...payload } = body;
  const response = await wiki.call(
    `/api/internal/entities/v1/${op}`,
    owner,
    op === "types" ? {} : { method: "POST", body: payload },
  );
  if (response.ok && op === "types")
    return {
      ok: true,
      value: ((await response.json()) as Record<string, unknown>[]).map(
        (t) => ({ ...t, installationId: "wiki", template:"onto" }),
      ),
    };

  return response.ok
    ? { ok: true, value: await response.json() }
    : { ok: false, status: response.status, message: await response.text() };
}
function syntheticWorkflowResult(operation: string): Record<string, unknown> | null | undefined {
  if (operation === "workflow.read") return null;
  if (operation === "session.append") return {id:"checkpoint"};
  if (operation === "session.read") return {format:"outfitter-workflow-session-v1",exportedAt:new Date().toISOString(),run:{id:"10000000-0000-4000-8000-000000000001",workflowId:"forerunner-discovery",createdBy:"owner",installationId:"forerunner",organizationId:"org",trigger:"manual",status:"complete",createdAt:1,updatedAt:2,definition:{},definitionHash:"test",packageHash:"test"},inputs:{},outputs:{},attempts:[],entries:[],gaps:["Synthetic browser host"]};
            if (operation === "workflow.start") return  { id: "10000000-0000-4000-8000-000000000001", workflow: "forerunner-discovery", created: true };
            if (operation === "workflow.collect") return  { run: "complete", steps: { analyze: "complete" } };
            if (operation === "inference.generate") return  { output: {
              entities: [{ key: "studio", name: "Studio client", type: "Person", summary: "Please review the revised sketch.", existingId: null, certainty: "mentioned", evidence: ["e0"] }],
              relationships: [],
            } };
  if (operation === "identity.current") return { id: "owner", name: "Artist", email: "artist@example.test" };
  return undefined;
}

/** Reruns the saved sample from Sources, which owns reruns. */
async function rerun(page: Page, origin: string) {
  await page.goto(`${origin}/sources`);
  const row = page.locator(".source-row", { hasText: "Gmail · artist@example.test" });
  await row.getByRole("button", { name: "Rerun", exact: true }).click();
  await row.getByRole("button", { name: "Run now", exact: true }).click();
}

for (const width of [1440, 390])
  test(`review source entries and save once through Wiki at ${width}px`, async ({
    page,
  }, info) => {
    const wiki = await appWorker(
      "onto",
      appArtifact(new URL("../../onto", import.meta.url), "operational"),
      "wiki",
    );
    expect((await wiki.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status).toBe(200);
    let applies = 0;
    let historicalPreview = false;
    let pauseAnalysis = false;
    let analysisStarted!: () => void;
    let releaseAnalysis!: () => void;
    const started = new Promise<void>(resolve => { analysisStarted = resolve; });
    const resumed = new Promise<void>(resolve => { releaseAnalysis = resolve; });
    const holdAnalysis = async (operation: string) => {
      if (operation !== "inference.generate" || !pauseAnalysis) return;
      analysisStarted();
      await resumed;
    };
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const diagnostics = false;
    const app = await appWorker(
      "forerunner",
      appArtifact(new URL("..", import.meta.url), "operational"),
      "forerunner",
      {
        workflowHost: () => ({
          async call(operation, input): Promise<WorkflowHostResult> {
            if (operation === "snapshot")
              return {
                ok: true,
                value: {
                  installation: {
                    id: "forerunner",
                    activeHash: "test",
                    hostname: null,
                    workflows: [],
                  },
                  bindings: [],
                  subscriptions: [],
                  connections: [],
                },
              };
            const body = input as Record<string, unknown>;
            await holdAnalysis(operation);
            const modelResult = syntheticWorkflowResult(operation);
            if (modelResult !== undefined) return { ok: true, value: modelResult };
            if (operation === "actions.call") {
              // A save is one committing write: a batch submit, or a direct graph.apply.
              applies += Number((body.input as { operationName?: string } | undefined)?.operationName === "SubmitBatch" || body.action === "graph.apply");
              return wikiFixtureResult(await wiki.call(
                "/api/internal/actions/v1/call",
                // As platform dispatch does: the member's identity with Forerunner as the actor, and no
                // entity writer, since Forerunner does not hold entities.write.delegated.
                { ...owner, actor: { kind: "app", id: "forerunner" } },
                {
                  method: "POST",
                  body: { action: body.action, input: body.input },
                },
              ));
            }
            if (operation.startsWith("entities.")) {
              return entityResult(wiki, operation, body);
            } else
              return {
                ok: false,
                status: 400,
                message: "Unexpected operation",
              };

          },
        }),
      },
    );
    const origin = "https://forerunner.example";
    await page.route(`${origin}/**`, async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      const response = await app.call(url.pathname + url.search, owner, {
          method: req.method(),
          ...(diagnostics ? { headers: { "x-outfitter-developer-diagnostics": "1" } } : {}),
          ...(req.postData() ? { body: req.postDataJSON() } : {}),
          workflowHost: scope,
        });
      if (historicalPreview && url.pathname.endsWith("/activity") && url.searchParams.has("id") && response.ok) {
        const result = await response.json() as { preview: { version?: number; warnings?: string[] } | null };
        if (result.preview) { result.preview.version = 2; delete result.preview.warnings; }
        await route.fulfill({ status: 200, json: result });
        return;
      }
      await fulfillFrom(route, response);
    });
    try {
      const typesResponse = await wiki.call("/api/internal/entities/v1/list", owner, {method:"POST",body:{type:"graph-type",limit:100}});
      const types = await typesResponse.json() as {ref:{id:string};attributes:{name:string}}[];
      const personType = types.find(t=>t.attributes.name === "Person");
      if (!personType) throw new Error("Missing Person type");
      const contactId = "40000000-0000-4000-8000-000000000099";
      const created = await wiki.call("/api/internal/actions/v1/call", owner, {method:"POST",body:{action:"graph.apply",input:{requestKey:"test-contact",operations:[{operation:"create",type:"graph-node",ref:"$contact",attributes:{id:contactId,typeId:personType.ref.id,title:"Correct contact"}}]}}});
      expect(created.status).toBe(200);
      await page.setViewportSize({width,height:900});
      await page.goto(`${origin}/settings`);
      await expect(page.getByRole("button",{name:"Debug runs"})).toHaveCount(0);
      await page.getByText("No accounts connected yet").waitFor();
      await expect(page.getByRole("link",{name:"Connect Google"})).toBeVisible();
      await expect(page.locator("#settings-daily-status")).toHaveText("The daily run is unavailable right now.");
      // Settings no longer imports agent samples; the import endpoint stays for agents.
      const imported = await page.evaluate(async (body) => (await fetch("/api/apps/forerunner/discovery/import", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).ok, sample);
      expect(imported).toBe(true);
      await rerun(page, origin);
      await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/inputs$/);
      await expect(page.locator("#activity-run-status")).toContainText("Saved");
      // The run opens on what it read: each email, and what the agent made of it.
      await expect(page.getByRole("link",{name:/^Inputs/})).toHaveAttribute("aria-current","page");
      await expect(page.locator("#run-mail-detail")).toContainText("Please review the revised sketch.");
      await expect(page.locator("#run-mail-detail .run-conclusion")).toContainText("Studio client");
      await expect(page.locator("#run-mail-detail .run-conclusion")).toContainText("Added");
      await page.screenshot({path:info.outputPath(`run-inputs-${width}.png`)});
      const downloaded=page.waitForEvent("download");
      await page.getByRole("button",{name:"Export run"}).click();
      const download=await downloaded;
      expect(download.suggestedFilename()).toMatch(/^workflow-session-.*\.json$/);
      const {readFile}=await import("node:fs/promises");
      const session=JSON.parse(await readFile((await download.path())!,"utf8"));
      expect(session.format).toBe("outfitter-workflow-session-v1");
      expect(session.entries.find((e:{id:string})=>e.id==="app.history")).toBeDefined();

      const visit = stayOnPage(page);
      await visit.mark();
      const inputUrl = page.url();
      await page.getByRole("link",{name:/^Changes/}).click();
      await expect(page).toHaveURL(/\/changes$/);
      await expect(page.locator("#run-mail-list")).toHaveCount(0);
      await visit.expectSame();
      await expect(page.getByRole("link",{name:/^Changes/})).toContainText("1");
      await expect(page.locator("#discovery-entries")).toContainText("Added");
      expect(applies).toBe(1);
      await expect(page.getByRole("group",{name:"Person",exact:true})).toBeVisible();
      await expect(page.getByRole("button",{name:"Correct match",exact:true})).toBeHidden();
      await expect(page.getByRole("button",{name:"Save reviewed entries to Wiki"})).toHaveCount(0);
      await page.getByText("Was this run useful?",{exact:true}).click();
      await page.getByRole("combobox",{name:"Rating",exact:true}).selectOption("mixed");
      await page.getByRole("textbox",{name:"Anything we should improve?"}).fill("The person match needs correction.");
      await page.getByRole("button",{name:"Share feedback",exact:true}).click();
      await expect(page.locator("#evaluation-status")).toContainText("Feedback saved");
      await page.getByRole("button",{name:"More options for Studio client",exact:true}).click();
      await page.getByRole("button",{name:"Correct match",exact:true}).click();
      await page.getByRole("combobox",{name:"Correct match for Studio client",exact:true}).selectOption(contactId);
      await page.getByRole("button",{name:"Use this match",exact:true}).click();
      await expect(page.getByRole("heading",{name:"Correct contact",exact:true})).toBeVisible();
      await expect(page.locator("#discovery-entries").getByText("Corrected",{exact:true})).toBeVisible();
      // The open tab survives a reload.
      await page.reload();
      await expect(page.getByRole("heading",{name:"Correct contact",exact:true})).toBeVisible();
      await expect(page.locator("#evaluation-status")).toContainText("Feedback saved");
      await page.screenshot({path:info.outputPath(`saved-results-${width}.png`)});
      await visit.mark();
      await page.getByRole("link",{name:"Transcript"}).click();
      await expect(page).toHaveURL(/\/transcript$/);
      await expect(page.locator("#discovery-entries")).toHaveCount(0);
      await visit.expectSame();
      await page.getByText("Show the full prompt",{exact:true}).click();
      await expect(page.locator("#activity-prompt")).toContainText("# Operating user");
      await page.getByText("Model input",{exact:true}).click();
      await expect(page.locator("#run-transcript")).toContainText("Please review the revised sketch.");
      expect(pageErrors).toEqual([]);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
      await page.screenshot({path:info.outputPath(`run-transcript-${width}.png`)});
      historicalPreview=true;
      await page.reload();
      await expect(page.locator("#activity-run-status")).toContainText("Saved");
      expect(pageErrors).toEqual([]);
      historicalPreview=false;
      await page.getByRole("link", { name: "e0", exact: true }).click();
      await expect(page).toHaveURL(/\/inputs\?item=e0$/);
      await expect(page.locator("#run-mail-detail")).toContainText("Please review");
      await page.goBack();
      await expect(page).toHaveURL(/\/transcript$/);
      await page.goForward();
      await expect(page).toHaveURL(/\/inputs\?item=e0$/);
      // Inspect legacy redirects without Miniflare following them inside the fixture.
      const legacy = await app.dispatch("", new Request(app.origin + new URL(inputUrl).pathname.replace(/\/inputs$/, "?tab=changes"), {
        headers: identityHeaderValues({ ...owner, installationId: "forerunner" }), redirect: "manual",
      }), { workflowHost: scope });
      expect(legacy.status).toBe(302);
      expect(legacy.headers.get("location")).toBe(new URL(inputUrl).pathname.replace(/\/inputs$/, "/changes"));
      await page.goto(new URL(legacy.headers.get("location") ?? "", origin).href);
      await expect(page).toHaveURL(/\/changes$/);
      await expect(page.locator("#discovery-entries")).toContainText("Corrected");
      await rerun(page, origin);
      await expect(page.locator("#activity-run-status")).toContainText("Saved");
      await expect(page.locator("#run-mail-detail .run-conclusion")).toContainText("Already in graph");
      expect(applies).toBe(1);
      await test.step("a source run finishes after navigating away without pulling the member back", async () => {
        pauseAnalysis = true;
        const response = page.waitForResponse(r => r.url().endsWith("/discovery/discover") && r.request().method() === "POST", { timeout: 10_000 });
        await rerun(page, origin);
        await started;
        if (!(await page.locator("#sidebar").isVisible()))
          await page.getByRole("button", { name: "Open navigation", exact: true }).click();
        await page.locator("#sidebar").getByRole("link", { name: "History", exact: true }).click();
        await expect(page).toHaveURL(/\/history$/);
        releaseAnalysis();
        expect((await response).status()).toBe(200);
        await expect(page).toHaveURL(/\/history$/);
        await page.reload();
        await expect(page.locator("a.activity-event").filter({ hasText: "Discovery" }).first()).toContainText("Saved");
        pauseAnalysis = false;
        await page.locator("a.activity-event").filter({ hasText: "Discovery" }).first().click();
        await expect(page.locator("#activity-run-status")).toContainText("Saved");
      });
      const failureStatus=await page.evaluate(async()=>(await fetch("/api/apps/forerunner/discovery/discover",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sources:["connection:missing"]})})).status);
      expect(failureStatus).toBeGreaterThanOrEqual(400);
      await page.getByRole("link",{name:"Back to history"}).click();
      await page.locator("a.activity-event").filter({hasText:"Failed"}).first().click();
      await expect(page.locator("#activity-run-error")).toBeVisible();
    } finally {
      releaseAnalysis();
      await page.unrouteAll({ behavior: "wait" });
      await app.dispose();
      await wiki.dispose();
    }
  });
