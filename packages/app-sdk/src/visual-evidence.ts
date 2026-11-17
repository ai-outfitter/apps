import { z } from "zod";

/** Evidence describes a capture, never approval or a claim that it ran in production. */
const reference = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
});
export const evidenceMedia = z
  .strictObject({
    id: z.string().min(1).max(100),
    kind: z.enum(["screenshot", "video"]),
    caption: z.string().max(2000),
    href: z
      .string()
      .max(2048)
      .refine(
        safeEvidenceURL,
        "Use an HTTPS or app-relative authorized artifact URL",
      ),
    downloadHref: z.string().max(2048).refine(safeEvidenceURL).optional(),
    contentType: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/avif",
      "video/mp4",
      "video/webm",
    ]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    owner: z.string().min(1).max(200),
  })
  .refine(
    (m) => m.contentType.startsWith(m.kind === "video" ? "video/" : "image/"),
    "Media kind and content type must agree",
  );
export const visualEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    recordKind: z.literal("visual-evidence"),
    project: reference,
    productRevision: reference,
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(4000),
    capturedAt: z.iso.datetime(),
    source: z.strictObject({
      repository: z.url(),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      environment: z.enum(["local", "preview", "production"]),
      seeded: z.boolean(),
      dirty: z.boolean(),
      release: z.string().max(200).optional(),
      build: z.string().max(200).optional(),
    }),
    steps: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(100),
          title: z.string().min(1).max(200),
          description: z.string().max(4000),
          media: z.array(evidenceMedia).max(20).default([]),
          before: z
            .strictObject({
              bundle: reference,
              stepId: z.string().min(1).max(100),
            })
            .optional(),
        }),
      )
      .max(100),
    limitations: z.array(z.string().max(2000)).max(30).default([]),
  })
  .superRefine((value, ctx) => {
    const ids = value.steps.map((s) => s.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "Step IDs must be unique",
        path: ["steps"],
      });
    const mediaIds = value.steps.flatMap((s) => s.media.map((m) => m.id));
    if (new Set(mediaIds).size !== mediaIds.length)
      ctx.addIssue({
        code: "custom",
        message: "Media IDs must be unique",
        path: ["steps"],
      });
  });
export type VisualEvidence = z.infer<typeof visualEvidenceSchema>;
export const visualEvidenceJSONSchema = z.toJSONSchema(visualEvidenceSchema, {
  io: "input",
});
export function safeEvidenceURL(value: string): boolean {
  if (/^\/(?!\/)/.test(value)) return !/[\\\x00-\x1f]/.test(value);
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
/** Display adapters do not invent hashes or missing capture provenance. */
export type EvidenceView = {
  id: string;
  revision: number;
  title: string;
  summary: string;
  project?: VisualEvidence["project"];
  productRevision?: VisualEvidence["productRevision"];
  capturedAt?: string;
  source?: VisualEvidence["source"];
  limitations: string[];
  legacy: boolean;
  steps: {
    id: string;
    title: string;
    description: string;
    before?: VisualEvidence["steps"][number]["before"];
    media: {
      id: string;
      kind: "screenshot" | "video";
      caption: string;
      href: string;
      sha256?: string;
      contentType?: string;
      downloadHref?: string;
    }[];
  }[];
};
export function evidenceView(
  record: { id: string; revision: number; title: string; body: string },
  demonstrations: { id: string; title: string; media: string[] }[] = [],
): EvidenceView {
  let raw: unknown;
  try {
    raw = JSON.parse(record.body);
  } catch {
    /* legacy prose */
  }
  const parsed = visualEvidenceSchema.safeParse(raw);
  if (parsed.success)
    return {
      ...parsed.data,
      id: record.id,
      revision: record.revision,
      legacy: false,
    };
  if (
    raw &&
    typeof raw === "object" &&
    "recordKind" in raw &&
    raw.recordKind === "visual-evidence"
  )
    throw new Error(
      "Evidence does not match the supported schema; inspect the source record.",
    );
  return {
    id: record.id,
    revision: record.revision,
    title: record.title,
    summary: "Historical capture",
    legacy: true,
    limitations: [
      "Historical capture metadata is incomplete. Original source records are retained.",
    ],
    steps: demonstrations.map((d) => ({
      id: d.id,
      title: d.title,
      description: "",
      media: d.media.filter(safeEvidenceURL).flatMap((href, i) => {
        const path = new URL(href, "https://evidence.invalid").pathname;
        const kind = /\.(mp4|webm)$/i.test(path)
          ? "video"
          : /\.(png|jpe?g|webp|avif)$/i.test(path)
            ? "screenshot"
            : null;
        return kind
          ? [{ id: `${d.id}-${i}`, href, kind, caption: d.title }]
          : [];
      }),
    })),
  };
}
