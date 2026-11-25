import { z } from "zod";
import { AssemblyReferenceSchema, type Assembly, type Item } from "../lib/assembly";
import { fileBase, filePath, fileType, isReferenceImage } from "../lib/assembly-file";
import { resolveAssembly, type AssemblySource } from "../lib/assembly-resolution";
import { cotsEvidence, type CotsEvidence, type CotsEvidenceRef } from "../lib/cots-evidence";
import { canonicalCotsPart, cotsPart } from "./cots-owner";
import { assemblySnapshot } from "./assembly-references";
import type { WorkshopContext } from "./graphql";
import { getWorkshopProject, patchWorkshopProject } from "./projects";

export const cotsReadInput = AssemblyReferenceSchema.extend({ itemId: z.uuid().optional() });
export const cotsWriteInput = z.strictObject({
  projectId: z.uuid(), itemId: z.uuid(), expectedRevision: z.int().positive(), evidence: cotsEvidence,
});
type Warning = { code: string; message: string; interfaceId?: string };
const warning = (code: string, message: string, interfaceId?: string): Warning =>
  ({ code, message, ...(interfaceId && { interfaceId }) });
const refusal = (message: string, status = 400) => new Response(message, { status });
const missing = warning("evidence_missing", "No owned-part reference photos or interface dimensions have been recorded.");
type Owner = Required<CotsEvidenceRef> & { name: string; number: string; partRevision: string };
type Attachment = { projectId: string; itemId: string; revision: number; fileName: string; observation: string; itemNumber: string; itemName: string };
type Photo = CotsEvidence["photos"][number] & {
  downloadPath: string; bytes: number; attachments: Attachment[]; basis: "recorded" | "legacy-attachment";
};
type Row = {
  itemId: string; name: string; number: string; owner?: Owner; supplierSource?: string;
  photos: Photo[]; interfaces: CotsEvidence["interfaces"]; warnings: Warning[];
};
export type CotsEvidenceResult = { projectId: string; revision: number; items: Row[] };

const locatedFile = (item: Item | undefined, projectId: string, photo: CotsEvidence["photos"][number]) =>
  item?.files?.find(file => file.projectId === projectId && file.fileName === photo.fileName &&
    file.sha256 === photo.sha256 && isReferenceImage(file.fileName));
type Loader = Awaited<ReturnType<typeof assemblySnapshot>>["load"];

async function referencePhoto(c: WorkshopContext, load: Loader, owner: Owner, photo: CotsEvidence["photos"][number]) {
  const origin = photo.attachmentOwner ?? owner;
  const historical = await load({ projectId: origin.projectId, revision: photo.attachmentRevision });
  const item = historical.assembly.items.find(item => item.id === origin.itemId);
  const file = locatedFile(item, origin.projectId, photo);
  if (!item || !file) throw refusal("Photo is not attached at the stated owner and revision", 404);
  const head = await c.storage().head({ space: "builds", key: origin.projectId + "/assembly/" + filePath(file) });
  if (head?.sha256 !== file.sha256 || head.size !== file.bytes || head.contentType !== fileType(file.fileName))
    throw refusal("Reference photo bytes no longer match their receipt", 409);
  return {
    ...photo, bytes: file.bytes, downloadPath: fileBase(file) + filePath(file),
    attachments: [{ projectId: origin.projectId, itemId: origin.itemId, revision: photo.attachmentRevision, fileName: file.fileName,
      observation: photo.observation, itemNumber: item.number, itemName: item.name }],
  };
}

function interfaceWarnings(evidence: CotsEvidence) {
  const warnings: Warning[] = [];
  if (!evidence.photos.length) warnings.push(warning("photo_missing", "Photograph the owned part and visible mating features."));
  if (!evidence.interfaces.length) warnings.push(warning("interfaces_missing", "Identify the mating features and record dimensions at a datum."));
  for (const entry of evidence.interfaces) {
    if (!entry.measured) warnings.push(warning("measurement_missing", "Measure the owned part at the stated datum.", entry.id));
    if (entry.tolerance.kind === "unknown") warnings.push(warning("tolerance_unknown", "Tolerance is unknown.", entry.id));
    if (entry.verification.status === "untested") warnings.push(warning("fit_untested", "Physical fit is untested.", entry.id));
    if (entry.verification.status === "interferes") warnings.push(warning("fit_interference", entry.verification.observation, entry.id));
  }
  return warnings;
}

function subtree(assembly: Assembly, itemId: string) {
  const byId = new Map(assembly.items.map(item => [item.id, item]));
  if (!byId.has(itemId)) throw refusal("Assembly item unavailable", 404);
  const visited = new Set<string>();
  const pending = [itemId];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const use of byId.get(id)!.uses) pending.push(use.itemId);
  }
  return visited;
}

