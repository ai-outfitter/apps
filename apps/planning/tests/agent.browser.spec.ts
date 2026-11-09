import { copyFile, mkdir } from "node:fs/promises";
import { encodeMemberIds, memberIdsHeader } from "@ai-outfitter/app-sdk/members";
import { parseThreadRefKey } from "@ai-outfitter/app-sdk/threads";
import { operations, type WorkflowHostScope, type WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { threadTestHost } from "@ai-outfitter/app-test/threads";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, type Page, type Route, test } from "@playwright/test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { withPlatform } from "./platform-document";

// Planning's sidebar on the REAL platform thread service and browser routes
// (@ai-outfitter/app-test/threads), with Planning's and Software Foundry's built
// Workers answering provider callbacks. Inference is a scripted fixture model and
// Foundry's workflow records come from a host double validated against the
// platform's `workflow.read` schema: no live inference or workflow engine runs.

const origin = "https://planning.alpha.localhost";
const org = "org";
const roles: Record<string, string> = { alice: "member", bob: "owner" };
// Local, git-ignored evidence; SCREENSHOTS collects it elsewhere.
const screens = process.env.SCREENSHOTS ?? new URL("../test-results/screens/", import.meta.url).pathname;
const now = Date.now();
const runId = "11111111-1111-4111-8111-111111111111";
const archive = { ready: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", swept: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", old: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const run = operations["workflow.read"].output.parse({
  run: { id: runId, workflowId: "issue-to-merge-workspace", status: "failed", createdBy: "alice", createdAt: now - 3_600_000, updatedAt: now - 60_000 },
  inputs: { "triage.inputs.issue": { title: "Fix login redirect", number: 42 } },
  outputs: {
    "triage.outputs.result": { value: { ready: true, sessionArtifact: { id: archive.old, runId } }, complete: true },
    "implement.outputs.result": { value: { candidate: { number: 43 }, sessionArtifact: { id: archive.swept, runId } }, complete: false },
  },
  readiness: { run: "failed", steps: { triage: "complete", implement: "failed" } },
  attempts: [
    { id: "attempt-1", nodeId: "implement", state: "failed", createdAt: now - 3_000_000, updatedAt: now - 2_900_000, failure: "Checks failed: lint", sessionArtifact: { id: archive.ready, runId } },
    { id: "attempt-2", nodeId: "implement", state: "failed", createdAt: now - 2_000_000, updatedAt: now - 1_900_000, failure: "Checks failed: tests" },
  ],
})!;
const foundryHost = (calls: string[]): WorkflowHostStub => ({
  async call(operation, raw) {
    calls.push(operation);
    const input = raw as Record<string, unknown>;
    if (operation === "workflow.read") return { ok: true, value: input.id === runId ? run : null };
    if (operation === "workflow.activity")
      return { ok: true, value: { total: 1, items: [{ id: runId, workflowId: run.run.workflowId, status: run.run.status, createdBy: "alice", createdAt: run.run.createdAt, updatedAt: run.run.updatedAt, inputs: run.inputs }] } };
    if (operation === "artifacts.describe")
      return { ok: true, value: (input.ids as string[]).flatMap((id) => id === archive.ready ? [{ id, runId, state: "ready", expiresAt: now + 86_400_000, contentType: "application/gzip", filename: "session.tar.gz" }]
        : id === archive.old ? [{ id, runId, state: "ready", expiresAt: now - 1, contentType: "application/gzip", filename: "session.tar.gz" }] : []) };
    return { ok: false, status: 403, message: "Foundry history performs reads only" };
  },
});
const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const, finishReason: { unified: reason, raw: reason },
  usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
});
type Step = { text?: string; tools?: { name: string; input: unknown }[] };

async function routeTo(route: Route, handler: (request: Request) => Promise<Response>) {
  const req = route.request();
  const raw = req.postDataBuffer();
  const body = raw ? new Uint8Array(raw) : undefined;
  await fulfillFrom(route, await handler(new Request(req.url(), { method: req.method(), headers: req.headers(), ...(body && !["GET", "HEAD"].includes(req.method()) ? { body } : {}) })));
}

