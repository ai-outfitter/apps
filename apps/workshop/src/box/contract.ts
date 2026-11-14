// The Workshop box's JSON contract: what goes in (a design request for
// Workshop's design agent) and what comes out (a design result, the design
// revision committed to the box repository, and a release's evidence bundle).
// The committed JSON Schemas under box/schemas are generated from these
// definitions by scripts/box-schemas.ts.
import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/, "full 40-character commit SHA");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "hex SHA-256");
/** An object stored in the box's RustFS: `s3://<bucket>/<key>`. */
const objectUri = z.string().regex(/^s3:\/\/[a-z0-9.-]+\/.+$/, "s3://bucket/key");
/** A design's folder in the repository: `designs/<slug>`. */
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lowercase slug");
const millimetres = z.number().positive().max(1000);
const message = z.string().trim().min(1).max(500);
const via = z.enum(["agent", "graphql"]).optional();

/** One design handed to the box: a first message, then follow-ups to the same project. */
export const DesignRequest = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  title: z.string().min(1).max(200),
  /** The first message to the design agent; it becomes the project's brief. */
  message,
  /** Follow-up messages, applied in order to the project the first one made. */
  followUps: z.array(message).max(8).default([]),
  /** Where the design is committed: `designs/<slug>/`. Defaults to one made from the title. */
  slug: slug.optional(),
  /** How each turn reaches the design agent: `agent` posts to Workshop's design route as the project page does (the default);
   * `graphql` starts it with the StartWorkshopDesign mutation through the platform's graph API (MCP graph_mutate) and follows the run. */
  via,
  release: z
    .strictObject({ trigger: z.boolean(), bump: z.enum(["major", "minor", "patch"]).default("patch") })
    .optional(),
});

export const Bounds = z.strictObject({ width: millimetres, depth: millimetres, height: millimetres });

/** One turn with the design agent. */
export const DesignIteration = z.strictObject({
  message,
  rationale: z.string().max(4000),
  dimensions: Bounds,
  revision: z.number().int().positive(),
});

/** A file of the design revision, as committed. */
export const DesignFile = z.strictObject({
  path: z.string().min(1).max(300),
  sha256,
  bytes: z.number().int().nonnegative(),
  uri: objectUri,
});

/** A bill of materials row. A generated design has one fabricated body. */
export const BomLine = z.strictObject({
  part: z.string().min(1).max(200),
  quantity: z.number().int().positive(),
  kind: z.enum(["fabricated", "purchased"]),
  volumeMm3: z.number().nonnegative().optional(),
  bounds: Bounds.optional(),
});

const Model = z.strictObject({ provider: z.string().min(1), id: z.string().min(1) });

export const ReleaseArtifact = z.strictObject({ name: z.string().min(1), uri: objectUri, sha256, bytes: z.number().int().nonnegative() });

export const Release = z.strictObject({
  tag: z.string().min(1),
  url: z.url(),
  artifacts: z.array(ReleaseArtifact),
  evidenceBundle: z.strictObject({ uri: objectUri, sha256 }),
});

/** Time and model use (box/metrics.mjs): each step's wall time, model calls and tokens; tokens are null when unreported. */
const tokens = z.int().nonnegative().nullable();
export const Metrics = z.strictObject({
  wallSeconds: z.number().nonnegative(),
  modelSeconds: z.number().nonnegative(),
  modelCalls: z.int().nonnegative(),
  inputTokens: tokens,
  outputTokens: tokens,
  outputTokensPerSecond: z.number().nonnegative().nullable(),
  steps: z.array(z.strictObject({
    name: z.string().min(1),
    status: z.string().min(1),
    seconds: z.number().nonnegative(),
    modelCalls: z.int().nonnegative(),
    inputTokens: tokens,
    outputTokens: tokens,
  })),
});

/** Every agent session of the request (box/sessions.mjs): files under sessions/<requestId>/ on the repository's sessions branch, stored with Git LFS. */
export const Sessions = z.strictObject({
  branch: z.string().min(1).optional(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  files: z.array(z.strictObject({ agent: z.string().min(1), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.int().nonnegative() })),
});

/** The project's workbench after a design step (box/screenshots.mjs): a PNG under /out and in RustFS. */
export const Screenshot = z.strictObject({
  step: z.string().min(1),
  revision: z.number().int().positive(),
  /** Relative to /out: screenshots/<requestId>/<n>-<step>.png. */
  path: z.string().regex(/^screenshots\/[^/]+\/[a-z0-9-]+\.png$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.int().nonnegative(),
  uri: z.string().regex(/^s3:\/\/[a-z0-9.-]+\/.+$/),
  /** Whether the 3D view had drawn the model when the screenshot was taken. */
  ready: z.boolean(),
});

/** What happened to one design request (`/out/results/<requestId>.json`). */
export const DesignResult = z
  .strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    status: z.enum(["designed", "failed"]),
    reason: z.string().max(4000).optional(),
    path: z.string().regex(/^designs\/[a-z0-9][a-z0-9-]{0,63}$/),
    /** How the turns reached the design agent, when the request named it. */
    via,
    project: z.strictObject({ id: z.string().min(1), revision: z.number().int().positive(), name: z.string().min(1) }).optional(),
    iterations: z.array(DesignIteration),
    geometry: z
      .strictObject({ bounds: Bounds, volumeMm3: z.number().positive(), features: z.number().int().positive() })
      .optional(),
    bom: z.array(BomLine),
    files: z.array(DesignFile),
    screenshots: z.array(Screenshot).optional(),
    commitSha: sha.optional(),
    model: Model,
    release: Release.optional(),
    metrics: Metrics.optional(),
    sessions: Sessions.optional(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
  })
  .superRefine((result, context) => {
    const designed = result.status === "designed";
    if (designed && !(result.project && result.geometry && result.commitSha && result.files.length))
      context.addIssue({ code: "custom", message: "a designed result names its project, geometry, files and commit" });
    if (!designed && !result.reason) context.addIssue({ code: "custom", message: "a failed result says why" });
  });

/** A release's build identity and what backs each design in it. */
export const EvidenceBundle = z.strictObject({
  schemaVersion: z.literal(1),
  tag: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  commitSha: sha,
  build: z.strictObject({ command: z.string().min(1), image: z.string().min(1), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime() }),
  model: Model,
  designs: z.array(
    z.strictObject({
      requestId: z.uuid(),
      path: z.string().min(1),
      commitSha: sha,
      projectRevision: z.number().int().positive(),
      geometry: z.strictObject({ bounds: Bounds, volumeMm3: z.number().positive() }),
      files: z.array(DesignFile),
    }),
  ),
  artifacts: z.array(ReleaseArtifact),
});

/** File name → schema, for generation and tests. */
export const boxSchemas = {
  "design-request": DesignRequest,
  "design-result": DesignResult,
  "evidence-bundle": EvidenceBundle,
} as const;

export function boxJsonSchema(name: keyof typeof boxSchemas) {
  return {
    $id: `https://outfitter.ai/schemas/workshop-box/${name}.schema.json`,
    ...z.toJSONSchema(boxSchemas[name], { io: "input", unrepresentable: "throw" }),
  };
}