function parametersKey(parameters: Record<string, number> | undefined) {
  return JSON.stringify(Object.entries(parameters ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

export async function readCotsEvidence(c: WorkshopContext, input: z.infer<typeof cotsReadInput>, verifyPhotos = true): Promise<CotsEvidenceResult> {
  const { itemId, ...selection } = input;
  const { load } = await assemblySnapshot(c.db());
  const root = await load(selection);
  const expanded = await resolveAssembly(root, load, selection, true);
  function indexPhotos(items: Item[], originFor: (item: Item) => Required<CotsEvidenceRef>) {
    const found = new Map<string, CotsEvidence["photos"]>();
    for (const item of items) {
      const origin = originFor(item);
      for (const file of item.files ?? []) {
        if (file.projectId !== origin.projectId || !isReferenceImage(file.fileName)) continue;
        const entries = found.get(file.sha256) ?? [];
        entries.push({ fileName: file.fileName, sha256: file.sha256, attachmentRevision: origin.revision,
          attachmentOwner: { projectId: origin.projectId, itemId: origin.itemId },
          observation: "Identical bytes attached to this assembly item at the listed revision." });
        found.set(file.sha256, entries);
      }
    }
    return found;
  }
  const discovered = verifyPhotos ? indexPhotos(expanded.assembly.items, item => expanded.itemOrigins![item.id]) : undefined;
  const indexed = new Map<string, ReturnType<typeof indexPhotos>>();
  const cache = new Map<string, Promise<Pick<Row, "photos" | "interfaces" | "warnings">>>();
  function hydrate(item: Item, owner: Owner, source: AssemblySource) {
    const key = JSON.stringify([owner.projectId, owner.itemId, owner.revision]);
    if (!cache.has(key)) cache.set(key, (async () => {
      const legacyPhotos = new Map((item.files ?? [])
        .filter(file => file.projectId === owner.projectId && isReferenceImage(file.fileName))
        .map(file => [file.sha256, {
          fileName: file.fileName, sha256: file.sha256, attachmentRevision: owner.revision,
          observation: "Existing attachment; no structured observation has been recorded.",
        }]));
      const evidence: CotsEvidence = item.cotsEvidence ?? { photos: [...legacyPhotos.values()], interfaces: [] };
      if (!evidence.photos.length && !evidence.interfaces.length)
        return { photos: [], interfaces: [], warnings: [missing] };
      const warnings = interfaceWarnings(evidence);
      if (!item.cotsEvidence && legacyPhotos.size)
        warnings.push(warning("legacy_photo_unreviewed", "Existing photos have no structured observation or fit result."));
      if (!verifyPhotos) return { photos: [], interfaces: evidence.interfaces, warnings };
      const sourceKey = source.id + "/" + source.revision;
      if (!indexed.has(sourceKey))
        indexed.set(sourceKey, indexPhotos(source.assembly.items, item => ({ projectId: source.id, revision: source.revision, itemId: item.id })));
      const sourcePhotos = indexed.get(sourceKey)!;
      const photos = new Map<string, Photo>();
      const seen = new Set<string>();
      for (const record of evidence.photos) {
        for (const photo of [record, ...(sourcePhotos.get(record.sha256) ?? []), ...(discovered?.get(record.sha256) ?? [])]) {
          const origin = photo.attachmentOwner ?? owner;
          const key = JSON.stringify([origin.projectId, origin.itemId, photo.attachmentRevision, photo.fileName, photo.sha256]);
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const verified = await referencePhoto(c, load, owner, photo);
            const existing = photos.get(photo.sha256);
            if (existing) existing.attachments.push(...verified.attachments);
            else photos.set(photo.sha256, { ...verified, basis: item.cotsEvidence ? "recorded" : "legacy-attachment" });
          } catch {
            warnings.push(warning("photo_unavailable", "Reference photo unavailable: " + photo.fileName));
          }
        }
      }
      return { photos: [...photos.values()], interfaces: evidence.interfaces, warnings };
    })());
    return cache.get(key)!;
  }
  const scoped = itemId ? subtree(expanded.assembly, itemId) : undefined;
  const items: Row[] = [];
  for (const item of expanded.assembly.items) {
    if (item.kind !== "cots" || (scoped && !scoped.has(item.id))) continue;
    const row = { itemId: item.id, name: item.name, number: item.number };
    try {
      const source = await canonicalCotsPart(load, expanded.itemOrigins![item.id]);
      const evidence = await hydrate(source.item, source.owner, source.source);
      const previousTests = evidence.interfaces.flatMap(entry => {
        const fit = entry.verification;
        if (fit.status === "untested" || (fit.testedProjectId === root.id && fit.testedRevision === root.revision &&
            fit.testedConfiguration === selection.configuration &&
            parametersKey(fit.testedParameters) === parametersKey(selection.parameters))) return [];
        return [warning("fit_tested_elsewhere", "Fit observation applies to the recorded project revision.", entry.id)];
      });
      items.push({ ...row, owner: source.owner, supplierSource: source.item.source || undefined, ...evidence, warnings: [...evidence.warnings, ...previousTests] });
    } catch (error) {
      const failure = error instanceof Response && error.status === 409
        ? warning("owner_part_mismatch", "Evidence owner identifies a different purchased part or part revision.")
        : warning("owner_unavailable", "COTS evidence owner could not be resolved.");
      items.push({ ...row, photos: [], interfaces: [], warnings: [failure] });
    }
  }
  return { projectId: root.id, revision: root.revision, items };
}

export async function recordCotsEvidence(c: WorkshopContext, input: z.infer<typeof cotsWriteInput>) {
  if (!c.identity.canEdit) throw refusal("An editor must record purchased-part evidence", 403);
  const { projectId, itemId, expectedRevision, evidence } = input;
  const db = c.db();
  const current = await getWorkshopProject(db, projectId);
  const item = current.assembly.items.find(item => item.id === itemId && item.kind === "cots" && !item.cotsEvidenceRef);
  if (!item) throw refusal("Select the purchased part in its owning project", 404);
  const { load } = await assemblySnapshot(db);
  const { owner } = await cotsPart(load, { projectId, itemId, revision: current.revision });
  function authored(value: CotsEvidence | undefined) {
    return JSON.stringify(value, (key, field) => key === "testedOwnerRevision" ? undefined : field);
  }
  const unchanged = authored(item.cotsEvidence) === authored(evidence);
  if (!unchanged && current.revision !== expectedRevision) throw refusal("Project changed; reread WorkshopAssembly", 409);
  if (unchanged) return readCotsEvidence(c, { projectId, itemId, revision: current.revision });
  for (const photo of evidence.photos) {
    const origin = photo.attachmentOwner ?? owner;
    if (origin.projectId === projectId && origin.itemId === itemId) {
      if (photo.attachmentRevision > current.revision) throw refusal("Photo revision is newer than the owner");
      const pinned = await cotsPart(load, { ...owner, revision: photo.attachmentRevision });
      if (pinned.item.revision !== item.revision || pinned.item.mpn !== item.mpn || pinned.item.manufacturer !== item.manufacturer)
        throw refusal("Photo belongs to a different purchased-part revision");
    }
    await referencePhoto(c, load, owner, photo);
  }
  const testedParts = new Map<string, number | null>();
  for (const entry of evidence.interfaces) {
    if (entry.verification.status === "untested") continue;
    const { testedProjectId, testedRevision, testedConfiguration, testedParameters } = entry.verification;
    const testedSelection = { projectId: testedProjectId, revision: testedRevision,
      configuration: testedConfiguration, parameters: testedParameters };
    const key = JSON.stringify(testedSelection);
    if (!testedParts.has(key)) {
      const tested = await load({ projectId: testedProjectId, revision: testedRevision });
      const expanded = await resolveAssembly(tested, load, testedSelection, true);
      let found: number | null = null;
      const installed = expanded.assembly.rootId ? subtree(expanded.assembly, expanded.assembly.rootId) : new Set<string>();
      for (const testedItem of expanded.assembly.items) {
        if (testedItem.kind !== "cots" || !installed.has(testedItem.id)) continue;
        const origin = expanded.itemOrigins![testedItem.id];
        try {
          const source = await canonicalCotsPart(load, origin);
          if (source.owner.projectId === projectId && source.owner.itemId === itemId && source.item.revision === item.revision) {
            found = source.owner.revision;
            break;
          }
        } catch (error) {
          if (!(error instanceof Response) || ![400, 404, 409].includes(error.status)) throw error;
        }
      }
      testedParts.set(key, found);
    }
    const witnessedRevision = testedParts.get(key);
    if (!witnessedRevision) throw refusal("The tested revision does not contain this purchased-part revision", 409);
    entry.verification.testedOwnerRevision = witnessedRevision;
  }
  const saved = await patchWorkshopProject(db, c.identity, { id: projectId, revision: expectedRevision }, project => {
    project.assembly.items.find(item => item.id === itemId)!.cotsEvidence = evidence;
    return { assembly: project.assembly };
  });
  return readCotsEvidence(c, { projectId, itemId, revision: saved.revision });
}

export async function cotsMutationWarnings(c: WorkshopContext, projectId: string, revision: number) {
  try {
    const result = await readCotsEvidence(c, { projectId, revision }, false);
    const all = result.items.flatMap(({ itemId, owner, warnings }) =>
      warnings.map(warning => ({ itemId, owner, ...warning })));
    if (all.length <= 25) return all;
    return [...all.slice(0, 25), { ...warning("evidence_warnings_truncated", "Read WorkshopCotsEvidence for all purchased-part warnings."), total: all.length }];
  } catch {
    return [warning("evidence_unavailable", "Purchased-part evidence is temporarily unavailable.")];
  }
}
