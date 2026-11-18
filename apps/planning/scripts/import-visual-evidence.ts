/** Convert an existing local capture manifest without uploading or changing graph state.
 * Usage: node --import tsx apps/planning/scripts/import-visual-evidence.ts manifest.json mapping.json
 * mapping: {project,productRevision,title,summary,repository,assetBase,video:{href,owner},steps:[{path,title,description}]}
 * Output is a validated SubmitEvidence.bundle; the caller chooses its stable key and existing batch.
 */
import { readFile } from "node:fs/promises";
import { visualEvidenceSchema } from "@ai-outfitter/app-sdk/visual-evidence";
import { z } from "zod";
const mappingSchema = z.object({
  project: visualEvidenceSchema.shape.project,
  productRevision: visualEvidenceSchema.shape.productRevision,
  title: z.string(),
  summary: z.string(),
  repository: z.url(),
  assetBase: z.url(),
  video: z.object({ href: z.string(), owner: z.string() }),
  steps: z.array(
    z.object({ path: z.string(), title: z.string(), description: z.string() }),
  ),
});
export function importCapture(manifest: any, raw: unknown) {
  const mapping = mappingSchema.parse(raw);
  return visualEvidenceSchema.parse({
    schemaVersion: 1,
    recordKind: "visual-evidence",
    project: mapping.project,
    productRevision: mapping.productRevision,
    title: mapping.title,
    summary: mapping.summary,
    capturedAt: new Date(manifest.capturedAt).toISOString(),
    source: {
      repository: mapping.repository,
      commit: manifest.sourceAtCapture.commit,
      environment: "local",
      seeded: true,
      dirty: manifest.sourceAtCapture.dirty,
      build: manifest.sourceAtCapture.packageSHA256,
    },
    limitations: [
      ...manifest.limitations,
      manifest.environment,
      "Original capture retained; importing does not establish current-main or production behavior.",
    ],
    steps: mapping.steps.map((step, i) => {
      const asset = manifest.assets.find(
        (asset: any) => asset.path === step.path,
      );
      if (!asset) throw Error(`Missing captured asset: ${step.path}`);
      const video = step.path.endsWith(".mp4");
      return {
        id: `step-${i + 1}`,
        title: step.title,
        description: step.description,
        media: [
          {
            id: step.path,
            kind: video ? "video" : "screenshot",
            caption: step.title,
            href: video
              ? mapping.video.href
              : new URL(step.path, mapping.assetBase).href,
            ...(video
              ? { downloadHref: mapping.video.href + "?download" }
              : {}),
            owner: video ? mapping.video.owner : "software-foundry",
            sha256: asset.sha256,
            contentType: video ? "video/mp4" : "image/png",
          },
        ],
      };
    }),
  });
}
if (import.meta.main) {
  const [manifest, mapping] = await Promise.all(
    process.argv
      .slice(2, 4)
      .map((path) => readFile(path, "utf8").then(JSON.parse)),
  );
  console.log(JSON.stringify(importCapture(manifest, mapping), null, 2));
}
