import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { actionPath } from "@ai-outfitter/app-sdk/actions";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { parseDirectUpload } from "@ai-outfitter/app-sdk/storage";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker, type Member } from "@ai-outfitter/app-test/worker";
import { getOperationAST } from "graphql";
import type { z } from "zod";
import type { AssemblySchema } from "../../src/lib/assembly";
import type { CadPlan } from "../../src/model/cad-plan";
import { ProjectSchema } from "../../src/lib/project";
import { documents } from "../../src/server/documents";

// Tier 2: a solo researcher builds outdoor and bench field-instrument variants
// around the same purchased probe connector. Original photos and explicit
// interface measurements let the researcher evaluate clearance at the cable exit.
export const fixtureMember: Member = {
  userId: "field-researcher",
  organizationId: "shared-cots-fixture",
  role: "owner",
};

export const probeName = "Field probe connector";
export const partNumber = "FIXTURE-PROBE";
export const supplierSource = "https://parts.example.test/catalog/FIXTURE-PROBE";
export const connectorEnvelope: CadPlan = {
  version: 1,
  units: "mm",
  features: [{ kind: "box", mode: "add", origin: [0, 0, 0], size: [18, 8, 6] }],
};
export const photoInputs = [
  {
    fileName: "connector-face.png",
    observation: "Connector face viewed along fixture X",
    width: 16,
    height: 12,
    original: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAIAAADkharWAAAAFUlEQVR4nGOQaogjCTGMahjVgB0BAHfHugGDB3F5AAAAAElFTkSuQmCC",
      "base64",
    ),
  },
  {
    fileName: "cable-exit.png",
    observation: "Cable exit viewed along fixture Z",
    width: 12,
    height: 16,
    original: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAQCAIAAACtAwlQAAAAFUlEQVR4nGPIMF9CEDGMKhpVRJwiAP+p8kHjurryAAAAAElFTkSuQmCC",
      "base64",
    ),
  },
] as const;

type DocumentName = keyof typeof documents;
type GraphReply<T> = {
  data?: Record<string, T | null> | null;
  errors?: { message: string; extensions?: { code?: string; status?: number } }[];
};

type AttachedPhoto = {
  projectId: string;
  fileName: string;
  contentType: string;
  sha256: string;
  bytes: number;
  downloadPath: string;
};

type UploadReply = {
  itemId?: string;
  revision?: number;
  file?: AttachedPhoto;
  upload?: { url: string };
};

export function purchasedPart(name = probeName, number = partNumber) {
  return {
    id: randomUUID(), name, number, revision: "A", kind: "cots",
    manufacturer: "Fixture Components", mpn: number, geometry: connectorEnvelope,
  } as const;
}

export function assemblyItem(name: string, number: string, placements: { itemId: string; quantity?: number; refdes: string }[]) {
  return {
    id: randomUUID(),
    name,
    number,
    revision: "A",
    kind: "assembly",
    uses: placements.map(({ itemId, quantity = 1, refdes }, index) => ({
      id: randomUUID(), itemId, quantity, refdes, position: [index * 20, 0, 0],
    })),
  } satisfies z.input<typeof AssemblySchema>["items"][number];
}

