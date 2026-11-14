import { z } from "zod";
import { requireEditor } from "@ai-outfitter/app-sdk/server";
import { defaultWiki } from "@ai-outfitter/app-sdk/graph-client";
import {
  handoff,
  canonical,
  typeIds,
  pinned,
} from "@ai-outfitter/creative-workflow";
import type { WorkshopContext } from "./graphql";
import { getWorkshopProject, patchWorkshopProject } from "./projects";
export const creativeHandoffInput = z.strictObject({
  projectId: z.uuid(),
  revision: z.number().int().positive(),
  id: z.uuid(),
  request: handoff,
});
export async function acceptCreativeHandoff(
  c: WorkshopContext,
  input: z.infer<typeof creativeHandoffInput>,
) {
  requireEditor(c.identity);
  const wiki = await defaultWiki(c.host());
  if (input.request.selection.installationId !== wiki.installationId)
    throw new Response("Selection belongs to another graph", { status: 403 });
  const { revision, ...address } = input.request.selection;
  const selected = await c.host().call("entities.get", address);
  if (
    selected.revision !== revision ||
    selected.attributes.typeId !== typeIds.CreativeSelection
  )
    throw new Response("Read the current selection", { status: 409 });
  const body = JSON.parse(String(selected.attributes.body));
  const { revision: candidateRevision, ...candidateAddress } = pinned.parse(
    body.candidate,
  );
  if (candidateAddress.installationId !== wiki.installationId)
    throw new Response("Candidate belongs to another graph", { status: 403 });
  const candidate = await c.host().call("entities.get", candidateAddress);
  if (
    candidate.revision !== candidateRevision ||
    candidate.attributes.typeId !== typeIds.CreativeCandidate
  )
    throw new Response("Selected candidate changed", { status: 409 });
  const project = await getWorkshopProject(c.db(), input.projectId);
  const previous = (project.creativeHandoffs ?? []).find(
    (h) => h.id === input.id,
  );
  if (previous) {
    if (canonical(previous.request) !== canonical(input.request))
      throw new Response("Handoff ID already used", { status: 409 });
    return previous;
  }
  const entry = {
    id: input.id,
    request: input.request,
    candidate: body.candidate,
    artifact: JSON.parse(String(candidate.attributes.body)).artifact,
    state: "requested" as const,
  };
  await patchWorkshopProject(
    c.db(),
    c.identity,
    { id: input.projectId, revision: input.revision },
    () => ({ creativeHandoffs: [...(project.creativeHandoffs ?? []), entry] }),
  );
  return entry;
}
export const resultInput = z.strictObject({
  projectId: z.uuid(),
  revision: z.number().int().positive(),
  handoffId: z.uuid(),
  candidate: pinned,
});
export async function attachCreativeResult(
  c: WorkshopContext,
  input: z.infer<typeof resultInput>,
) {
  requireEditor(c.identity);
  const wiki = await defaultWiki(c.host());
  if (input.candidate.installationId !== wiki.installationId)
    throw new Response("Result belongs to another graph", { status: 403 });
  const { revision, ...address } = input.candidate;
  const record = await c.host().call("entities.get", address);
  if (
    record.revision !== revision ||
    record.attributes.typeId !== typeIds.CreativeCandidate
  )
    throw new Response("Read the committed result candidate", { status: 409 });
  const resultBody = JSON.parse(String(record.attributes.body));
  if (
    resultBody.owner?.installationId !== c.identity.installationId ||
    resultBody.owner?.id !== input.projectId
  )
    throw new Response("Result must belong to this Workshop project", {
      status: 400,
    });
  const project = await getWorkshopProject(c.db(), input.projectId),
    entry = (project.creativeHandoffs ?? []).find(
      (h) => h.id === input.handoffId,
    );
  if (!entry) throw new Response("Handoff not found", { status: 404 });
  if (entry.result && canonical(entry.result) === canonical(input.candidate))
    return entry;
  if (
    resultBody.subject?.id !== entry.candidate.id ||
    resultBody.subject?.revision !== entry.candidate.revision
  )
    throw new Response("Result must trace back to the handed-off candidate", {
      status: 400,
    });
  if (resultBody.ownerRevision !== input.revision)
    throw new Response(
      "Result must pin the Workshop project revision used to produce it",
      { status: 409 },
    );
  return patchWorkshopProject(
    c.db(),
    c.identity,
    { id: input.projectId, revision: input.revision },
    () => ({
      creativeHandoffs: (project.creativeHandoffs ?? []).map((h) =>
        h.id === input.handoffId
          ? { ...h, result: input.candidate, state: "result-recorded" as const }
          : h,
      ),
    }),
  );
}