async function harness() {
  let member = "alice";
  let script: Step[] = [];
  const sent: { metadata: unknown }[] = [];
  const foundryCalls: string[] = [], artifactReads: string[] = [];
  const model = () => new MockLanguageModelV3({
    doStream: async () => {
      const step = script.shift() ?? { text: "Fixture inference: done." };
      return { stream: simulateReadableStream({ chunks: [
        ...(step.text ? [{ type: "text-start" as const, id: "t" }, { type: "text-delta" as const, id: "t", delta: step.text }, { type: "text-end" as const, id: "t" }] : []),
        ...(step.tools ?? []).map((tool, i) => ({ type: "tool-call" as const, toolCallId: `call-${crypto.randomUUID()}-${i}`, toolName: tool.name, input: JSON.stringify(tool.input) })),
        finish(step.tools?.length ? "tool-calls" : "stop"),
      ] }) };
    },
  });
  // eslint-disable-next-line prefer-const
  let threads: Awaited<ReturnType<typeof threadTestHost>>;
  const scopeFor = (userId: string, installationId: string): WorkflowHostScope => ({
    organizationId: org, installationId, userId, packageHash: "fixture", phase: "interactive", expiresAt: Date.now() + 3_600_000,
  });
  // Foundry lives in ai-outfitter/apps; the pinned released package is built by prepare-tests.
  const foundry = await appWorker("software-foundry", appArtifact(new URL("../../software-foundry", import.meta.url), "operational"), "foundry", {
    workflowHost: () => foundryHost(foundryCalls),
  });
  const planning = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "operational"), "planning", {
    workflowHost: (scope) => {
      const thread = threads.stub({ userId: scope.userId, organizationId: org, installationId: "planning", canAdminister: roles[scope.userId] === "owner" });
      const member = () => ({ userId: scope.userId, organizationId: org, role: roles[scope.userId] });
      return withPlatform(planning, member, scope, {
        async call(operation, raw) {
          if (operation.startsWith("threads.")) return thread.call(operation, raw);
          // Planning's own entity callbacks (Wiki links, discovery) stay app-local.
          const action = operation.replace("entities.", "");
          const { installationId: _i, ...input } = raw as Record<string, unknown>;
          const response = await planning.call(`/api/internal/entities/v1/${action}`, { userId: scope.userId, organizationId: org, role: roles[scope.userId] },
            action === "types" ? { method: "GET" } : { method: "POST", body: input });
          if (!response.ok) return { ok: false, status: response.status, message: await response.text() };
          const value = await response.json();
          return { ok: true, value: action === "types" ? (value as Record<string, unknown>[]).map((type) => ({ ...type, installationId: "planning", template: "planning" })) : value };
        },
      });
    },
  });
  threads = await threadTestHost({
    model,
    installations: ["planning", "foundry"],
    users: Object.keys(roles),
    organizations: [org],
    admins: ["alice"],
    provider: async ({ installationId, operation, input, principal }) => {
      if (operation === "prepare") sent.push({ metadata: (input as { entry: { metadata: unknown } }).entry.metadata });
      const app = installationId === "foundry" ? foundry : planning;
      const response = await app.call(`/api/internal/threads/v1/${operation}`, { userId: principal.userId, organizationId: org, role: roles[principal.userId] }, {
        method: "POST", body: input, headers: { [memberIdsHeader]: encodeMemberIds(Object.keys(roles)) }, workflowHost: scopeFor(principal.userId, installationId),
      });
      const text = await response.text();
      if (!response.ok) throw new Response(text, { status: response.status });
      return text ? JSON.parse(text) : null;
    },
  });
  const dispatch = (path: string, method = "GET", body?: unknown) =>
    planning.call(path, { userId: member, organizationId: org, role: roles[member] }, { method, ...(body === undefined ? {} : { body }), headers: { [memberIdsHeader]: encodeMemberIds(Object.keys(roles)) }, workflowHost: scopeFor(member, "planning") });
  async function attach(page: Page) {
    // Context-wide, so a download opened in a new tab takes the same routes.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one stub route per platform API the browser calls, read top to bottom.
    await page.context().route(`${origin}/**`, async (route) => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === "/api/platform/members") return route.fulfill({ json: { items: [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }] } });
      const principal = { userId: member, organizationId: org, installationId: "planning", canAdminister: roles[member] === "owner" };
      const artifact = /^(?:\/o\/[^/]+\/[^/]+)?\/api\/platform\/threads\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
      if (artifact) {
        // The platform's thread-scoped artifact route (src/pages/.../artifacts): the caller must read the
        // history thread through its provider (real service + Foundry Worker here); the object store is a fixture.
        artifactReads.push(url.pathname + url.search);
        const ref = parseThreadRefKey(decodeURIComponent(artifact[1]));
        const visible = ref && !("id" in ref) ? await threads.service.get(threads.principal(principal), ref) : null;
        if (!visible) return route.fulfill({ status: 404, body: "Artifact unavailable" });
        // The platform redirects to a short-lived object URL; the fixture answers with the bytes directly.
        return route.fulfill({ status: 200, contentType: "text/plain", body: "fixture archive bytes" });
      }
      if (url.pathname.includes("/api/platform/threads")) return routeTo(route, threads.browser(principal));
      if (url.pathname === "/fixture-archive-download") return route.fulfill({ contentType: "text/plain", body: "archive bytes" });
      const raw = req.postDataBuffer();
      const body = raw ? new Uint8Array(raw) : undefined;
      // A canonical organization mount reaches the same app routes.
      const appURL = new URL(req.url());
      appURL.pathname = appURL.pathname.replace(/^\/o\/org\/planning(?=\/|$)/, "") || "/";
      await fulfillFrom(route, await planning.dispatch("", new Request(appURL, {
        method: req.method(),
        headers: { ...req.headers(), "x-outfitter-user": member, "x-outfitter-organization": org, "x-outfitter-installation": "planning", "x-outfitter-role": roles[member],
          "x-outfitter-owner": `organization:${org}`, [memberIdsHeader]: encodeMemberIds(Object.keys(roles)),
          // As platform dispatch does: the page address the member actually requested (with its mount).
          "x-outfitter-page-url": req.url() },
        ...(body && !["GET", "HEAD"].includes(req.method()) ? { body } : {}),
      }), { workflowHost: scopeFor(member, "planning") }));
    });
  }
  return {
    planning, foundry, threads, dispatch, attach, sent, foundryCalls, artifactReads,
    script: (steps: Step[]) => { script = steps; },
    as: (userId: string) => { member = userId; },
    dispose: async () => { await planning.dispose(); await foundry.dispose(); },
  };
}

