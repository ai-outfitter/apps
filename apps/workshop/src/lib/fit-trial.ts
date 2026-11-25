import { z } from "zod";
import { assemblyFile } from "./assembly-file";

const note = z.string().trim().min(1).max(1200);
const revision = z.number().int().positive();
export const fitTrialScope = z.strictObject({ projectId: z.uuid(), testedRevision: revision.optional() });
export const fitTrialInput = z.strictObject({
  projectId: z.uuid(),
  trialId: z.uuid(),
  testedRevision: revision,
  title: z.string().trim().min(1).max(160),
  source: z
    .strictObject({ repository: note, commit: z.string().regex(/^[0-9a-f]{40}$/), path: note })
    .optional(),
  pcbSnapshotId: z.uuid().optional(),
  printedFileSha256: assemblyFile.shape.sha256.optional(),
  printSetup: z
    .strictObject({
      printer: note.optional(),
      nozzle: note.optional(),
      plate: note.optional(),
      filament: note.optional(),
      layerHeight: note.optional(),
      extrusionWidth: note.optional(),
      flow: note.optional(),
      supports: note.optional(),
      interfaceGap: note.optional(),
      orientation: note.optional(),
      slicer: note.optional(),
    })
    .optional(),
  photos: z
    .array(
      assemblyFile.omit({ projectId: true }).extend({
        itemId: z.uuid(),
        attachmentRevision: revision,
        observation: note,
      }),
    )
    .min(1),
  interfaces: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(160),
        observation: note,
        dimensionBasis: z
          .enum(["unknown", "supplier-nominal", "measured-print", "measured-owned-part"])
          .optional(),
        missingMeasurements: z.array(note).optional(),
        component: z.enum(["present", "omitted"]).optional(),
        engagement: z.enum(["untested", "fits", "interferes"]).optional(),
        wireExit: z.enum(["unchecked", "obstructed", "verified"]).optional(),
        overhang: z.enum(["unchecked", "observed", "inspected"]).optional(),
        finish: z.enum(["unchecked", "rough", "acceptable"]).optional(),
      }),
    )
    .min(1),
});

export type FitTrial = z.infer<typeof fitTrialInput>;
export function fitAdvisories(trial: FitTrial) {
  const flags: { subject: string; message: string }[] = [];
  for (const item of trial.interfaces) {
    const add = (message: string) => flags.push({ subject: item.name, message });
    if (item.missingMeasurements?.length)
      add("Unverified dimensions: " + item.missingMeasurements.join(", ") + ".");
    else if (item.dimensionBasis && item.dimensionBasis !== "measured-owned-part")
      add("Measure the mating surfaces on the purchased part. Record the datum and both axes.");
    if (item.component === "omitted")
      add("Component omitted from the trial. Repeat with the mating part installed to test engagement.");
    else if (item.engagement === "untested")
      add("Engagement is untested. Check seating, retention and the release path.");
    if (item.engagement === "interferes")
      add("Interference observed. Identify contact faces and repeat the fit check.");
    if (item.wireExit && item.wireExit !== "verified")
      add(
        "Fit the connector and route the leads. Check the exit, bend clearance and access with the assembly closed.",
      );
    if (item.overhang && item.overhang !== "inspected")
      add("Inspect the first unsupported layer and the support-contact face in the sliced orientation.");
    if (item.finish && item.finish !== "acceptable")
      add(
        "Inspect the printed face. Compare a dimensional coupon and calibrated flow before attributing the finish to over-extrusion.",
      );
  }
  if (!trial.printedFileSha256)
    flags.push({ subject: "Print provenance", message: "The exact printed file digest is unknown." });
  const fields = [
    "printer",
    "nozzle",
    "plate",
    "filament",
    "layerHeight",
    "extrusionWidth",
    "flow",
    "supports",
    "interfaceGap",
    "orientation",
    "slicer",
  ] as const;
  const missing = fields.filter((key) => !trial.printSetup?.[key]);
  if (missing.length)
    flags.push({
      subject: "Printer settings",
      message:
        "Unrecorded settings: " +
        missing.join(", ") +
        ". Overhang and finish depend on the actual print setup.",
    });
  return flags;
}

export const rapidFitGuidance =
  "Print a small mating section first. Keep the contacts, retention and wire exits accessible and omit broad cosmetic skins. Dry-fit the actual parts and record engagement and release. Use the full enclosure for strength and ingress trials.";
