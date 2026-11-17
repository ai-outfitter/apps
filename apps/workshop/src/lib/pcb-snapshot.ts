import { z } from "zod";
import { BuildManifestSchema } from "./workspace";

/** File evidence imported by a member; never a hosted workflow result. */
export const PcbSnapshotSchema = z.object({
  id: z.uuid(), origin: z.literal("imported"), importedAt: z.iso.datetime(),
  importedBy: z.string().min(1).max(200), reviewPath: z.string().max(300),
  manifest: BuildManifestSchema, artifactBase: z.string().max(500),
}).strict();
export type PcbSnapshot = z.infer<typeof PcbSnapshotSchema>;
