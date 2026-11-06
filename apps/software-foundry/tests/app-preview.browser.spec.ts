import { previewPolicy } from "../scripts/preview.mjs";
import { test, expect } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
let worker: Awaited<ReturnType<typeof appWorker>>;
test.beforeAll(async () => {
  worker = await appWorker(
    "software-foundry",
    appArtifact(new URL("../", import.meta.url), "operational"),
  );
});
test.afterAll(async () => {
  await worker?.dispose();
});

test("one operational Foundry bundle switches demo and GitHub governance data", async ({
  page,
}) => {
  const { appPreview } = await import("@ai-outfitter/server/preview");
  let connected = true;
  let bootstraps = 0;
  const view = () => ({
    connected,
    repositoryAccess: connected,
    readiness: { "ai-outfitter/webapp": { status: "ready" } },
    repositories: [{ name: "ai-outfitter/webapp" }],
    scopes: [{ repositories: ["ai-outfitter/webapp"], mode: "triage" }],
  });
  const check = () => ({
    repository: "ai-outfitter/webapp",
    defaultBranch: "main",
    revision: "b".repeat(40),
    checkedAt: Date.now(),
    documents: ["AGENTS.md", "CONTRIBUTING.md", "DESIGN.md", "CODEOWNERS"].map(
      (name) => ({ name, status: "present", path: name }),
    ),
  });
  const platform = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/admin") return Response.json({ admin: true });
      if (url.pathname === "/api/plugins/github") return Response.json(view());
      if (url.pathname.startsWith("/api/apps/software-foundry/")) bootstraps++;
      if (url.pathname === "/api/plugins/github/governance")
        return Response.json(check());
      return new Response("Not found", { status: 404 });
    },
  };
  const app = {
    fetch: (request: Request) => worker.fetch(request),
  };
  const preview = appPreview(
    platform,
    app,
    "software-foundry",
    "test-revision",
    [],
    undefined,
    previewPolicy,
  );
  const { createServer } = await import("node:http");
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(
      `http://${incoming.headers.host}${incoming.url}`,
      {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      },
    );
    const response = await preview.fetch(
      request,
      { PREVIEW_INTERNAL: "true" },
      {},
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    await page.goto(`http://127.0.0.1:${address.port}/governance`);

    await expect(
      page.getByRole("button", { name: "GitHub", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("#governance-repository")).toHaveValue(
      "ai-outfitter/webapp",
    );
    await expect(page.locator("#governance-snapshot")).toContainText("bbbbbbb");
    // GitHub mode forwards platform reads only; the app's bootstrap needs the
    // workflow host, so the governance check comes from the platform route.
    expect(bootstraps).toBe(0);
    await page.getByRole("button", { name: "Demo", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Demo", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("#governance-snapshot")).not.toContainText(
      "bbbbbbb",
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Demo", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "GitHub", exact: true }).click();
    await expect(page.locator("#governance-snapshot")).toContainText("bbbbbbb");
    connected = false;
    await page.context().clearCookies();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Demo", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("#governance-snapshot")).not.toContainText(
      "bbbbbbb",
    );
    connected = true;
    await page.reload();
    await expect(
      page.getByRole("button", { name: "GitHub", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("#governance-snapshot")).toContainText("bbbbbbb");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

for (const width of [1440, 390]) {
  test(`Foundry's operational package uses scripted assistance in a read-only preview at ${width}px`, async ({
    page,
  }) => {
    const { routeReadOnly } = await import("@ai-outfitter/app-test/playwright");
    const origin = "https://software-foundry.alpha.localhost";
    await routeReadOnly(page, origin, {
      fetch: async (input) =>
        previewPolicy.decorate(await worker.fetch(input), "demo", undefined),
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin);
    await page.locator("[data-agent-sidebar-toggle]").click();
    const panel = page.locator("#software-foundry-agent");
    await expect(panel.getByText(/read-only demo/i)).toBeVisible();
    await panel.getByRole("textbox").fill("What can I review here?");
    await panel.getByRole("textbox").press("Enter");
    await expect(
      panel.getByText(/No inference ran and no records changed/),
    ).toBeVisible();
    await expect(
      panel.getByText("Workflow history", { exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
