import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import {
  fulfillFrom,
  fulfillPlatformIdentity,
} from "@ai-outfitter/app-test/playwright";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { parseDirectUpload } from "@ai-outfitter/app-sdk/storage";
import { test, expect } from "@playwright/test";
import { documents } from "../src/server/documents";
import { projectSlug } from "../src/lib/sections";
test("a researcher reopens a purchased part reference on the product page", async ({
  page,
}) => {
  const app = await appWorker(
    "workshop",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "part-photo",
  );
  const member = {
      userId: "designer",
      organizationId: "fixture",
      role: "member" as const,
    },
    origin = "https://workshop.outfitter.example";
  try {
    const graph = async (name: keyof typeof documents, variables: unknown) => {
      const r = await app.call("/api/internal/actions/v1/call", member, {
        method: "POST",
        body: {
          action:
            name === "VerifyWorkshopAssemblyFile"
              ? "graph.graphql"
              : "graph.mutate",
          input: { query: documentText(documents[name].document), variables },
        },
      });
      const result = (await r.json()) as any;
      expect(result.errors).toBeUndefined();
      return Object.values(result.data)[0] as any;
    };
    const project = (await (
      await app.call("/api/apps/workshop/projects", member, {
        method: "POST",
        body: { name: "Field instrument", example: "cube" },
      })
    ).json()) as any;
    const itemId = randomUUID(),
      rootId = randomUUID();
    const saved = await graph("UpdateWorkshopAssembly", {
      projectId: project.id,
      expectedRevision: project.revision,
      assembly: {
        rootId,
        items: [
          {
            id: rootId,
            kind: "assembly",
            name: "Instrument",
            number: "FIELD",
            revision: "A",
            uses: [{ id: randomUUID(), itemId, quantity: 1 }],
          },
          {
            id: itemId,
            kind: "cots",
            name: "MTDELE soil probe",
            number: "MTDELE",
            revision: "A",
          },
        ],
      },
    });
    const original = await readFile(
      new URL("../examples/mini-itx-case/exploded.png", import.meta.url),
    );
    const fileName = "purchase.png",
      digest = createHash("sha256").update(original).digest("hex");
    const target = { projectId: project.id, itemId, fileName },
      input = {
        ...target,
        expectedRevision: saved.revision,
        sha256: digest,
        bytes: original.length,
      };
    const ticket = parseDirectUpload(
      (await graph("UploadWorkshopAssemblyFile", { input })).upload.url,
    )!;
    await (await app.bucket("main")).put(ticket.key, original);
    const receipt = await graph("UploadWorkshopAssemblyFile", { input });
    expect(receipt.file.contentType).toBe("image/png");
    await page.route(origin + "/**", async (route) => {
      if (await fulfillPlatformIdentity(route)) return;
      const url = new URL(route.request().url());
      await fulfillFrom(
        route,
        await app.call(url.pathname + url.search, member),
      );
    });
    await page.goto(origin + "/projects/" + projectSlug(project));
    await page.reload();
    const image = page.locator("#reference-images img");
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.locator("#reference-images figcaption")).toHaveText(
      "MTDELE soil probe",
    );
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await app.dispose();
  }
});
