import {
  encodeMemberIds,
  memberIdsHeader,
} from "@ai-outfitter/app-sdk/members";
import { fulfillFrom, fulfillPlatformIdentity, routePlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import {
  evidenceFixture,
  fixtureItem,
  ids,
} from "./fixtures/revision-evidence";
import { withPlatform } from "./platform-document";

const pOrigin = "https://planning.alpha.localhost";
const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";

function memberDirectoryResponse(unavailable: boolean, memberIds: string[]) {
  return unavailable
    ? { status: 503, body: "Directory exceeds limit" }
    : {
        json: {
          items: memberIds.map((id) => ({
            id,
            name: id === alice ? "Alice" : "Bob",
          })),
        },
      };
}

// The manual-edit fixture has no linked Wiki host or assessed readiness.
function unlinkedContext(pathname: string) {
  const responses: Record<string, object> = {
    "/api/apps/planning/readiness": { projects: [] },
    "/api/apps/planning/work-context": {
      wiki: {
        installationId: "wiki",
        hostname: "wiki.alpha.localhost",
        writable: true,
      },
      types: [],
      nodes: [],
      requirements: [],
      criteria: [],
      edges: [],
      definitions: [],
    },
  };
  return responses[pathname];
}

for (const width of [1440, 390]) {
  test(`members manually plan shared projects and issues at ${width}px`, async ({
    page,
  }, info) => {
    let currentMember = alice;
    const memberIds = [alice, bob];
    let directoryUnavailable = false;
    const app = await appWorker(
      "planning",
      appArtifact(new URL("..", import.meta.url), "operational"),
      "planning",
      {
        workflowHost: (scope) => withPlatform(app, () => ({ userId: currentMember, organizationId: "org", role: currentMember === bob ? "owner" : "member" }), scope, {
          async call(operation, raw) {
            expect(scope.organizationId).toBe("org");
            expect(scope.installationId).toBe("planning");
            const action = operation.replace("entities.", "");
            const { installationId: _installation, ...input } = raw as Record<
              string,
              unknown
            >;
            const response = await app.call(
              `/api/internal/entities/v1/${action}`,
              {
                userId: currentMember,
                organizationId: "org",
                role: currentMember === bob ? "owner" : "member",
              },
              action === "types"
                ? { method: "GET" }
                : { method: "POST", body: input },
            );
            if (!response.ok)
              return {
                ok: false,
                status: response.status,
                message: await response.text(),
              };
            const value = await response.json();
            return {
              ok: true,
              value:
                action === "types"
                  ? (value as Record<string, unknown>[]).map((type) => ({
                      ...type,
                      installationId: "planning",
                      template: "planning",
                    }))
                  : value,
            };
          },
        }),
      },
    );
    const failures: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (e) => failures.push(e.message));
    page.on("console", (e) => {
      if (
        e.type() === "error" &&
        !(directoryUnavailable && /503/.test(e.text()))
      )
        failures.push(e.text());
    });
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: route each fixture API and canceled navigation explicitly.
    await page.route(`${pOrigin}/**`, async (route) => {
      const req = route.request(),
        pathname = new URL(req.url()).pathname;
      requests.push(pathname);
      if (pathname === "/api/apps/planning/use-cases/context") {
        await route.fulfill({
          json: {
            installationId: "wiki",
            hostname: "wiki.alpha.localhost",
            writable: true,
          },
        });
        return;
      }
      const unlinked = unlinkedContext(pathname);
      if (unlinked) {
        await route.fulfill({ json: unlinked });
        return;
      }
      if (pathname === "/api/apps/planning/products") {
        const graph = evidenceFixture();
        fixtureItem(graph.nodes, (node) => node.id === ids.project).source = {
          installationId: "planning",
          type: "project",
          id: new URL(page.url()).pathname.split("/").at(-1) ?? "",
        };
        await route.fulfill({
          json: {
            graph,
            wiki: {
              installationId: "wiki",
              hostname: "wiki.alpha.localhost",
              writable: true,
            },
          },
        });
        return;
      }
      if (pathname === "/api/platform/members") {
        await route.fulfill(
          memberDirectoryResponse(directoryUnavailable, memberIds),
        );
        return;
      }
      const response = await app.dispatch(
        "",
        new Request(req.url(), {
          redirect: "manual",
          method: req.method(),
          headers: {
            ...req.headers(),
            "x-outfitter-user": currentMember,
            "x-outfitter-organization": "org",
            "x-outfitter-installation": "planning",
            "x-outfitter-role": currentMember === bob ? "owner" : "member",
            ...(!directoryUnavailable
              ? { [memberIdsHeader]: encodeMemberIds(memberIds) }
              : {}),
          },
          body: req.postData() ?? undefined,
        }),
        {
          workflowHost: {
            installationId: "planning",
            organizationId: "org",
            userId: currentMember,
            packageHash: "fixture",
            phase: "interactive",
            expiresAt: Date.now() + 3600000,
          },
        },
      );
      // A successful delete navigates away while a prior request can still be
      // in flight; Playwright may already have disposed that route.
      try { await fulfillFrom(route, response); }
      catch (error) { if (!(error instanceof Error) || !/Route is already handled|Target page, context or browser has been closed/.test(error.message)) throw error; }
    });
    await routePlatformIdentity(page, pOrigin);
    try {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${pOrigin}/projects`);
      await expect(page.locator("#planning-notice")).toBeHidden();
      expect(requests).not.toContain("/api/platform/members");
      expect(requests).not.toContain("/api/apps/planning/readiness");
      expect(requests).not.toContain("/api/apps/planning");
      await expect(page.locator("#empty")).toBeVisible();
      await page
        .getByRole("button", { name: "New project", exact: true })
        .click();
      const project = page.locator("#project-editor");
      await project
        .getByLabel("Name", { exact: true })
        .fill("Launch manual planning");
      await project
        .getByLabel("Goals", { exact: true })
        .fill("Choose the most valuable next work");
      await project
        .getByLabel("User stories and acceptance criteria", { exact: true })
        .fill("As a member I can organize shared issues");
      await project
        .getByLabel("Draft press release", { exact: true })
        .fill("Our team can focus together");
      await project
        .getByLabel("Demo instructions and links", { exact: true })
        .fill("Create and complete a nested issue");
      await project
        .getByLabel("Demo results and evidence", { exact: true })
        .fill("Manual workflow demonstrated");
      await project
        .getByRole("button", { name: "Save project", exact: true })
        .click();
      await expect(page.locator("#project-name")).toBeVisible();
      await expect(page.locator("#project-select")).toBeHidden();
      await expect(page).toHaveURL(/\/projects\/[^/]+$/);
      const projectUrl = page.url();
      await expect(page.locator("#project-products a")).toHaveAttribute(
        "href",
        `/products/${ids.product}/revisions/${ids.revision}`,
      );
      await page.locator("details.project-actions > summary").click();
      await page
        .getByRole("link", { name: "All projects", exact: true })
        .click();
      await expect(page.locator("#project-detail")).toBeHidden();
      await expect(page.locator("#project-issues")).toBeHidden();
      await page.locator("#project-cards a").click();
      await expect(page).toHaveURL(projectUrl);
      const legacy = await app.dispatch(
        "",
        new Request(
          `${pOrigin}/?project=${new URL(projectUrl).pathname.split("/").at(-1)}`,
          {
            redirect: "manual",
            headers: {
              "x-outfitter-user": currentMember,
              "x-outfitter-organization": "org",
              "x-outfitter-installation": "planning",
              "x-outfitter-role": "member",
            },
          },
        ),
      );
      expect(legacy.status).toBe(302);
      expect(legacy.headers.get("location")).toBe(new URL(projectUrl).pathname);
      await page.goto(projectUrl);
      await page.getByText("Project documents and work details",{exact:true}).click();
      await expect(page).toHaveURL(projectUrl);
      await expect(page.locator("#project-name")).toHaveText(
        "Launch manual planning",
      );
      const editor = page.locator("#issue-editor");
      await page
        .getByRole("button", { name: "New issue", exact: true })
        .click();
      await editor
        .getByLabel("Title", { exact: true })
        .fill("Release the manual apps");
      await editor
        .getByRole("combobox", { name: "Assignee", exact: true })
        .selectOption(bob);
      await editor.getByLabel("Due date", { exact: true }).fill("2026-10-20");
      await editor
        .getByRole("button", { name: "Save issue", exact: true })
        .click();
      const stone = page.locator("article.planning-issue").filter({
        has: page.getByRole("heading", {
          name: "Release the manual apps",
          exact: true,
        }),
      });
      await expect(stone).toContainText("Bob");
      await page
        .getByRole("button", { name: "New issue", exact: true })
        .click();
      await editor
        .getByLabel("Title", { exact: true })
        .fill("Verify the project editor");
      await editor
        .getByRole("combobox", { name: "Category", exact: true })
        .selectOption("sand");
      await editor
        .getByRole("combobox", { name: "Parent issue", exact: true })
        .selectOption({ label: "Release the manual apps" });
      await editor
        .getByRole("button", { name: "Save issue", exact: true })
        .click();
      const child = page.locator("article.planning-issue").filter({
        has: page.getByRole("heading", {
          name: "Verify the project editor",
          exact: true,
        }),
      });
      await expect(child).toContainText("Sub-issue of Release the manual apps");
      await page.screenshot({
        path: info.outputPath(`planning-${width}.png`),
        fullPage: true,
      });
      await stone.getByRole("button", { name: "Edit", exact: true }).click();
      await editor
        .getByLabel("Title", { exact: true })
        .fill("Release the usable manual apps");
      await page.screenshot({
        path: info.outputPath(`planning-editor-${width}.png`),
        fullPage: true,
      });
      await editor
        .getByRole("button", { name: "Save issue", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Release the usable manual apps",
          exact: true,
        }),
      ).toBeVisible();
      await child
        .getByRole("button", { name: "Complete", exact: true })
        .click();
      await expect(child).toHaveCount(0);
      await page.getByLabel("Show completed").check();
      await expect(child).toBeVisible();
      await child.getByRole("button", { name: "Reopen", exact: true }).click();
      // A removed assignee survives an unrelated edit instead of being cleared.
      memberIds.splice(memberIds.indexOf(bob), 1);
      await page.reload();
      await page.getByText("Project documents and work details",{exact:true}).click();
      const renamed = page.locator("article.planning-issue").filter({
        has: page.getByRole("heading", {
          name: "Release the usable manual apps",
          exact: true,
        }),
      });
      await renamed.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(
        editor.getByRole("combobox", { name: "Assignee", exact: true }),
      ).toHaveValue(bob);
      await expect(
        editor.getByRole("option", { name: "Former member", exact: true }),
      ).toBeAttached();
      await editor
        .getByLabel("Description", { exact: true })
        .fill("Keep the original assignment");
      await editor
        .getByRole("button", { name: "Save issue", exact: true })
        .click();
      await expect(renamed).toContainText("Former member");
      directoryUnavailable = true;
      await page.reload();
      await page.getByText("Project documents and work details",{exact:true}).click();
      await expect(page.locator("#project-name")).toBeVisible();
      await expect(page.locator("#directory-notice")).toBeHidden();
      await expect(renamed).toContainText("Assigned member");
      await renamed
        .getByRole("button", { name: "Complete", exact: true })
        .click();
      await expect(renamed).toHaveCount(0);
      await page.getByLabel("Show completed").check();
      await expect(renamed).toContainText("Assigned member");
      await renamed
        .getByRole("button", { name: "Reopen", exact: true })
        .click();
      await expect(
        renamed.getByRole("button", { name: "Complete", exact: true }),
      ).toBeVisible();
      await renamed.getByRole("button", { name: "Edit", exact: true }).click();
      await editor
        .getByLabel("Description", { exact: true })
        .fill("Saved while the member directory is unavailable");
      await editor
        .getByRole("button", { name: "Save issue", exact: true })
        .click();
      await expect(renamed).toContainText(
        "Saved while the member directory is unavailable",
      );
      await page.screenshot({
        path: info.outputPath(`planning-directory-unavailable-${width}.png`),
        fullPage: true,
      });
      directoryUnavailable = false;
      memberIds.push(bob);
      currentMember = bob;
      await page.reload();
      await page.getByText("Project documents and work details",{exact:true}).click();
      await expect(
        page.getByRole("heading", {
          name: "Release the usable manual apps",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page
          .locator("#project-documents")
          .getByText("Choose the most valuable next work", { exact: true }),
      ).toBeVisible();
      expect(
        requests.some((path) =>
          /forerunner|resident|connectors|github/.test(path),
        ),
      ).toBe(false);
      expect(failures).toEqual([]);
      // The toolbar is outside the workspace root; its Delete button must
      // still open confirmation and remove an empty project.
      const disposable = await app.call("/api/apps/planning/projects", {userId:bob,organizationId:"org",role:"owner"}, {method:"POST",body:{name:"Disposable project"}});
      expect(disposable.status).toBe(200);
      const disposableProject = await disposable.json() as {id:string};
      await page.goto(`${pOrigin}/projects/${disposableProject.id}`);
      await page.getByText("Project documents and work details",{exact:true}).click();
      await expect(page.locator("#project-name")).toHaveText("Disposable project");
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button",{name:"Delete",exact:true}).click({noWaitAfter:true});
      await expect(page).toHaveURL(`${pOrigin}/projects`);
      await expect(page.locator("#project-cards")).not.toContainText("Disposable project");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      // Navigation after deletion may cancel in-flight routes; do not wait for
      // those canceled requests when disposing the fixture worker.
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await app.dispose();
    }
  });
}

test("Planning demo remains synthetic and read-only", async ({ page }) => {
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "demo"),
  );
  const requests: string[] = [];
  await page.route(`${pOrigin}/**`, async (route) => {
    if (await fulfillPlatformIdentity(route)) return;
    const request = route.request();
    requests.push(new URL(request.url()).pathname);
    const response = await app.dispatch(
      "",
      new Request(request.url(), {
        redirect: "manual",
        headers: {
          "x-outfitter-user": alice,
          "x-outfitter-organization": "demo",
          "x-outfitter-installation": "demo",
          "x-outfitter-role": "member",
        },
      }),
    );
    await fulfillFrom(route, response);
  });
  try {
    await page.goto(`${pOrigin}/projects`);
    await expect(page.locator("#project-detail")).toBeHidden();
    await page.locator("#project-cards a").click();
    await expect(page).toHaveURL(
      /\/projects\/00000000-0000-4000-8000-000000000001$/,
    );
    await expect(page.locator("#project-name")).toBeVisible();
    await page.getByText("Project documents and work details",{exact:true}).click();
    await expect(
      page.getByRole("group", {name:"Project maintenance"}).getByRole("button", { name: "Edit", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Ask Outfitter", exact: true })
      .click();
    const panel = page.getByRole("complementary", { name: "Outfitter chat" });
    await panel
      .getByRole("textbox", { name: "Message Outfitter" })
      .fill("What can I change?");
    await panel
      .getByRole("button", { name: "Send to Outfitter", exact: true })
      .click();
    await expect(
      panel.getByText(/This is a scripted, read-only example/),
    ).toBeVisible();
    expect(requests.filter((p) => p.startsWith("/api/"))).toEqual([]);
  } finally {
    await app.dispose();
  }
});
