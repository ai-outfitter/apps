import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { fileBase, filePath, isReferenceImage } from "../lib/assembly-file";
import {
  fitAdvisories,
  fitTrialInput,
  rapidFitGuidance,
  type FitTrial,
  type fitTrialScope,
} from "../lib/fit-trial";
import { verifiedFileBytes } from "./assembly-files";
import { savedAssemblyRevision } from "./assembly-references";
import type { WorkshopContext } from "./graphql";
import { getWorkshopProject, type WorkshopDatabase } from "./projects";
import { workshopFitTrials as trials } from "./schema";

function present(row: typeof trials.$inferSelect) {
  const trial = fitTrialInput.parse(JSON.parse(row.data));
  return {
    ...trial,
    recordedAt: row.recordedAt,
    recordedBy: row.recordedBy,
    photos: trial.photos.map((photo) => {
      const file = { ...photo, projectId: trial.projectId };
      return { ...photo, downloadPath: fileBase(file) + filePath(file) };
    }),
    advisories: fitAdvisories(trial),
    rapidFitGuidance,
  };
}

export async function listFitTrials(
  db: WorkshopDatabase,
  { projectId, testedRevision }: z.infer<typeof fitTrialScope>,
) {
  const rows = await db
    .select()
    .from(trials)
    .where(
      and(
        eq(trials.projectId, projectId),
        testedRevision === undefined ? undefined : eq(trials.testedRevision, testedRevision),
      ),
    )
    .orderBy(desc(trials.testedRevision), desc(trials.recordedAt), trials.trialId);
  return rows.map(present);
}

export async function recordFitTrial(c: WorkshopContext, trial: FitTrial) {
  const db = c.db();
  const { projectId, trialId, testedRevision } = trial;
  const data = JSON.stringify(trial);
  const key = and(eq(trials.projectId, projectId), eq(trials.trialId, trialId));
  const existing = async () => (await db.select().from(trials).where(key))[0];
  function sameTrial(row: typeof trials.$inferSelect) {
    if (row.data !== data) throw new Response("Trial ID already records different evidence", { status: 409 });
    return present(row);
  }
  const previous = await existing();
  if (previous) return sameTrial(previous);

  const project = await getWorkshopProject(db, projectId);
  if (trial.pcbSnapshotId && !project.pcbSnapshots?.some((s) => s.id === trial.pcbSnapshotId))
    throw new Response("Unknown PCB snapshot in this project", { status: 400 });
  if (trial.interfaces.some((i) => i.component === "omitted" && i.engagement && i.engagement !== "untested"))
    throw new Response("An omitted component cannot establish engagement", { status: 400 });

  const load = (revision: number) => savedAssemblyRevision(db, projectId, revision);
  const tested = await load(testedRevision);
  const seen = new Set<string>();
  for (const photo of trial.photos) {
    const { itemId, fileName, sha256, bytes, attachmentRevision } = photo;
    if (!isReferenceImage(fileName) || !tested.assembly.items.some((i) => i.id === itemId))
      throw new Response(
        "Each trial photo must belong to an item in the tested assembly and be JPEG or PNG",
        { status: 400 },
      );
    const key = itemId + "/" + sha256 + "/" + fileName;
    if (seen.has(key)) throw new Response("Duplicate trial photo", { status: 400 });
    seen.add(key);
    const at = attachmentRevision === testedRevision ? tested : await load(attachmentRevision);
    const attached = (snapshot: typeof tested) =>
      snapshot.assembly.items
        .find((i) => i.id === itemId)
        ?.files?.find(
          (f) =>
            f.projectId === projectId && f.fileName === fileName && f.sha256 === sha256 && f.bytes === bytes,
        );
    const file = attached(at);
    if (!file || (attachmentRevision > 1 && attached(await load(attachmentRevision - 1))))
      throw new Response("Photo receipt does not match the attachment change at this revision", {
        status: 400,
      });
    await verifiedFileBytes(c, file);
  }
  const [inserted] = await db
    .insert(trials)
    .values({
      projectId,
      trialId,
      testedRevision,
      data,
      recordedAt: new Date().toISOString(),
      recordedBy: c.identity.userId,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return present(inserted);
  const concurrent = await existing();
  if (!concurrent) throw new Response("Project changed while recording the trial", { status: 409 });
  return sameTrial(concurrent);
}
