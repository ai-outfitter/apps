// The Workshop box's release: the shared release step (box/release.mjs) with
// Workshop's evidence bundle (box/schemas/evidence-bundle.schema.json), which
// pins each released design's commit, geometry and file hashes.
import { publishRelease } from "../../../box/release.mjs";

/**
 * The evidence bundle: what was released from which commit, and the files behind each design.
 * @param {{ tag: string, version: string, commitSha: string, build: any, model: any, designed: { request?: any, result: any }[], artifacts: any[] }} input
 */
export function evidenceBundle({ tag, version, commitSha, build, model, designed, artifacts }) {
  return {
    schemaVersion: 1,
    tag,
    version,
    commitSha,
    build,
    model,
    designs: designed.map(({ result }) => ({
      requestId: result.requestId,
      path: result.path,
      commitSha: result.commitSha,
      projectRevision: result.project.revision,
      geometry: { bounds: result.geometry.bounds, volumeMm3: result.geometry.volumeMm3 },
      files: result.files,
    })),
    artifacts,
  };
}

/** Releases the designs that asked for one. */
export function releaseDesigns(box, designed) {
  return publishRelease(box, {
    bumps: designed.map(({ request }) => request.release?.bump ?? "patch"),
    lines: designed.map(({ request, result }) => `- ${request.title}: ${result.path} (${result.geometry.bounds.width} x ${result.geometry.bounds.depth} x ${result.geometry.bounds.height} mm)`),
    evidence: (release) => evidenceBundle({ ...release, model: designed[0].result.model, designed }),
  });
}
