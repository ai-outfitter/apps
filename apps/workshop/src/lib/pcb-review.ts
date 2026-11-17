import { z } from "zod";
import type { BuildManifest, BuildRequest, WorkspaceSchema } from "./workspace";

type Artifact = BuildManifest["artifacts"][number];
type Workspace = z.infer<typeof WorkspaceSchema>;

const text = z.string().max(5000);
const label = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const artifactPath = z.string().regex(/^[a-f0-9]{64}\/[a-zA-Z0-9_.-]+$/);
// zod 4 numbers already reject Infinity and NaN.
const amount = z.number().nonnegative();
const currency = z.string().regex(/^[A-Z]{3}$/);

const PartSchema = z.object({
  Reference: z.string().min(1).max(80), Quantity: z.string().regex(/^[1-9][0-9]*$/),
  MPN: z.string().min(1).max(200), Value: text, Footprint: text, Description: text,
}).strict();

/** A quote that has not been obtained: requested, blocked or not yet asked.
 * The total stays null; it is never shown as a price. */
const UnquotedSchema = z.object({
  quantity: z.number().int().positive(), status: text, total: z.null(),
  currency: currency.optional(), supplier: label.optional(), detail: text,
  // Older records may carry a request reference or file while still unpriced.
  quoteId: z.string().min(1).max(200).optional(), quotedAt: z.iso.datetime().optional(),
  evidence: artifactPath.optional(),
}).strict();

/** A supplier-issued quote. Every field that makes a price checkable is required. */
const QuotedSchema = z.object({
  quantity: z.number().int().positive(), status: label, total: z.number().positive(),
  currency, supplier: label, quoteId: label, quotedAt: z.iso.datetime(),
  scope: label, evidence: artifactPath, detail: text,
}).strict();

export const QuoteSchema = z.union([UnquotedSchema, QuotedSchema]);
export type Quote = z.infer<typeof QuoteSchema>;
export const isQuoted = (q: Quote): q is z.infer<typeof QuotedSchema> => q.total !== null;

const PowerModeSchema = z.object({
  input_w: amount,
  /** Input power with the review's `marginPercent` applied. */
  input_w_with_margin: amount.optional(),
  /** Older review records name a fixed 20% margin in the field itself. */
  input_w_plus_20pct: amount.optional(),
}).loose();

/** Imported engineering evidence is data, never a manufacturing approval. */
export const PcbReviewSchema = z.object({
  title: z.string().min(1).max(200), revision: z.string().min(1).max(80),
  boardSha256: hash, dimensions: text, components: z.number().int().positive().max(10000),
  model: artifactPath, preview: artifactPath.optional(), modelNote: text, status: text,
  parts: z.array(PartSchema).min(1).max(10000),
  checks: z.array(z.object({ name: text, status: z.enum(["pass", "fail", "unverified"]), detail: text }).strict()).max(100),
  power: z.object({
    /** The input voltage the estimates assume; optional for older records. */
    inputVoltageV: z.number().positive().max(1000).optional(),
    marginPercent: z.number().positive().max(1000).optional(),
    modes: z.record(z.string().max(80), PowerModeSchema),
  }).loose(),
  powerNotes: text, manufacturingNote: text,
  downloads: z.array(z.object({ label: text, path: artifactPath }).strict()).max(100),
  quotes: z.array(QuoteSchema).max(30),
}).strict().superRefine((review, ctx) => {
  if (new Set(review.parts.map(p => p.Reference)).size !== review.parts.length)
    ctx.addIssue({ code: "custom", message: "Duplicate BOM reference" });
  if (review.parts.reduce((n, p) => n + Number(p.Quantity), 0) !== review.components)
    ctx.addIssue({ code: "custom", message: "Component count differs from the BOM" });
  if (Object.values(review.power.modes).some(m => m.input_w_with_margin !== undefined) && review.power.marginPercent === undefined)
    ctx.addIssue({ code: "custom", message: "input_w_with_margin needs power.marginPercent" });
});
export type PcbReview = z.infer<typeof PcbReviewSchema>;

