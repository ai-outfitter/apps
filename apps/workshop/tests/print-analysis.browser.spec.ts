import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import { projectSlug } from "../src/lib/sections";

// Tier 2: a sensor builder inspects the print plan for an enclosure around purchased electronics.
test("3D Print follows the selected model and distinguishes grouped and independent estimates", async ({ page }) => {
  test.setTimeout(120000);
  const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "operational"), "print-analysis");
  const member = { userId: "builder", organizationId: "print-analysis", role: "member" };
  const origin = "https://workshop.outfitter.example";
  try {
    const created = await (await app.call("/api/apps/workshop/projects", member, {
      method: "POST", body: { name: "Sunny print trial", example: "cube" },
    })).json() as { id: string; revision: number; name: string };
    const root = crypto.randomUUID();
    const cots = crypto.randomUUID();
    const names = ["Inner body", "Lid frame", "Snap backing", "Power tray", "Circuit shield"];
    const fileNames = ["open-inner-body", "open-lid-frame", "probe-snap-backing", "push-in-power-tray", "probe-circuit-shield"];
    const parts = names.map((name, index) => ({
      id: crypto.randomUUID(), number: `SNY-${index + 1}`, name, kind: "printed", revision: "A",
      geometry: {
        version: 1, units: "mm",
        features: [{ kind: "box", mode: "add", origin: [0, 0, 0], size: [15, 12, 2] }],
      },
    }));
    const assembly = {
      rootId: root,
      items: [
        { id: root, number: "SNY", name: "Sunny enclosure", kind: "assembly", revision: "A",
          uses: [...parts.map(part => part.id), cots].map((itemId, index) => ({
            id: crypto.randomUUID(), itemId, refdes: `U${index + 1}`, quantity: 1, position: [30 * index, 0, 0],
          })),
        },
        ...parts,
        { id: cots, number: "DEV", name: "Purchased devkit", kind: "cots", revision: "A" },
      ],
    };
    const projectPath = "/api/apps/workshop/projects/" + created.id;
    const saved = await app.call(projectPath + "/assembly", member, {
      method: "PUT", body: { expectedRevision: created.revision, assembly },
    });
    expect(saved.status).toBe(200);
    const project = await (await app.call(projectPath, member)).json() as typeof created;
    const pending = await (await app.call(projectPath + "/assembly?view=print", member)).json() as {
      revision: number;
      parts: { state: string }[];
    };
    expect(pending.revision).toBe(project.revision);
    expect(pending.parts.map(part => part.state)).toEqual(Array(5).fill("pending"));
    const profile = { printer: "Bambu Lab P2S", material: "ASA", slicer: "Bambu Studio", profileSha256: "a".repeat(64) };
    const evidence = parts.map((part, index) => ({
      itemId: part.id, name: part.name, fileName: `${fileNames[index]}.stl`, sha256: String(index + 1).repeat(64),
      state: "completed", profileSha256: profile.profileSha256,
      result: index === 4 ? { status: "warning", findings: [{ z_mm: 3.2, unsupported_area_mm2: 2.5 }] } : { status: "pass", findings: [] },
    }));
    const artifact = { fileName: "Sunny-open-fit-trial-P2S-ASA.3mf", sha256: "b".repeat(64) };
    const plates = [
      { index: 1, name: "Plate 1", state: "completed", members: evidence.slice(0, 3), durationSeconds: 5040.84, filamentGrams: 36.698, warnings: [], artifact },
      { index: 2, name: "Plate 2", state: "completed", members: evidence.slice(3), durationSeconds: 981.52, filamentGrams: 6.678, warnings: [], artifact },
    ].map(plate => ({ ...plate, ...profile, members: plate.members.map(({ itemId, sha256, fileName }) => ({ itemId, sha256, fileName, quantity: 1 })) }));
    let mode: "pending" | "grouped" | "roll-up" | "stale" = "grouped";
    await page.route(origin + "/**", async route => {
      if (await fulfillPlatformIdentity(route)) return;
      const url = new URL(route.request().url());
      if (url.pathname === projectPath + "/assembly" && url.searchParams.get("view") === "print" && mode !== "pending") {
        const estimates = evidence.map(part => ({ ...part, estimate: { ...profile, durationSeconds: 120, filamentGrams: 3 } }));
        return route.fulfill({ json: {
          revision: project.revision,
          parts: mode === "roll-up" ? estimates : evidence,
          plates: mode === "grouped" ? plates : mode === "stale" ? plates.map(plate => ({ ...plate, state: "stale" })) : [],
        } });
      }
      await fulfillFrom(route, await app.call(url.pathname + url.search, member));
    });

    const pageUrl = origin + "/projects/" + projectSlug(project);
    const print = page.getByRole("tab", { name: "3D Print", exact: true });
    const panel = page.getByRole("tabpanel", { name: "3D Print", exact: true });

    await page.goto(pageUrl);
    await print.click();
    await expect(panel).toContainText("Grouped plate estimate");
    await expect(panel).toContainText("2 plates · 1 h 40 min · 43.38 g");
    await expect(panel).toContainText("36.7 g");
    await expect(panel).toContainText("6.68 g");
    await expect(panel).toContainText("Z 3.2 mm · 2.5 mm² unsupported");
    await expect(panel).toContainText("Sunny enclosure / U5");
    await expect(panel).toContainText("probe-circuit-shield.stl");

    await page.goto(pageUrl + "?item=" + parts[4].id);
    await print.click();
    await expect(panel).toContainText("Printability warning");
    await expect(panel.getByRole("heading", { name: "Inner body" })).toHaveCount(0);
    await expect(panel).not.toContainText("Grouped plate estimate");
    await expect(panel).toContainText("Shared plate estimate");

    await page.goto(pageUrl + "?item=" + cots);
    await expect(page.locator("#project-name")).toContainText("Purchased devkit");
    await expect(print).toBeHidden();

    mode = "roll-up";
    await page.goto(pageUrl);
    await print.click();
    await expect(panel).toContainText("Independent part estimate roll-up");
    await expect(panel).toContainText("10 min · 15 g");

    mode = "stale";
    await page.reload();
    await print.click();
    await expect(panel).toContainText("Assembly estimate incomplete");
    await expect(panel).toContainText("Stale plate evidence · Plate 1");
    await expect(panel).not.toContainText("43.38 g");

    mode = "pending";
    await page.reload();
    await print.click();
    await expect(panel).toContainText("Assembly estimate incomplete");
    await expect(panel.getByText("Printability check pending", { exact: true })).toHaveCount(5);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
