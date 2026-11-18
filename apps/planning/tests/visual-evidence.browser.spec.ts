import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { capture } from "./fixtures/visual-evidence";
import {
  canonicalReleaseProject,
  projectReleasesFixture,
  releaseId,
  releaseProviders,
} from "./fixtures/project-releases";
const origin = "https://planning.example";
for (const width of [1440, 390])
  test(`visual evidence walkthrough and downloads ${width}`, async ({
    browser,
  }, info) => {
    const graph = projectReleasesFixture();
    const current = graph.nodes.find((n) => n.id === releaseId(3))!;
    const imagePath = process.env.EVIDENCE_CAPTURE_IMAGE;
    const videoPath = process.env.EVIDENCE_CAPTURE_VIDEO;
    const image = imagePath
      ? await readFile(imagePath)
      : Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          "base64",
        );
    const video = videoPath ? await readFile(videoPath) : undefined;
    const hash = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    const body = structuredClone(capture);
    body.steps[0].media[0].sha256 = hash(image);
    if (process.env.EVIDENCE_CAPTURE_MANIFEST) {
      const captured = JSON.parse(
        await readFile(process.env.EVIDENCE_CAPTURE_MANIFEST, "utf8"),
      );
      body.source.commit = captured.sourceAtCapture.commit;
      body.source.dirty = captured.sourceAtCapture.dirty;
      body.capturedAt = new Date(captured.capturedAt).toISOString();
      body.limitations = captured.limitations;
    }
    const videoStep = {
      id: "movie",
      title: "Watch the recorded walkthrough",
      description:
        "A captured application walkthrough. Concept films shown inside the app are demonstration content.",
      media: video
        ? [
            {
              id: "film",
              kind: "video",
              caption: "Recorded app walkthrough",
              href: "/capture.mp4",
              downloadHref: "/capture.mp4?download=1",
              sha256: hash(video),
              contentType: "video/mp4",
              owner: "planning",
            },
          ]
        : [],
    };
    current.body = JSON.stringify({
      ...body,
      steps: [
        ...body.steps,
        videoStep,
        {
          id: "missing",
          title: "Uncaptured state",
          description: "This state still needs evidence.",
          media: [],
        },
      ],
    });
    let reads = 0;
    const owner = { userId: "owner", organizationId: "org", role: "owner" };
    const app = await appWorker(
      "planning",
      appArtifact(new URL("..", import.meta.url), "operational"),
      "planning",
      {
        workflowHost: () => ({
          async call(operation, raw) {
            const input = raw as any;
            if (operation === "entities.types")
              return { ok: true, value: releaseProviders() };
            if (operation === "entities.get")
              return input.installationId === "planning" &&
                input.id === releaseId(9)
                ? { ok: true, value: canonicalReleaseProject }
                : { ok: false, status: 404, message: "Not found" };
            if (operation === "entities.list") return { ok: true, value: [] };
            if (
              operation === "actions.call" &&
              input.action === "graph.query"
            ) {
              reads++;
              return {
                ok: true,
                value: await queryGraph(
                  {
                    version: 1,
                    installationId: "wiki",
                    ...graph,
                    selection: null,
                    truncated: false,
                    missingTypes: [],
                  } as never,
                  input.input,
                ),
              };
            }
            throw new Error(
              `Unexpected critical-path call: ${operation} ${input.action}`,
            );
          },
        }),
      },
    );
    const context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width, height: 1000 },
      }),
      page = await context.newPage();
    await page.route(`${origin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/capture.png")
        return route.fulfill({ contentType: "image/png", body: image });
      if (url.pathname === "/capture.mp4" && video)
        return route.fulfill({
          contentType: "video/mp4",
          body: video,
          headers: url.searchParams.has("download")
            ? { "content-disposition": "attachment; filename=demo.mp4" }
            : {},
        });
      if (
        url.pathname.includes("/api/apps/planning/agent") ||
        url.pathname.includes("use-cases/context")
      )
        return route.fulfill({ status: 503, body: "Unavailable in capture" });
      return fulfillFrom(
        route,
        await app.call(url.pathname + url.search, owner, {
          workflowHost: {
            ...owner,
            installationId: "planning",
            packageHash: "fixture",
            phase: "interactive",
            expiresAt: Date.now() + 3600000,
          },
        }),
      );
    });
    const path = `/projects/${releaseId(9)}/evidence`;
    try {
      const timings: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await page.goto(origin + path);
        await expect(
          page.getByRole("heading", { name: body.title, exact: true }),
        ).toBeVisible();
        timings.push(performance.now() - start);
      }
      expect(reads).toBe(5); // One graph selection per page; no full graph or duplicate context reads.
      await expect(page.locator(".evidence-media img")).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`evidence-walkthrough-${width}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Next", exact: true }).click();
      if (video) {
        await expect(page.locator("video")).toBeVisible();
        await page.locator("video").evaluate(async (v: HTMLVideoElement) => {
          v.muted = true;
          await v.play();
        });
        await expect
          .poll(() =>
            page
              .locator("video")
              .evaluate((v: HTMLVideoElement) => v.currentTime),
          )
          .toBeGreaterThan(0.3);
        await page.screenshot({
          path: info.outputPath(`evidence-video-${width}.png`),
          fullPage: true,
        });
        const downloading = page.waitForEvent("download");
        await page.getByRole("link", { name: "Download video" }).click();
        const download = await downloading;
        expect(hash(await readFile((await download.path())!))).toBe(
          hash(video),
        );
      }
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(
        page.getByText("No media captured for this step."),
      ).toBeVisible();
      await page.getByRole("button", { name: "Gallery", exact: true }).click();
      await expect(page.locator(".evidence-gallery")).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`evidence-gallery-${width}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const prior = {
        ...current,
        id: releaseId(30),
        title: "Earlier capture",
        body: JSON.stringify({ ...body, title: "Earlier capture" }),
      };
      graph.nodes.push(prior);
      graph.edges.push({
        ...graph.edges[1],
        id: releaseId(31),
        fromId: prior.id,
      });
      current.body = JSON.stringify({
        ...body,
        steps: [
          {
            ...body.steps[0],
            before: {
              bundle: { id: prior.id, revision: prior.revision },
              stepId: body.steps[0].id,
            },
          },
        ],
      });
      await page.goto(`${origin}${path}?bundle=${current.id}`);
      await page
        .getByRole("button", { name: "Before / after", exact: true })
        .click();
      await expect(
        page.getByText("Earlier capture · record revision 1", { exact: true }),
      ).toBeVisible();
      prior.revision = 2;
      await page.goto(`${origin}${path}?bundle=${current.id}`);
      await page
        .getByRole("button", { name: "Before / after", exact: true })
        .click();
      await expect(
        page.getByText("The exact earlier capture is not available here.", {
          exact: false,
        }),
      ).toBeVisible();
      graph.nodes.splice(graph.nodes.indexOf(prior), 1);
      graph.edges.pop();
      current.body = JSON.stringify({
        ...body,
        steps: [
          {
            id: "broken",
            title: "Missing media",
            description: "Retain the explanation",
            media: [{ ...body.steps[0].media[0], href: "/missing-image.png" }],
          },
        ],
      });
      await page.goto(origin + path);
      await expect(
        page.getByText(
          "This capture is unavailable. Its description and source are retained.",
        ),
      ).toBeVisible();
      current.body = JSON.stringify({ ...body, steps: [] });
      await page.goto(origin + path);
      await expect(
        page.getByText("No visual evidence captured.", { exact: true }),
      ).toBeVisible();
      expect((await app.call(path)).status).toBe(401);
      expect(
        (await page.goto(`${origin}${path}?bundle=${releaseId(6)}`))?.status(),
      ).toBe(404);
      await writeFile(
        info.outputPath("timings.json"),
        JSON.stringify({ timings, graphReadsPerPage: 1 }, null, 2),
      );
      await info.attach("warm-page-timings.json", {
        body: JSON.stringify({
          timings,
          graphReadsPerPage: 1,
          environment: "local worker with seeded graph; not production latency",
        }),
        contentType: "application/json",
      });
    } finally {
      await context.close();
      await app.dispose();
    }
  });
