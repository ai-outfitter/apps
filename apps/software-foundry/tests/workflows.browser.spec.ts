import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
let app: Awaited<ReturnType<typeof appWorker>>;
test.beforeAll(async () => {
  app = await appWorker(
    "software-foundry",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
});
test.afterAll(async () => {
  await app?.dispose();
});

test("Foundry keeps workflow configuration and pinned node evidence inside the app", async ({
  page,
}) => {
  const definition = {
    id: "issue-to-triage-resident",
    summary: "Issue to independent review",
    actors: { triager: { kind: "external" }, engineer: { kind: "external" }, reviewer: { kind: "resident" } },
    steps: [
      { id: "triage", actor: "triager" },
      { id: "review", actor: "reviewer", instructions: "Current instructions" },
    ],
  };
  const run = {
    id: "run-1",
    installationId: "app",
    workflow: {
      ...definition,
      steps: [
        {
          id: "review",
          actor: "reviewer",
          instructions: "Pinned instructions for this run",
        },
      ],
    },
    createdAt: "2026-10-11T12:00:00Z",
    status: "running",
    attempts: [{nodeId: "review", state: "dispatched", taskStatus: {state: "input-required", observedAt: Date.parse("2026-10-17T12:00:00Z")}, createdAt: Date.parse("2026-10-17T11:55:00Z"), updatedAt: Date.parse("2026-10-17T11:55:00Z"), expiresAt: Date.parse("2026-10-17T12:55:00Z")}],
    steps: { review: "blocked" },
    inputs: {},
    rows: {
      "review.outputs.review": {
        complete: false,
        value: { reason: "Check logs access missing", candidate: {headSha: "a".repeat(40),url:"https://github.com/org/repo/pull/1"},
          review:{url:"https://github.com/org/repo/pull/1#pullrequestreview-2",verdict:"approved"},checks:[{name:"test",passed:true,url:"https://github.com/org/repo/actions/runs/3"}],
          evidence:[{installationId:"app",runId:"run-1",nodeId:"review",filename:"desktop-proof.png",headSha:"a".repeat(40),sha256:"b".repeat(64),url:`${app.origin}/files/main/runs/run-1/demo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-desktop-proof.png`}] },
      },
    },
    dispatch: { error: "Resident repository access needs attention" },
  };
  let bindingFailure = false;
  let completeBindings = false;
  const saves: unknown[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Intermediate UI harness only: provider execution and authorization are not mocked proof.
  await page.route(`${app.origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    let value: unknown;
    if (url.pathname === "/api/platform/workflows")
      value = {
        packageHash: "approved-package",
        workflows: [
          { package: "workflow-package", version: "0.1.0", definition },
        ],
      };
    else if (url.pathname === "/api/platform/workflow-subscriptions") {
      if (route.request().method() === "PUT")
        saves.push(route.request().postDataJSON());
      value = { items: [] };
    } else if (url.pathname === "/api/workflow-runs") value = { items: [run] };
    else if (url.pathname === "/api/workflow-runs/run-1") value = run;
    else {
      const response = await app.call(url.pathname + url.search, {
        organizationId: "org",
        userId: "member",
        role: "admin",
      });
      await fulfillFrom(route, response);
      return;
    }
    await route.fulfill({ json: value });
  });
  await page.route(`${app.origin}/api/platform/executor-bindings`, async (route) => {
    if (bindingFailure) { await route.fulfill({status: 503, body: "Unavailable"}); return; }
    await route.fulfill({json: {items: [...(completeBindings ? [{id: "triager", revision: "revision", label: "Issue triager", workflowId: definition.id, actor: "triager", kind: "external", enabled: true, model: "gpt-6-luna", profile: {id: "triager", digest: "c".repeat(64)}, configuration: {valid: true}}, {id: "engineer", revision: "revision", label: "Engineer", workflowId: definition.id, actor: "engineer", kind: "external", enabled: true, model: "gpt-6-luna", profile: {id: "engineer", digest: "b".repeat(64)}, configuration: {valid: true}}] : []), {id: "binding", revision: "revision", label: "Resident reviewer", workflowId: definition.id, actor: "reviewer", kind: "resident", enabled: true, model: "gpt-6-luna", profile: {id: "reviewer", digest: "a".repeat(64)}, configuration: {valid: true}}], truncated: !completeBindings}});
  });
  const screenshotFixture = await page.evaluate(() => {
    const canvas=document.createElement("canvas");canvas.width=640;canvas.height=360;
    const context=canvas.getContext("2d")!;context.fillStyle="#eef0e7";context.fillRect(0,0,640,360);
    context.fillStyle="#374333";context.font="24px sans-serif";context.fillText("Screenshot fixture",32,64);
    context.font="18px sans-serif";context.fillText("Tests R2 image rendering and source attribution.",32,110);
    context.fillText("This is not a live Foundry run.",32,150);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.route(`${app.origin}/files/main/runs/run-1/*.png`, route => route.fulfill({contentType:"image/png",body:Buffer.from(screenshotFixture,"base64")}));
  await page.goto(`${app.origin}/workflows`);
  await expect(
    page.getByRole("link", { name: "Workflows", exact: true }),
  ).toHaveAttribute("href", /^(https?:\/\/[^/]+)?\/workflows$/);
  await expect(page.locator("#workflow-nodes")).toContainText(
    "review · resident",
  );
  await expect(page.locator("#workflow-bindings")).toContainText("configuration valid");
  await expect(page.locator("#workflow-binding-limit")).toContainText("incomplete");
  await page.locator("#workflow-runs button").click();
  await expect(page.locator("#workflow-run")).toContainText("Execution: dispatched");
  await expect(page.locator("#workflow-run")).toContainText("graph: blocked");
  await expect(page.locator("#workflow-run")).toContainText(
    "Pinned instructions for this run",
  );
  await expect(page.locator("#workflow-run")).toContainText(
    "Check logs access missing",
  );
  await expect(page.getByRole("link",{name:"Pull request",exact:true})).toHaveAttribute("href","https://github.com/org/repo/pull/1");
  await expect(page.getByRole("link",{name:"Formal review: approved",exact:true})).toHaveAttribute("href","https://github.com/org/repo/pull/1#pullrequestreview-2");
  await expect(page.getByRole("img",{name:"desktop-proof.png"})).toBeVisible();
  await expect.poll(()=>page.getByRole("img",{name:"desktop-proof.png"}).evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBe(640);
  await expect(page.locator("#workflow-run figcaption")).toContainText("source aaaaaaaaaaaa");
  await page.getByText("Recorded workflow outputs",{exact:true}).click();
  await expect(page.locator("#workflow-run pre")).toBeVisible();
  await expect(page.getByText("Resident task: input required", {exact:false})).toBeVisible();
  const captureDirectory=process.env.FOUNDRY_SCREENSHOT_DIR;
  if(captureDirectory){await mkdir(captureDirectory,{recursive:true});for(const [name,width] of [["desktop",1280],["mobile",375]] as const){await page.setViewportSize({width,height:900});await page.locator("#workflow-run").evaluate(node=>node.scrollIntoView({block:"start"}));await page.screenshot({path:resolve(captureDirectory,`${name}-foundry-workflow.png`),fullPage:true});}}
  await expect(page).toHaveURL(
    `${app.origin}/workflows?workflow=issue-to-triage-resident&run=run-1`,
  );
  await expect(
    page.getByRole("button", {
      name: "Create issue subscription",
    }),
  ).toBeDisabled();
  await expect(page.getByLabel("Repository grant")).toHaveCount(0);
  completeBindings = true;
  await page.locator("#workflow-refresh").click();
  await expect(page.locator("#workflow-binding-limit")).toBeEmpty();
  await page.locator("#workflow-inputs").fill(JSON.stringify({"github-webhook.inputs.triageBinding": "triager", "github-webhook.inputs.engineerBinding": "engineer", "github-webhook.inputs.reviewerBinding": "binding", "github-webhook.inputs.settings": {model: "gpt-6-luna", connectionId: "connection", resource: "123"}}));
  await expect(page.locator("#workflow-save")).toBeEnabled();
  await page.locator("#workflow-save").click();
  await expect(page.locator("#workflow-notice")).toContainText("Subscription created");
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({createOnly: true, enabled: true, connectionId: "connection", resource: "123"});
  expect(saves[0]).not.toHaveProperty("grantId");
  bindingFailure = true;
  await page.reload();
  await expect(page.locator("#workflow-bindings")).toContainText("configuration is unavailable");
  await expect(page.locator("#workflow-runs button")).toHaveCount(1);
  await expect(page.locator("#workflow-run")).toContainText("Execution: dispatched");
  expect(saves).toHaveLength(1);
  expect(errors).toEqual([]);
});