export async function sharedCotsWorker(member = fixtureMember) {
  const app = await appWorker(
    "workshop",
    appArtifact(new URL("../..", import.meta.url), "operational"),
    member.organizationId,
  );

  async function callGraph<T>(name: DocumentName, variables: Record<string, unknown>, member?: Member) {
    const document = documents[name].document;
    const action = getOperationAST(document)?.operation === "mutation" ? "graph.mutate" : "graph.graphql";
    const response = await app.call(`${actionPath}/call`, member, {
      method: "POST",
      body: { action, input: { query: documentText(document), variables } },
    });
    const body = await response.text();
    const result = response.headers.get("content-type")?.includes("application/json")
      ? JSON.parse(body) as GraphReply<T>
      : { errors: [{ message: body }] };
    return { status: response.status, result };
  }

  async function graph<T>(name: DocumentName, variables: Record<string, unknown>) {
    const { status, result } = await callGraph<T>(name, variables, member);
    const field = name[0].toLowerCase() + name.slice(1);
    assert.equal(status, 200, JSON.stringify(result));
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const value = result.data?.[field];
    assert.ok(value != null, `Missing GraphQL result for ${name}`);
    return value;
  }

  async function createProject(name: string, purpose: "product" | "component" = "product") {
    const response = await app.call("/api/apps/workshop/projects", member, {
      method: "POST",
      body: { name, purpose, example: "cube" },
    });
    assert.equal(response.status, 201, await response.clone().text());
    return ProjectSchema.parse(await response.json());
  }

  async function saveAssembly(projectId: string, expectedRevision: number, assembly: z.input<typeof AssemblySchema>) {
    return graph<{
      projectId: string;
      revision: number;
      cotsWarnings: { code: string; message: string; itemId: string; interfaceId?: string }[];
    }>("UpdateWorkshopAssembly", {
      projectId, expectedRevision, assembly,
    });
  }

  async function attachPhoto(projectId: string, itemId: string, expectedRevision: number, photo: { fileName: string; observation: string; width: number; height: number; original: Buffer }) {
    const sha256 = createHash("sha256").update(photo.original).digest("hex");
    const input = { projectId, itemId, expectedRevision, fileName: photo.fileName, sha256, bytes: photo.original.length };
    const { upload } = await graph<UploadReply>("UploadWorkshopAssemblyFile", { input });
    assert.ok(upload);
    const ticket = parseDirectUpload(upload.url);
    assert.ok(ticket);
    // Use the test host's bucket to complete the presigned PUT locally.
    await (await app.bucket("main")).put(ticket.key, photo.original);
    const { file, itemId: attachedTo, revision } = await graph<UploadReply>("UploadWorkshopAssemblyFile", { input });
    assert.ok(file);
    assert.equal(revision, expectedRevision + 1);
    assert.equal(file.projectId, projectId);
    assert.equal(attachedTo, itemId);
    assert.equal(file.fileName, photo.fileName);
    assert.equal(file.sha256, sha256);
    assert.equal(file.bytes, photo.original.length);
    assert.equal(file.contentType, "image/png");
    return { file, revision, photo };
  }

  return { app, callGraph, graph, createProject, saveAssembly, attachPhoto };
}