async function shot(page: Page, info: { outputPath(name: string): string }, name: string) {
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await mkdir(screens, { recursive: true });
  await copyFile(path, `${screens}/planning-${name}`).catch(() => {});
}

for (const [width, mount] of [[1440, ""], [390, "/o/org/planning"]] as const)
  test(`Planning conversations: contextual sends, reviewed proposals and a simple sidebar at ${width}px${mount ? " on the canonical organization mount" : ""}`, async ({ page }, info) => {
    const h = await harness();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await h.attach(page);
      await page.setViewportSize({ width, height: 1000 });
      const created = await h.dispatch("/api/apps/planning/projects", "POST", { name: "Launch", goals: "Saved goal" });
      expect(created.status, await created.clone().text()).toBe(200);
      const project = (await created.json()) as { id: string };
      await page.goto(`${origin}${mount}/projects`);
      await expect(page.locator("#project-cards a")).toHaveCount(1);
      // Open the project at its canonical address (the platform keeps the mount for app links).
      await page.goto(`${origin}${mount}/projects/${project.id}`);
      await expect(page.locator("#project-name")).toHaveText("Launch");
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.locator("#project-editor").getByLabel("Goals", { exact: true }).fill("Private draft");
      await page.getByRole("button", { name: "Ask Outfitter", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Outfitter chat" });
      const composer = panel.getByRole("textbox", { name: "Message Outfitter", exact: true });
      const send = async (text: string, steps: Step[]) => {
        h.script(steps);
        await composer.fill(text);
        await panel.getByRole("button", { name: "Send to Outfitter", exact: true }).click();
        await expect(composer).toHaveValue("").catch(async (error) => {
          await page.screenshot({ path: `${screens}/debug-send.png`, fullPage: true });
          throw new Error(`Send did not complete; panel shows: ${(await panel.innerText()).slice(0, 4000)}`, { cause: error });
        });
      };

      await test.step("contextual send creates a private conversation and a private proposal", async () => {
        await expect(panel.getByLabel("Share with the organization (cannot be changed later)")).toHaveCount(0);
        await send("Clarify this goal", [{ tools: [{ name: "amend_project", input: { goals: "Proposed launch goal" } }] }, { text: "Fixture inference: prepared a goal amendment for review." }]);
        await expect(panel.getByRole("heading", { name: "amend project" })).toBeVisible();
        await expect(panel.getByText("Fixture inference: prepared a goal amendment for review.")).toBeVisible();
        await expect(panel.getByText("Private to you")).toBeVisible();
        expect(h.sent.at(-1)?.metadata).toMatchObject({ "planning.page": { focus: { kind: "planning-project" } } });
        expect(JSON.stringify(h.sent.at(-1)?.metadata)).not.toContain("Private draft");
        await expect(page.locator("#project-documents")).toContainText("Saved goal");
      });
      await test.step("opted-in drafts travel with the message; approval applies exactly the reviewed fields", async () => {
        await panel.getByLabel("Include unsaved draft (not saved)").check();
        await send("Consider my draft too", [{ tools: [{ name: "amend_project", input: { goals: "Draft-based goal" } }] }, { text: "Fixture inference: second proposal." }]);
        expect(JSON.stringify(h.sent.at(-1)?.metadata)).toContain("Private draft");
        const proposal = panel.getByRole("region", { name: "Review proposed change" }).last();
        await proposal.getByLabel("Goals", { exact: true }).fill("Reviewed launch goal");
        await expect(proposal.getByRole("button", { name: "Approve changes", exact: true })).toBeDisabled();
        await proposal.getByRole("button", { name: "Save proposal edits" }).click();
        await expect(proposal.getByRole("button", { name: "Approve changes", exact: true })).toBeEnabled();
        await shot(page, info, `review-${width}.png`);
        await proposal.getByRole("button", { name: "Approve changes", exact: true }).click();
        await expect(panel.getByText("Approved changes saved.")).toBeVisible();
        await expect(page.locator("#project-documents")).toContainText("Reviewed launch goal");
      });
      await test.step("a stale page claim is refused with the draft kept; after reload the saved conversation is restored", async () => {
        // The open editor still shows revision 1, so the platform refuses the reply before any tool runs.
        h.script([{ text: "must not run" }]);
        await composer.fill("Ask about the old page");
        await panel.getByRole("button", { name: "Send to Outfitter", exact: true }).click();
        await expect(panel.getByText("The page changed. Reload before asking again; your draft is preserved.")).toBeVisible();
        await expect(composer).toHaveValue("Ask about the old page");
        await panel.getByRole("button", { name: "Close Outfitter chat" }).click();
        await page.reload();
        await page.getByRole("button", { name: "Ask Outfitter", exact: true }).click();
        await expect(panel.getByText("Fixture inference: second proposal.")).toBeVisible();
        await expect(panel.getByText("Approved changes saved.")).toBeVisible();
      });
      await test.step("a stale approval rolls back and keeps the proposal pending", async () => {
        await send("Prepare another amendment", [{ tools: [{ name: "amend_project", input: { goals: "Stale amendment" } }] }, { text: "Fixture inference: third proposal." }]);
        const board = (await (await h.dispatch("/api/apps/planning")).json()) as { projects: { id: string; revision: number }[] };
        const concurrent = await h.dispatch(`/api/apps/planning/projects/${board.projects[0].id}`, "PUT", { name: "Launch", goals: "Reviewed launch goal", demoResults: "Concurrent edit", revision: board.projects[0].revision });
        expect(concurrent.status).toBe(200);
        const stale = panel.getByRole("region", { name: "Review proposed change" }).last();
        await stale.getByRole("button", { name: "Approve changes", exact: true }).click();
        await expect(stale.getByRole("alert")).toContainText("Changed or invalid records");
        await expect(stale).toContainText("pending");
        const after = (await (await h.dispatch("/api/apps/planning")).json()) as { projects: { goals: string }[] };
        expect(after.projects[0].goals).toBe("Reviewed launch goal");
        // Reload so the page claims the current revision again.
        await panel.getByRole("button", { name: "Close Outfitter chat" }).click();
        await page.reload();
        await page.getByRole("button", { name: "Ask Outfitter", exact: true }).click();
        await expect(panel.getByText("Fixture inference: third proposal.")).toBeVisible();
      });
      await test.step("page assistants omit conversation management and workflow history", async () => {
        await expect(panel.getByRole("combobox", { name: /^Conversation/ })).toHaveCount(0);
        await expect(panel.getByRole("button", { name: /Workflow history|New chat|Start child conversation/ })).toHaveCount(0);
        // History remains a read-only source through the shared API; opening
        // the page assistant must not eagerly enumerate or fetch it.
        expect(h.foundryCalls).toEqual([]);
        const key = `p:foundry:software-foundry.workflow-run:${runId}`;
        const browser = h.threads.browser({ userId: "alice", organizationId: org, installationId: "planning" });
        const history = await browser(new Request(`${origin}/api/platform/threads/${encodeURIComponent(key)}/entries`));
        expect(history.ok).toBe(true);
        const text = JSON.stringify(await history.json());
        expect(text).toContain("Checks failed: lint");
        expect(text).toContain("Checks failed: tests");
        for (const [path, method, body] of [["/submissions", "POST", { submissionId: crypto.randomUUID(), text: "retry it" }], ["", "DELETE", undefined], ["", "PATCH", { title: "x" }]] as const) {
          const response = await browser(new Request(`${origin}/api/platform/threads/${encodeURIComponent(key)}${path}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }));
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(response.status).toBeLessThan(500);
        }
        expect(h.foundryCalls.every((op) => ["workflow.read", "workflow.activity", "artifacts.describe"].includes(op))).toBe(true);
      });
      await test.step("the sidebar offers no conversation deletion; a platform administrator's Debug shows what the model receives", async () => {
        await expect(panel.getByRole("button", { name: "Delete conversation" })).toHaveCount(0);
        await shot(page, info, `sidebar-${width}.png`);
        // Debug shows the model's view in the panel and links the root /debug/session page
        // for this conversation; its inspection is what the model receives.
        const debug = panel.getByRole("button", { name: "Debug" });
        await debug.click();
        await expect(panel.getByRole("region", { name: "Debug" })).toBeVisible();
        const debugLink = panel.getByRole("link", { name: /Open full session debug/ });
        await expect(debugLink).toHaveAttribute("href", /^\/debug\/session\?thread=[0-9a-f-]{36}$/);
        const threadId = new URL((await debugLink.getAttribute("href")) ?? "", origin).searchParams.get("thread");
        const inspected = await h.threads.browser({ userId: "alice", organizationId: org, installationId: "planning" })(new Request(`${origin}/api/platform/threads/${threadId}/inspect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metadata: null }) }));
        expect(inspected.status).toBe(200);
        const inspection = await inspected.json() as { model: { model: string; provider: string }; turn: { system: string; tools: { name: string }[]; context: unknown } };
        expect(inspection.model.model).toBe("fixture-model");
        expect(JSON.stringify(inspection.model)).toContain("Fixture provider");
        // The debug page prepares a page-less send: Planning falls back to the conversation's project.
        expect(JSON.stringify(inspection.turn.context)).toContain("Launch");
        expect(inspection.turn.system).toContain("You are Outfitter helping with Planning.");
        expect(inspection.turn.tools.map((tool) => tool.name)).toContain("amend_project");
        await debug.click();
        await expect(panel.getByRole("region", { name: "Debug" })).toHaveCount(0);
      });
      await test.step("another member sees neither the private conversation nor its proposals", async () => {
        await panel.getByRole("button", { name: "Close Outfitter chat" }).click();
        h.as("bob");
        await page.reload();
        await page.getByRole("button", { name: "Ask Outfitter", exact: true }).click();
        await expect(composer).toBeVisible();
        await expect(panel.getByText("Fixture inference: opened two follow-ups.")).toHaveCount(0);
        await expect(panel.getByRole("combobox", { name: /^Conversation/ })).toHaveCount(0);
        await expect(panel.getByText("Fixture inference: third proposal.")).toHaveCount(0);
        await expect(panel.getByRole("link", { name: "Debug" })).toHaveCount(0);
        await shot(page, info, `other-member-${width}.png`);
      });
      await test.step("a page that selects nothing talks in the Planning-wide thread", async () => {
        h.as("alice");
        await page.goto(`${origin}${mount}/operations`);
        // The panel stays open across pages (the outfitter-ui cookie).
        await expect(panel.getByText("Project intake")).toBeVisible();
        await send("Here are today's meeting notes: ship the launch checklist.", [{ text: "Fixture inference: read the notes across projects." }]);
        await expect(panel.getByText("Fixture inference: read the notes across projects.")).toBeVisible();
        expect(h.sent.at(-1)?.metadata).toMatchObject({ "planning.page": { focus: { kind: "planning-board" } } });
      });
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await page.context().unrouteAll({ behavior: "wait" });
      await page.close();
      await h.dispose();
    }
  });
