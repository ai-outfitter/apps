import { openAccountMenuFor } from "@ai-outfitter/app-test/playwright";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { defined } from "@ai-outfitter/app-test/assertions";
import { expect, test } from "@playwright/test";
import { projectPackage } from "../src/lib/package";
import { makeProject, type Project, ProjectSchema } from "../src/lib/project";
import { boxPlan } from "../src/model/cad-plan";

let server: Server;
let origin: string;
let record: Project | undefined;

import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";

let worker: Awaited<ReturnType<typeof appWorker>>;
test.beforeAll(async () => {
  worker = await appWorker(
    "workshop",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  function agentPlan(plate: boolean, size: number) {
    return plate
      ? {
          version: 1,
          units: "mm",
          features: [
            {
              kind: "box",
              mode: "add",
              origin: [-40, -25, 0],
              size: [80, 50, 20],
            },
            {
              kind: "cylinder",
              mode: "cut",
              base: [0, 0, -1],
              radius: 5,
              height: 22,
              axis: "z",
            },
          ],
        }
      : boxPlan(size, size, size);
  }
  function agentIteration(
    message: string,
    plate: boolean,
    size: number,
    revision: number,
  ) {
    return {
      id: crypto.randomUUID(),
      prompt: message,
      rationale: plate
        ? "An 80 × 50 × 20 mm plate with a through-hole."
        : `A ${size} mm cube study.`,
      dimensions: plate
        ? { width: 80, depth: 50, height: 20 }
        : { width: size, depth: size, height: size },
      at: new Date().toISOString(),
      revision,
    };
  }
  function nextAgentProject(input: {
    message: string;
    projectId?: string;
    revision?: number;
  }) {
    const base = input.projectId
      ? defined(record, "project record")
      : makeProject("cube");
    const plate = /mounting plate/i.test(input.message);
    const size = input.projectId ? 50 : 40;
    const revision = base.revision + 1;
    return ProjectSchema.parse({
      ...base,
      name: plate ? "Mounting plate" : base.name,
      revision,
      params: {
        design: "custom",
        width: plate ? 80 : size,
        depth: plate ? 50 : size,
        height: plate ? 20 : size,
        wall: 2.4,
      },
      cadPlan: agentPlan(plate, size),
      iterations: [
        ...base.iterations,
        agentIteration(input.message, plate, size, revision),
      ],
    });
  }
  async function agentResponse(req: IncomingMessage, res: ServerResponse) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()) as {
      message: string;
      projectId?: string;
      revision?: number;
    };
    if (
      input.projectId &&
      (input.projectId !== record?.id || input.revision !== record.revision)
    ) {
      res.writeHead(409).end("Project changed");
      return;
    }
    record = nextAgentProject(input);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ project: record }));
    return;
  }
  async function requestJSON(req: IncomingMessage) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async function projectResponse(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) {
    if (req.method === "POST") {
      record = makeProject((await requestJSON(req)).example);
    }
    if (req.method === "PUT") {
      record = {
        ...(await requestJSON(req)),
        revision: defined(record, "project record").revision + 1,
      };
    }
    if (url.pathname.endsWith("/package")) {
      res.setHeader("Content-Type", "application/zip");
      res.end(projectPackage(defined(record, "project record")));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.method === "GET" && url.pathname === "/api/apps/workshop/projects"
          ? record
            ? [record]
            : []
          : record,
      ),
    );
    return;
  }
  server = createServer(async (req, res) => {
    const url = new URL(defined(req.url, "request url"), "http://localhost");
    if (url.pathname === "/api/apps/workshop/agent")
      return agentResponse(req, res);
    if (url.pathname.startsWith("/api/apps/workshop/projects"))
      return projectResponse(req, res, url);
    const response = await worker.fetch(
      new URL(defined(req.url, "request url"), origin).href,
    );
    res.writeHead(response.status, {
      ...Object.fromEntries(response.headers),
      ...(url.pathname.startsWith("/_astro/")
        ? {
            "Cache-Control": "private, no-cache",
            ...(url.pathname.endsWith(".js")
              ? {
                  "Content-Security-Policy":
                    "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self'",
                }
              : {}),
          }
        : {}),
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await worker?.dispose();
});
test("Workshop compiled app creates, saves, renders CAD and exports through the shared shell", async ({
  page,
}, testInfo) => {
  record = undefined;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.locator('[data-example="holder"]').first().click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+-[0-9a-f]{12}$/);
  await expect(page.getByLabel("Project name", { exact: true })).toBeVisible();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Workshop browser proof");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toContainText("Saved");
  // The slug follows the new name; the ID at its end still finds the project.
  await expect(page).toHaveURL(/\/projects\/workshop-browser-proof-[0-9a-f]{12}$/);
  await page.reload();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Workshop browser proof",
  );
  await page.locator("#sidebar").getByRole("link", { name: "Design workbench", exact: true }).click();
  await expect(page.locator("#geometry-status")).toContainText(
    "geometry ready",
    { timeout: 60000 },
  );
  await page.screenshot({
    path: testInfo.outputPath("workshop-design.png"),
    fullPage: true,
  });
  const download = page.waitForEvent("download");
  await page.locator("#step").click();
  const step = await download;
  expect(step.suggestedFilename()).toMatch(/\.step$/);
  expect(
    await readFile(defined(await step.path(), "step path"), "utf8"),
  ).toContain("ISO-10303-21");
  for (const [example, feature] of [
    ["button", "Side button opening"],
    ["sensor", "Vent slots and four mounting posts"],
  ]) {
    await page.locator("#sidebar").getByRole("link", { name: "All projects", exact: true }).click();
    await page.locator(`[data-example="${example}"]`).click();
    await expect(page.locator("#project-title")).not.toHaveText("Workshop browser proof");
    await page.locator("#sidebar").getByRole("link", { name: "Design workbench", exact: true }).click();
    await expect(page.locator("#geometry-status")).toContainText(
      "geometry ready",
      { timeout: 60000 },
    );
    await expect(page.getByText(feature, { exact: false })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await openAccountMenuFor(page, "Workshop settings");
  await page.getByRole("link", { name: "Workshop settings", exact: true }).click();
  await expect(
    page.getByText("Shared organization projects", { exact: false }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("Workshop creates and refines a model from the mobile page", async ({
  page,
}, testInfo) => {
  record = undefined;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page
    .getByLabel("What should we make?")
    .fill("Make a solid cube 40 mm on each side");
  await page.getByRole("button", { name: "Create model" }).click();
  await expect(page.locator("#agent-status")).toContainText("Saved revision 1");
  await expect(page.locator("#geometry-status")).toContainText(
    "geometry ready",
    { timeout: 60000 },
  );
  await expect(page.locator('#dimensions [name="width"]')).toHaveValue("40");
  await page
    .getByLabel("What should we make or change?")
    .fill("Increase each side by 10 mm");
  await page.getByRole("button", { name: "Update model" }).click();
  await expect(page.locator("#agent-status")).toContainText("Saved revision 2");
  await expect(page.locator('#dimensions [name="width"]')).toHaveValue("50");
  await expect(page.locator("#agent-history li")).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath("workshop-mobile-design.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("Workshop renders and exports a generated plate with a through-hole", async ({
  page,
}) => {
  record = undefined;
  await page.goto(origin);
  await page
    .getByLabel("What should we make?")
    .fill("Make an 80 by 50 by 20 mm mounting plate with a 10 mm through-hole");
  await page.getByRole("button", { name: "Create model" }).click();
  await expect(page.locator("#agent-status")).toContainText("Saved revision 1");
  await expect(page.locator("#geometry-status")).toContainText(
    "78.4 cm³ · geometry ready",
    { timeout: 60000 },
  );
  await expect(page.locator('#dimensions [name="width"]')).toHaveValue("80");
  await expect(page.locator('#dimensions [name="depth"]')).toHaveValue("50");
  await expect(page.locator('#dimensions [name="height"]')).toHaveValue("20");
  const download = page.waitForEvent("download");
  await page.locator("#step").click();
  const step = await download;
  expect(
    await readFile(defined(await step.path(), "step path"), "utf8"),
  ).toContain("ISO-10303-21");
});