export async function seedSharedCots(fixture: Awaited<ReturnType<typeof sharedCotsWorker>>) {
  const { createProject, saveAssembly, attachPhoto, graph } = fixture;

  const owner = await createProject("Probe connector library", "component");
  const canonical = { ...purchasedPart(), source: supplierSource };
  const ownerRoot = assemblyItem("Purchased reference", "REFERENCE", [{ itemId: canonical.id, refdes: "J1" }]);
  const ownerSave = await saveAssembly(owner.id, owner.revision, { rootId: ownerRoot.id, items: [ownerRoot, canonical] });
  const firstPhoto = await attachPhoto(owner.id, canonical.id, ownerSave.revision, photoInputs[0]);
  const secondPhoto = await attachPhoto(owner.id, canonical.id, firstPhoto.revision, photoInputs[1]);
  const photos = [firstPhoto, secondPhoto];
  const duplicatePhoto = await attachPhoto(owner.id, ownerRoot.id, secondPhoto.revision, {
    ...photoInputs[0], fileName: "reference-assembly-face.png",
    observation: "Same connector face photo on the reference assembly",
  });

  const outdoor = await createProject("Outdoor field instrument");
  const outdoorPart = { ...purchasedPart(), cotsEvidenceRef: { projectId: owner.id, itemId: canonical.id } };
  const absentPart = purchasedPart("Unmeasured gland", "FIXTURE-GLAND");
  const outdoorRoot = assemblyItem("Outdoor enclosure", "OUTDOOR", [
    { itemId: outdoorPart.id, refdes: "J1", quantity: 2 },
    { itemId: outdoorPart.id, refdes: "J3" },
    { itemId: absentPart.id, refdes: "G1" },
  ]);
  const outdoorSave = await saveAssembly(outdoor.id, outdoor.revision, {
    rootId: outdoorRoot.id, items: [outdoorRoot, outdoorPart, absentPart],
  });

  const insert = await createProject("Bench connector insert", "component");
  const insertPart = { ...purchasedPart(), cotsEvidenceRef: { projectId: outdoor.id, itemId: outdoorPart.id } };
  const insertRoot = assemblyItem("Connector insert", "INSERT", [{ itemId: insertPart.id, refdes: "J1" }]);
  const insertSave = await saveAssembly(insert.id, insert.revision, { rootId: insertRoot.id, items: [insertRoot, insertPart] });

  const carrier = await createProject("Bench carrier", "component");
  const insertMount = {
    ...assemblyItem("Install connector insert", "INSERT-MOUNT", []),
    reference: { projectId: insert.id, revision: insertSave.revision },
  };
  const carrierRoot = assemblyItem("Carrier", "CARRIER", [{ itemId: insertMount.id, refdes: "A1" }]);
  const carrierSave = await saveAssembly(carrier.id, carrier.revision, {
    rootId: carrierRoot.id, items: [carrierRoot, insertMount],
  });

  const bench = await createProject("Bench field instrument");
  const carrierMount = {
    ...assemblyItem("Install carrier", "CARRIER-MOUNT", []),
    reference: { projectId: carrier.id, revision: carrierSave.revision },
  };
  const benchRoot = assemblyItem("Bench enclosure", "BENCH", [
    { itemId: carrierMount.id, refdes: "A1" },
    { itemId: carrierMount.id, refdes: "A2" },
  ]);
  const benchSave = await saveAssembly(bench.id, bench.revision, {
    rootId: benchRoot.id, items: [benchRoot, carrierMount],
  });

  const evidence = {
    photos: [
      ...photos.map(({ file, photo, revision }) => ({
        fileName: file.fileName,
        sha256: file.sha256,
        attachmentRevision: revision,
        observation: photo.observation,
      })),
      {
        fileName: duplicatePhoto.file.fileName,
        sha256: duplicatePhoto.file.sha256,
        attachmentRevision: duplicatePhoto.revision,
        observation: duplicatePhoto.photo.observation,
        attachmentOwner: { projectId: owner.id, itemId: ownerRoot.id },
      },
    ],
    interfaces: [
      {
        id: randomUUID(),
        feature: "Connector depth at cable exit",
        datum: "Mating face",
        axis: "X+ from the mating face toward the cable exit",
        unit: "mm",
        nominal: { value: 18, basis: "supplier", source: "Synthetic supplier envelope" },
        measured: { value: 18.2, basis: "owned-part", source: "Synthetic caliper observation" },
        tolerance: { kind: "specified", minus: 0.4, plus: 0.3 },
        photoSha256s: [firstPhoto.file.sha256],
        verification: {
          status: "fits",
          trialId: randomUUID(),
          testedProjectId: outdoor.id,
          testedRevision: outdoorSave.revision,
          observation: "The cable clears the outdoor enclosure at the mating face.",
          photoSha256s: [secondPhoto.file.sha256],
        },
      },
      {
        id: randomUUID(),
        feature: "Latch clearance",
        datum: "Latch shoulder",
        axis: "Z+ away from the board",
        unit: "mm",
        nominal: { value: 3, basis: "design", source: "Synthetic insert layout" },
        tolerance: { kind: "unknown" },
        photoSha256s: [],
        verification: { status: "untested" },
      },
    ],
  } as const;

  const recordInput = { projectId: owner.id, itemId: canonical.id, expectedRevision: duplicatePhoto.revision, evidence };
  async function recordEvidence() {
    const record = await graph<{ projectId: string; revision: number }>("RecordWorkshopCotsEvidence", { input: recordInput });
    assert.equal(record.projectId, owner.id);
    assert.equal(record.revision, duplicatePhoto.revision + 1);
    return { ...owner, revision: record.revision };
  }
  return {
    recordEvidence,
    outdoor: { ...outdoor, revision: outdoorSave.revision },
    bench: { ...bench, revision: benchSave.revision },
    insert: { ...insert, revision: insertSave.revision },
    carrier: { ...carrier, revision: carrierSave.revision },
    canonical, ownerRoot, outdoorPart, absentPart, photos, duplicatePhoto, recordInput, outdoorSave,
  };
}