/** Parses a review and requires every file it points at to be a registered artifact. */
export function parsePcbReview(value: unknown, artifacts: readonly Artifact[]): PcbReview {
  const review = PcbReviewSchema.parse(value);
  const registered = new Map(artifacts.map(a => [a.path, a]));
  const paths = [review.model, ...(review.preview ? [review.preview] : []), ...review.downloads.map(d => d.path), ...review.quotes.flatMap(q => q.evidence ? [q.evidence] : [])];
  for (const path of paths) {
    const artifact = registered.get(path);
    if (!artifact || path.split("/")[0] !== artifact.sha256) throw Error(`Unregistered PCB artifact: ${path}`);
  }
  if (registered.get(review.model)?.contentType !== "model/gltf-binary") throw Error("PCB model must be a GLB artifact");
  if (review.preview && registered.get(review.preview)?.contentType !== "image/png") throw Error("PCB preview must be a PNG artifact");
  return review;
}

/** The one review record in a manifest: `<sha256>/pcb-review.json`, content-addressed. */
export function pcbReviewArtifact(artifacts: readonly Artifact[] | undefined): Artifact | undefined {
  const found = (artifacts ?? []).filter(a => a.path === `${a.sha256}/pcb-review.json`);
  return found.length === 1 ? found[0] : undefined;
}

/** Whether the project's current build carries a PCB review. */
export function hasPcbReview(workspace: Workspace | undefined): boolean {
  const current = workspace?.requests.find(r => r.id === workspace?.currentBuildId);
  return current?.status === "succeeded" && Boolean(pcbReviewArtifact(current.result?.manifest?.artifacts));
}

/** Where a displayed board came from. Imported snapshots add their own variant. */
export type PcbProvenance = {
  kind: "workspace-build"; buildId: string; current: boolean; baseRevision: number;
  sourceCommit: string; sourceHash: string; runner: string; compiler: string;
  finishedAt: string; reviewSha256: string;
} | {
  kind: "imported"; snapshotId: string; current: boolean; importedAt: string;
  sourceCommit: string; sourceHash: string; runner: string; compiler: string;
  finishedAt: string; reviewSha256: string;
};

export type PcbBuildResolution =
  | { ok: true; build: BuildRequest; manifest: BuildManifest; artifactBase: string; review: Artifact; provenance: PcbProvenance; notes: string[] }
  | { ok: false; reason: string };

const short = (id: string) => id.slice(0, 8);

/** Picks the build to show: the requested one, exactly, or else the current one. */
export function resolveWorkspacePcbBuild(workspace: Workspace | undefined, requested?: string | null): PcbBuildResolution {
  const runs = workspace?.requests ?? [];
  if (!runs.length) return { ok: false, reason: "This project has no workspace builds. Import a KiCad review package to show a board." };
  const latest = runs.at(-1)!;
  const id = requested || workspace?.currentBuildId;
  const build = id ? runs.find(r => r.id === id) : undefined;
  if (requested && !build) return { ok: false, reason: `Build ${short(requested)} was not found in this project.` };
  if (!build) {
    if (latest.status === "failed") return { ok: false, reason: `No build is current. The latest build (${short(latest.id)}) failed${latest.result?.error ? `: ${latest.result.error}` : "."}` };
    return { ok: false, reason: `No build is current. The latest build (${short(latest.id)}) is ${latest.status}.` };
  }
  if (build.status !== "succeeded") return { ok: false, reason: `Build ${short(build.id)} is ${build.status}${build.result?.error ? `: ${build.result.error}` : "."}` };
  const manifest = build.result?.manifest;
  if (!manifest || !build.result) return { ok: false, reason: `Build ${short(build.id)} has no manifest.` };
  const review = pcbReviewArtifact(manifest.artifacts);
  if (!review) return { ok: false, reason: `Build ${short(build.id)} has no PCB review record.` };
  const current = build.id === workspace?.currentBuildId;
  const notes: string[] = [];
  if (!current) notes.push(`Showing historical build ${short(build.id)}${workspace?.currentBuildId ? `; the current build is ${short(workspace.currentBuildId)}` : ""}.`);
  if (current && latest.id !== build.id && latest.status === "failed")
    notes.push(`A later build (${short(latest.id)}) failed${latest.result?.error ? `: ${latest.result.error}` : "."} Showing the current build.`);
  return {
    ok: true, build, manifest, artifactBase: build.result.artifactBase, review, notes,
    provenance: {
      kind: "workspace-build", buildId: build.id, current, baseRevision: build.baseRevision,
      sourceCommit: manifest.sourceCommit, sourceHash: manifest.sourceHash,
      runner: manifest.runner, compiler: manifest.compiler, finishedAt: manifest.finishedAt, reviewSha256: review.sha256,
    },
  };
}

