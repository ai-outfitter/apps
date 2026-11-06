import { expect, test } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { routeReadOnly } from "@ai-outfitter/app-test/playwright";
const slug = "software-foundry";
test(`${slug} uses the normal shell with fixture data and no API calls`, async ({
  page,
}) => {
  const worker = await appWorker(
    slug,
    appArtifact(new URL("..", import.meta.url), "demo"),
  );
  const origin = `https://${slug}.outfitter.example`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeReadOnly(page, origin, worker);
  try {
    await page.goto(`${origin}/`);
    await expect(page.locator("body")).not.toContainText(
      /\bdemo\b|\bstaged\b|sample data/i,
    );

    // The dashboard opens on the highest priority project.
    await expect(page.locator(".header-title")).toHaveText("SF / NORTHSTAR");
    await expect(page.locator("#project option")).toHaveText([
      "NORTHSTAR",
      "DESIGN SYSTEM",
    ]);
    await expect(
      page.locator('[data-metric="merged"] .stat-value'),
    ).not.toHaveText("–");
    await expect(page.locator("#dashboard-milestones-heading")).toHaveText(
      "NORTHSTAR milestones",
    );
    // Ranked milestones first, then the rest by due date, across repos.
    await expect(
      page.locator("#dashboard-milestones .milestone-title"),
    ).toHaveText([
      "Accessible command menu",
      "Merge queue for stacks",
      "Design tokens everywhere",
      "Faster cold starts",
      "Audit log export",
    ]);
    // Each milestone shows its press release; rank, repository and due
    // date are implicit.
    await expect(
      page.locator("#dashboard-milestones .press-release").first(),
    ).toContainText("run any Northstar command from the keyboard");
    await expect(page.locator("#dashboard-milestones")).not.toContainText(
      "northstar/",
    );
    await expect(
      page
        .getByRole("region", {
          name: "Project milestones, most important first",
        })
        .locator("th"),
    ).toHaveText(["Milestone", "Progress"]);
    await expect(page.locator(".rank-move")).toHaveCount(0);
    await expect(page.locator("#project-milestones a")).toHaveCount(3);
    await page.getByRole("link", { name: "Issues", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Issues", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#issues")).toContainText(
      "Clarify keyboard navigation",
    );
    await expect(page.locator("#issues button[data-control]")).toHaveCount(0);
    await page.getByRole("link", { name: "Governance", exact: true }).click();
    await expect(page.locator('[data-document="CODEOWNERS"] a')).toHaveText(
      "CODEOWNERS",
    );
    await expect(
      page.locator('[data-document="CODEOWNERS"] a'),
    ).toHaveAttribute("href", /\/.github\/CODEOWNERS$/);
    await expect(
      page.locator('[data-rule="Pull requests required"] input'),
    ).toBeChecked();
    await page
      .locator("#governance-repository")
      .selectOption("northstar/interface");
    await expect(
      page.locator('[data-document="DESIGN.md"] input'),
    ).not.toBeChecked();
    await expect(
      page.locator('[data-rule="Pull requests required"] input'),
    ).not.toBeChecked();
    const mergeQueue = page.locator('[data-rule="Merge queue required"]');
    await expect(mergeQueue).toHaveAttribute(
      "data-status",
      "merge-group-missing",
    );
    await expect(
      page.locator('[data-policy="draft-pull-requests"] input'),
    ).toBeChecked();
    // The fixture run waits on an admin's bypass merge; demo never runs it.
    const setup = page.locator("#governance-setup");
    await expect(setup.locator('[data-step="merge"]')).toContainText("bypass");
    await expect(
      setup.getByRole("button", { name: "Complete all", exact: true }),
    ).toBeDisabled();
    // Demo repositories have not opted into agents: an informational row,
    // and with a setup run open no separate install action is offered.
    await expect(page.locator('[data-rule="Agent workflows"]')).toHaveAttribute(
      "data-status",
      "info",
    );
    await expect(
      setup.getByRole("button", { name: "Complete all with agents" }),
    ).toHaveCount(0);
    await page.goto(`${origin}/settings`);
    await expect(page.locator("#repository-summary")).toContainText(
      "2 available repositories",
    );
    await expect(page.locator("[data-settings]:visible")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await worker.dispose();
  }
});
