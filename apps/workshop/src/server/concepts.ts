import { artifactRef } from "@ai-outfitter/app-sdk/evidence";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { defaultWiki, typeSegment } from "@ai-outfitter/app-sdk/wiki";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  CONCEPT_LIMIT,
  type Concept,
  ConceptSchema,
  type Project,
  ProjectSchema,
} from "../lib/project";
import type { WorkshopContext } from "./graphql";
import { getWorkshopProject, type WorkshopDatabase } from "./projects";
import { workshopProjects } from "./schema";

// Concept mockups: what we think the physical product will look like. The
// bytes go to the installation's own bucket (docs/app-storage.md), in a public
// space so the Wiki Document and a website can show them; the project document
// keeps only the reference and stays far under its size cap.
export const CONCEPT_SPACE = "concepts";
export const MAX_CONCEPT_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;
type ImageType = keyof typeof EXTENSIONS;

const stale = () =>
  new Response("Project changed in another session. Reload before saving.", {
    status: 409,
  });

/** The project at the revision the request names, or 409. */
async function currentAt(db: WorkshopDatabase, id: string, revision: number) {
  const current = await getWorkshopProject(db, id);
  if (current.revision !== revision) throw stale();
  return current;
}

/** Saves the project's concepts as its next revision; 409 when another session saved first. */
async function saveConcepts(
  db: WorkshopDatabase,
  identity: AppIdentity,
  current: Project,
  concepts: Concept[],
) {
  const saved = ProjectSchema.parse({
    ...current,
    concepts,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  const [updated] = await db
    .update(workshopProjects)
    .set({
      revision: saved.revision,
      data: JSON.stringify(saved),
      updatedBy: identity.userId,
      updatedAt: saved.updatedAt,
    })
    .where(
      and(
        eq(workshopProjects.id, current.id),
        eq(workshopProjects.revision, current.revision),
      ),
    )
    .returning({ id: workshopProjects.id });
  if (!updated) throw stale();
  return saved;
}

const addQuery = z
  .object({
    revision: z.coerce.number().int().nonnegative(),
    prompt: ConceptSchema.shape.prompt.default(""),
    model: ConceptSchema.shape.model.default("upload"),
    caption: ConceptSchema.shape.caption.default(""),
  })
  .strict();

/**
 * Stores the request body (an image) as a concept of the project. The query
 * names the project revision it applies to, the prompt, the model ("upload"
 * for an image made elsewhere) and an optional caption. The platform's image
 * generator saves its result through this same route as the member.
 */
export async function addConcept(
  context: WorkshopContext,
  request: Request,
  projectId: string,
) {
  const db = context.db();
  const query = addQuery.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success)
    throw new Response("Name the project revision, prompt and model.", {
      status: 400,
    });
  const type = (request.headers.get("Content-Type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!Object.hasOwn(EXTENSIONS, type))
    throw new Response("Upload a PNG, JPEG or WebP image.", { status: 415 });
  // Refused from the declared length before the body is read; checked again after.
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_CONCEPT_BYTES)
    throw new Response("Images are at most 10 MB.", { status: 413 });
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength)
    throw new Response("The image is empty.", { status: 400 });
  if (bytes.byteLength > MAX_CONCEPT_BYTES)
    throw new Response("Images are at most 10 MB.", { status: 413 });
  const current = await currentAt(db, projectId, query.data.revision);
  if (current.concepts.length >= CONCEPT_LIMIT)
    throw new Response(
      `A project keeps up to ${CONCEPT_LIMIT} concepts. Remove one first.`,
      { status: 409 },
    );
  const id = crypto.randomUUID();
  const key = `${current.id}/${id}.${EXTENSIONS[type as ImageType]}`;
  const files = context.storage();
  const stored = await files.put(CONCEPT_SPACE, key, bytes, {
    contentType: type,
  });
  const concept: Concept = {
    id,
    key,
    contentType: type as ImageType,
    sha256: stored.sha256,
    prompt: query.data.prompt,
    model: query.data.model,
    caption: query.data.caption,
    createdAt: new Date().toISOString(),
  };
  // A save that loses the revision race leaves no orphaned file.
  try {
    return await saveConcepts(db, context.identity, current, [
      ...current.concepts,
      concept,
    ]);
  } catch (error) {
    await files.delete({ space: CONCEPT_SPACE, key });
    throw error;
  }
}

/** The RemoveWorkshopConcept mutation's input: the concept, at the project revision the caller saw. */
export const removeInput = z
  .object({
    projectId: z.uuid(),
    conceptId: z.string().min(1).max(64),
    revision: z.number().int().nonnegative(),
  })
  .strict();

/** Drops a concept's reference from the project, then its file. Answers the saved project. */
export async function removeConcept(
  context: WorkshopContext,
  { projectId, conceptId, revision }: z.infer<typeof removeInput>,
) {
  const db = context.db();
  const current = await currentAt(db, projectId, revision);
  const concept = current.concepts.find((item) => item.id === conceptId);
  if (!concept) throw new Response("Concept not found", { status: 404 });
  // The reference first: the gallery never shows a file that is gone.
  const saved = await saveConcepts(
    db,
    context.identity,
    current,
    current.concepts.filter((item) => item.id !== conceptId),
  );
  await context.storage().delete({ space: CONCEPT_SPACE, key: concept.key });
  return saved;
}

/** Where a concept is served, on the Workshop's own host (storageRoutes). */
export const conceptUrl = (origin: string, concept: Pick<Concept, "key">) =>
  `${origin}/files/main/${CONCEPT_SPACE}/${concept.key}`;

// --- Publishing to the Wiki ---------------------------------------------------

/** Seeded Wiki IDs (catalog/apps/wiki-map/seeds: types-v1, artifacts-v1, hardware-v1). */
export const WIKI_IDS = {
  Document: "71000000-0000-4000-8000-000000000012",
  documents: "71000000-0000-4000-8000-000000000031",
  applies_definition: "76000000-0000-4000-8000-000000000017",
  /** The "Design concept" ArtifactDefinition; absent in Wikis without the hardware seed. */
  designConcept: "7b000000-0000-4000-8000-000000000011",
};
/**
 * The hardware seed ships `evidence_for`; a Wiki that made its own from an
 * evidence bundle before the seed keeps its ID, so the type is looked up by name.
 */
const EVIDENCE_FOR = "evidence_for";
/** The PublishWorkshopConcepts mutation's input: the project at the revision the caller saw. */
export const publishInput = z
  .object({
    projectId: z.uuid(),
    /** The Wiki ProductRevision the concepts are evidence for. */
    productRevisionId: z.uuid(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

type Subject = { id: string; revision: number; title: string };
type Operation = {
  ref: string;
  type: "graph-node" | "graph-edge";
  operation: "create";
  attributes: Record<string, z.core.util.JSONType>;
};

/**
 * One Document "<revision> — design concepts": a JSON body listing every
 * concept's image URL and prompt (the Design concept definition's shape),
 * `evidence_for` and `documents` the revision, and `applies_definition` the
 * seeded definition when the Wiki has it. Pure, for tests.
 */
export function conceptOperations(input: {
  project: Pick<Project, "id" | "name" | "concepts">;
  origin: string;
  installationId: string;
  subject: Subject;
  definition: { id: string; revision: number } | null;
  evidenceForTypeId: string;
}) {
  const { project, origin, installationId, subject, definition, evidenceForTypeId } = input;
  // Each image is cited in the shared evidence shape (docs/architecture/evidence.md).
  const images = project.concepts.map((concept) => ({
    artifact: artifactRef.parse({
      provider: "workshop",
      recordId: `${installationId}/main/${CONCEPT_SPACE}/${concept.key}`,
      uri: conceptUrl(origin, concept),
      contentHash: concept.sha256,
    }),
    prompt: concept.prompt,
    model: concept.model,
    createdAt: concept.createdAt,
    ...(concept.caption ? { caption: concept.caption } : {}),
  }));
  const title = `${subject.title} — design concepts`;
  const edge = (ref: string, typeId: string, toId: string): Operation => ({
    ref,
    type: "graph-edge",
    operation: "create",
    attributes: { typeId, fromId: "$document", toId, properties: {} },
  });
  const operations: Operation[] = [
    {
      ref: "$document",
      type: "graph-node",
      operation: "create",
      attributes: {
        typeId: WIKI_IDS.Document,
        title,
        summary: `${images.length} concept mockup${images.length === 1 ? "" : "s"} of ${subject.title} from the Workshop project "${project.name}": design intent, not photographs or measurements.`,
        body: JSON.stringify(
          {
            subject: { id: subject.id, revision: subject.revision },
            ...(definition ? { definition } : {}),
            source: { type: "workshop-project", id: project.id },
            images,
          },
          null,
          2,
        ),
      },
    },
    edge("$evidence-for", evidenceForTypeId, subject.id),
    edge("$documents", WIKI_IDS.documents, subject.id),
    ...(definition
      ? [edge("$applies-definition", WIKI_IDS.applies_definition, definition.id)]
      : []),
  ];
  return operations;
}

type Host = WorkflowHost<"interactive">;
async function wikiRecord(host: Host, installationId: string, id: string) {
  try {
    return await host.call("entities.get", {
      installationId,
      type: "graph-node",
      id,
    });
  } catch (error) {
    if (error instanceof Response && error.status === 404) return null;
    throw error;
  }
}

/** Publishes the project's concepts to the owner's Wiki as the member. */
export async function publishConcepts(
  context: WorkshopContext,
  input: z.infer<typeof publishInput>,
) {
  const project = await currentAt(context.db(), input.projectId, input.revision);
  if (!project.concepts.length)
    throw new Response("Add a concept before publishing.", { status: 409 });
  const host = context.host();
  const wiki = await defaultWiki(host);
  if (!wiki.writable)
    throw new Response("You cannot write to this Wiki.", { status: 403 });
  const [revision, definition, types] = await Promise.all([
    wikiRecord(host, wiki.installationId, input.productRevisionId),
    wikiRecord(host, wiki.installationId, WIKI_IDS.designConcept),
    host.call("entities.list", {
      installationId: wiki.installationId,
      type: "graph-type",
      filter: { names: [EVIDENCE_FOR] },
      limit: 10,
    }),
  ]);
  if (!revision)
    throw new Response("That product revision is not in your Wiki.", {
      status: 404,
    });
  const evidenceForTypeId = types.find((row) => !row.attributes.archived)?.ref.id;
  if (!evidenceForTypeId)
    throw new Response("Your Wiki has no evidence_for type yet. Update the Wiki, then publish.", {
      status: 409,
    });
  const subject = {
    id: revision.ref.id,
    revision: revision.revision,
    title: revision.title,
  };
  const operations = conceptOperations({
    project,
    origin: context.origin(),
    installationId: context.identity.installationId,
    subject,
    definition: definition
      ? { id: definition.ref.id, revision: definition.revision }
      : null,
    evidenceForTypeId,
  });
  const receipt = z
    .record(z.string(), z.object({ id: z.string() }))
    .parse(
      await host.call("actions.call", {
        installationId: wiki.installationId,
        action: "graph.apply",
        input: {
          // An identical retry of the same project revision returns the same Document.
          requestKey: `workshop-concepts:${project.id}:${project.revision}:${subject.id}`,
          preconditions: [
            { type: "graph-node", id: subject.id, revision: subject.revision },
          ],
          operations,
        },
      }),
    );
  const documentId = receipt.$document.id;
  return {
    documentId,
    url: wiki.hostname
      ? `https://${wiki.hostname}/${typeSegment("Document")}/${documentId}`
      : null,
  };
}