/** Facts that pin the displayed revision, taken from the build record, not the review. */
export function provenanceFacts(p: PcbProvenance): [string, string][] {
  if(p.kind === "imported") return [
    ["Snapshot", `${short(p.snapshotId)} · ${p.current ? "latest import" : "historical import"}`],
    ["Origin", "Imported file evidence; not a hosted workflow run"],
    ["Imported", p.importedAt], ["Exported", p.finishedAt],
    ["Repository base", p.sourceCommit.slice(0,12)],
    ["Source archive", p.sourceHash.slice(0,12)],
    ["Review record", p.reviewSha256.slice(0,12)],
    ["Exported by", `${p.runner} · ${p.compiler}`],
  ];
  return [
    ["Build", `${short(p.buildId)} · ${p.current ? "current" : "historical"}`],
    ["Recorded", p.finishedAt],
    ["Requested at revision", String(p.baseRevision)],
    ["Source commit", p.sourceCommit.slice(0, 12)],
    ["Source archive", p.sourceHash.slice(0, 12)],
    ["Review record", p.reviewSha256.slice(0, 12)],
    ["Exported by", `${p.runner} · ${p.compiler}`],
  ];
}

/** The registered artifact whose bytes the review's `boardSha256` names, if any. */
export const boardArtifact = (review: PcbReview, artifacts: readonly Artifact[]) =>
  artifacts.find(a => a.sha256 === review.boardSha256);

/** Build files expire with the `builds` storage space (`app.json`, ttl 1y);
 * the build record stays. */
export const BUILD_FILE_RETENTION_DAYS = 365;
export function missingFileMessage(what: string, status: number, finishedAt: string | undefined, now = Date.now()) {
  if (status !== 404 && status !== 410) return `The ${what} could not be loaded (HTTP ${status}).`;
  const age = finishedAt ? (now - Date.parse(finishedAt)) / 86_400_000 : Number.NaN;
  if (age > BUILD_FILE_RETENTION_DAYS) return `The ${what} has expired: build files are kept for one year and this build was recorded ${finishedAt}. The build record remains.`;
  if (age >= 0) return `The ${what} is not in build storage (HTTP ${status}). This build is under a year old, so it has not reached the one-year file retention.`;
  return `The ${what} is not in build storage (HTTP ${status}). Build files are kept for one year.`;
}

export type PowerRow = { mode: string; inputW: number; withMargin?: { watts: number; label: string } };
/** Power rows labelled only from what the review states. */
export function powerRows(review: PcbReview): PowerRow[] {
  const percent = review.power.marginPercent;
  return Object.entries(review.power.modes).map(([mode, m]) => {
    const withMargin = m.input_w_with_margin !== undefined && percent !== undefined
      ? { watts: m.input_w_with_margin, label: `with ${percent}% margin` }
      : m.input_w_plus_20pct !== undefined ? { watts: m.input_w_plus_20pct, label: "with 20% margin" } : undefined;
    return { mode, inputW: m.input_w, ...(withMargin ? { withMargin } : {}) };
  });
}

/** "Supplier assembly quotes", or the supplier's name when every quote names the same one. */
export function quotesHeading(quotes: readonly Quote[]) {
  const suppliers = new Set(quotes.map(q => q.supplier));
  const [only] = suppliers;
  return suppliers.size === 1 && only ? `${only} assembly quotes` : "Supplier assembly quotes";
}
