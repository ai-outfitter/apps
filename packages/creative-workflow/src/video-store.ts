import { typeIds, canonical, digest } from "./index.ts";
import { requireEditor, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import {
  defaultWiki,
  stableGraphId,
  queryWikiGraph,
} from "@ai-outfitter/app-sdk/graph-client";
import type { Files } from "@ai-outfitter/app-sdk/storage";
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
type PlanningContext = ActionContext & {
  store: () => AgentDatabase;
  host: () => WorkflowHost<"interactive">;
};
import {
  saveVideoInput,
  videoReadInput,
  videoTakeInput,
  takeUpdateInput,
  videoAssetInput,
  assetCommitInput,
  publishVideoInput,
  type VideoPacket,
} from "./video-model.ts";
export type VideoContext = PlanningContext & {
  videoFiles?: () => Files;
  videoApp?: "marketing" | "planning";
};
const fail = (message: string, status = 409): never => {
  throw new Response(message, { status });
};
const same = (a: unknown, b: unknown) =>
  canonicalActionValue(a) === canonicalActionValue(b);
const scope = (c: VideoContext) => c.identity.installationId;
const query = (c: VideoContext, sql: string, params: unknown[]) =>
  c.store().query({ sql, params: params as never });
const body = (row: Record<string, unknown>) => ({
  id: String(row.id),
  revision: Number(row.revision),
  ...JSON.parse(String(row.body)),
});
export async function readProduction(c: VideoContext, id: string) {
  const [row] = await query(
    c,
    "SELECT * FROM planning_video_productions WHERE installationId=? AND id=?",
    [scope(c), id],
  );
  if (!row) return fail("Production not found", 404);
  return {
    id: String(row.id),
    revision: Number(row.revision),
    packet: JSON.parse(String(row.packet)) as VideoPacket,
  };
}
async function checkReferences(c: VideoContext, packet: VideoPacket) {
  const wiki = await defaultWiki(c.host());
  for (const ref of [
    packet.product,
    packet.productRevision,
    packet.brief,
    packet.storyboard,
    ...packet.shots.map((s) => s.snapshot),
    ...packet.shots.map((s) => s.source?.record),
  ].filter(Boolean)) {
    if (ref!.installationId !== wiki.installationId)
      fail("Sources must belong to this organization's graph", 403);
    const { revision, ...address } = ref!;
    const record = await c.host().call("entities.get", address);
    if (record.revision !== ref!.revision)
      fail("Source revision changed; read its evidence again");
  }
  for (const shot of packet.shots)
    if (shot.source?.assetId) {
      const asset = await readAsset(c, shot.source.assetId);
      if (!asset.ready) fail("Source asset is not uploaded");
      if (shot.source.artifact.contentHash !== asset.sha256)
        fail("Source citation must pin the uploaded asset hash");
    }
}
export async function saveProduction(c: VideoContext, raw: unknown) {
  requireEditor(c.identity);
  const input = saveVideoInput.parse(raw);
  const existing = await query(
    c,
    "SELECT * FROM planning_video_productions WHERE installationId=? AND id=?",
    [scope(c), input.id],
  );
  if (
    existing.length &&
    Number(existing[0].revision) === input.revision + 1 &&
    same(JSON.parse(String(existing[0].packet)), input.packet)
  )
    return readProduction(c, input.id);
  await checkReferences(c, input.packet);
  const stamp = Date.now(),
    packet = JSON.stringify(input.packet);
  const archive = {
    sql: "INSERT INTO planning_video_versions SELECT id,installationId,revision,packet FROM planning_video_productions WHERE installationId=? AND id=? AND revision=? AND packet=? ON CONFLICT DO NOTHING",
    params: [scope(c), input.id, input.revision + 1, packet],
  };
  if (input.revision === 0) {
    await c.store().batch([
      {
        sql: "INSERT INTO planning_video_productions VALUES (?,?,1,?,?,?) ON CONFLICT DO NOTHING",
        params: [input.id, scope(c), packet, stamp, stamp],
      },
      archive,
    ]);
  } else {
    await c.store().batch([
      {
        sql: "UPDATE planning_video_productions SET revision=revision+1,packet=?,updatedAt=? WHERE installationId=? AND id=? AND revision=?",
        params: [packet, stamp, scope(c), input.id, input.revision],
      },
      archive,
    ]);
  }
  const current = await readProduction(c, input.id);
  if (
    current.revision !== input.revision + 1 ||
    !same(current.packet, input.packet)
  )
    fail("Production changed; reload before editing");
  return current;
}
export async function readVideos(c: VideoContext, raw: unknown) {
  const input = videoReadInput.parse(raw);
  if (input.revision && !input.id)
    fail("A revision read requires a production ID", 400);
  const rows = input.id
    ? [await readProduction(c, input.id)]
    : await query(
        c,
        "SELECT * FROM planning_video_productions WHERE installationId=? AND id>? ORDER BY id LIMIT ?",
        [scope(c), input.after ?? "", input.limit + 1],
      );
  const more = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const items = [];
  for (const row of selected) {
    const production = await readProduction(c, String(row.id));
    if (
      input.productId &&
      (production.packet as VideoPacket).product.id !== input.productId
    )
      continue;
    if (input.revision) {
      const [version] = await query(
        c,
        "SELECT * FROM planning_video_versions WHERE installationId=? AND id=? AND revision=?",
        [scope(c), row.id, input.revision],
      );
      if (!version) fail("Storyboard version not found", 404);
      production.packet = JSON.parse(String(version.packet));
      production.revision = input.revision;
    }
    const versions = (
      await query(
        c,
        "SELECT revision FROM planning_video_versions WHERE installationId=? AND id=? ORDER BY revision DESC LIMIT 100",
        [scope(c), row.id],
      )
    ).map((v) => Number(v.revision));
    const takes = (
      await query(
        c,
        "SELECT * FROM planning_video_takes WHERE installationId=? AND productionId=? ORDER BY id",
        [scope(c), row.id],
      )
    ).map(body);
    const assets = (
      await query(
        c,
        "SELECT * FROM planning_video_assets WHERE installationId=? AND productionId=? AND ready=1 ORDER BY id",
        [scope(c), row.id],
      )
    ).map((r) => JSON.parse(String(r.body)));
    items.push({ ...production, versions, takes, assets });
  }
  return { items, next: more ? String(selected.at(-1)!.id) : null };
}
export async function prepareTake(c: VideoContext, raw: unknown) {
  requireEditor(c.identity);
  const input = videoTakeInput.parse(raw);
  const prior = await query(
    c,
    "SELECT * FROM planning_video_takes WHERE installationId=? AND id=?",
    [scope(c), input.id],
  );
  if (prior.length) {
    const take = body(prior[0]);
    if (!same(take.input, input))
      fail("Take ID already names different inputs");
    return take;
  }
  const production = await readProduction(c, input.productionId);
  if (production.revision !== input.revision)
    fail("Storyboard changed; read it again");
  const shot = production.packet.shots.find((s) => s.id === input.shotId);
  if (!shot) fail("Shot not found", 404);
  const image = shot!.source?.assetId
    ? await readAsset(c, shot!.source.assetId)
    : null;
  if (image && (!image.ready || !image.contentType.startsWith("image/")))
    fail("Image source is not ready");
  const request = {
    model: image
      ? "alibaba/wan-3.0/image-to-video"
      : "alibaba/wan-3.0/text-to-video",
    prompt: `${production.packet.style}\n${shot!.prompt}`,
    duration: shot!.duration,
    resolution: "720p",
    aspect_ratio: "9:16",
    audio: false,
    enable_prompt_expansion: false,
    enable_thinking: false,
    enable_safety_checker: true,
    seed: input.seed,
    ...(image ? { sourceAssetId: image.id } : {}),
  };
  // A linked snapshot supplies the exact text and settings used by the executor.
  let snapshotHash: string | undefined;
  if (shot!.snapshot) {
    const wiki = await defaultWiki(c.host());
    if (shot!.snapshot.installationId !== wiki.installationId)
      fail("Snapshot belongs to another graph", 403);
    const { revision, ...address } = shot!.snapshot;
    const record = await c.host().call("entities.get", address);
    if (
      record.revision !== revision ||
      record.attributes.typeId !== typeIds.GenerationSnapshot
    )
      fail("Read the committed snapshot again");
    const { hash, ...manifest } = JSON.parse(String(record.attributes.body));
    if (
      manifest.resolver !== "creative-workflow/1" ||
      (await digest(canonical(manifest))) !== hash
    )
      fail("Invalid frozen input manifest");
    for (const key of Object.keys(request).filter(
      (key) => key !== "prompt" && key !== "sourceAssetId",
    ))
      if (!(key in manifest.settings))
        fail(
          `Freeze the complete generation settings before preparing a take: missing ${key}`,
          400,
        );
    if (manifest.inputs.length !== (image ? 1 : 0))
      fail(
        "This executor requires exactly its supported source-image inputs",
        400,
      );
    // This executor supports its existing Wan request contract, not arbitrary providers.
    for (const [key, value] of Object.entries(manifest.settings)) {
      if (!(key in request) || key === "sourceAssetId" || key === "prompt")
        fail(`Unsupported frozen setting: ${key}`, 400);
      if (canonical((request as any)[key]) !== canonical(value))
        fail(`Frozen setting differs from the prepared request: ${key}`, 409);
    }
    if (
      image &&
      !manifest.inputs.some((a: any) => a.contentHash === image.sha256)
    )
      fail("Snapshot does not pin the source image");
    request.prompt = manifest.text;
    snapshotHash = hash;
  }
  const value = {
    input,
    state: "prepared",
    shot,
    request,
    ...(snapshotHash ? { snapshot: shot!.snapshot, snapshotHash } : {}),
    promptHash: await sha256Hex(canonicalActionValue(request)),
    estimatedUsd: shot!.duration * 0.1,
    createdAt: Date.now(),
  };
  await c.store().batch([
    {
      sql: "INSERT INTO planning_video_takes VALUES (?,?,?,1,?) ON CONFLICT DO NOTHING",
      params: [input.id, scope(c), input.productionId, JSON.stringify(value)],
    },
  ]);
  const [row] = await query(
    c,
    "SELECT * FROM planning_video_takes WHERE installationId=? AND id=?",
    [scope(c), input.id],
  );
  const saved = body(row);
  if (!same(saved.input, input)) fail("Take ID conflict");
  return saved;
}
export async function updateTake(c: VideoContext, raw: unknown) {
  requireEditor(c.identity);
  const input = takeUpdateInput.parse(raw);
  const [row] = await query(
    c,
    "SELECT * FROM planning_video_takes WHERE installationId=? AND id=?",
    [scope(c), input.id],
  );
  if (!row) fail("Take not found", 404);
  const take = body(row);
  const previous = take.lastUpdate;
  if (same(previous, input)) return { ...take, claimed: false };
  if (take.revision !== input.revision) fail("Take changed; reload");
  const transitions: Record<string, string[]> = {
    prepared: ["submitting"],
    submitting: ["submitted", "failed", "uncertain"],
    uncertain: ["submitted", "failed"],
    submitted: ["completed", "failed"],
    completed: [],
    failed: [],
  };
  if (!transitions[take.state]?.includes(input.state))
    fail("Invalid take transition; use a new take ID for a retake");
  if (input.state === "submitted" && !input.providerRequestId)
    fail("Provider receipt required", 400);
  if (
    take.providerRequestId &&
    input.providerRequestId &&
    take.providerRequestId !== input.providerRequestId
  )
    fail("Provider receipt cannot change");
  if (input.state === "completed") {
    if (!input.assetId) fail("Uploaded video required", 400);
    const asset = await readAsset(c, input.assetId!);
    if (
      !asset.ready ||
      asset.productionId !== String(row.productionId) ||
      asset.kind !== "take" ||
      asset.contentType !== "video/mp4" ||
      asset.productionRevision !== take.input.revision
    )
      fail("Take output does not match its production");
  }
  const { id, revision, ...value } = take;
  Object.assign(value, {
    state: input.state,
    lastUpdate: input,
    ...(input.providerRequestId
      ? { providerRequestId: input.providerRequestId }
      : {}),
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(input.error ? { error: input.error } : {}),
  });
  const changed = await query(
    c,
    "UPDATE planning_video_takes SET body=?,revision=revision+1 WHERE installationId=? AND id=? AND revision=? RETURNING *",
    [JSON.stringify(value), scope(c), input.id, input.revision],
  );
  if (!changed.length) fail("Take changed; reload");
  return { ...body(changed[0]), claimed: input.state === "submitting" };
}
export async function readAsset(c: VideoContext, id: string) {
  const [row] = await query(
    c,
    "SELECT * FROM planning_video_assets WHERE installationId=? AND id=?",
    [scope(c), id],
  );
  if (!row) fail("Asset not found", 404);
  return { ...JSON.parse(String(row.body)), ready: Boolean(row.ready) };
}
function files(c: VideoContext) {
  if (!c.videoFiles) fail("Production storage is unavailable", 503);
  return c.videoFiles!();
}
export async function reserveAsset(c: VideoContext, raw: unknown) {
  requireEditor(c.identity);
  const input = videoAssetInput.parse(raw);
  const production = await readProduction(c, input.productionId);
  if (input.productionRevision > production.revision)
    fail("Unknown production revision");
  if (
    ["take", "final"].includes(input.kind) &&
    input.contentType !== "video/mp4"
  )
    fail("Video assets require MP4", 400);
  if (input.kind === "frame" && !input.contentType.startsWith("image/"))
    fail("Frames require an image", 400);
  if (input.kind === "manifest" && input.contentType !== "application/json")
    fail("Manifests require JSON", 400);
  await c.store().batch([
    {
      sql: "INSERT INTO planning_video_assets VALUES (?,?,?,?,0) ON CONFLICT DO NOTHING",
      params: [input.id, scope(c), input.productionId, JSON.stringify(input)],
    },
  ]);
  const { ready, ...saved } = await readAsset(c, input.id);
  if (!same(saved, input)) fail("Asset ID already names different content");
  return {
    asset: saved,
    ready,
    ...(!ready
      ? {
          upload:
            input.transport === "http"
              ? {
                  url: `/api/apps/${c.videoApp ?? "planning"}/video-assets/${input.id}`,
                  method: "PUT",
                  headers: {
                    "Content-Type": input.contentType,
                    "Content-Length": String(input.size),
                  },
                }
              : files(c).uploadTicket(
                  {
                    space: "productions",
                    key: `${input.productionId}/${input.id}`,
                  },
                  input,
                ),
        }
      : {}),
  };
}
export async function commitAsset(c: VideoContext, raw: unknown) {
  requireEditor(c.identity);
  const input = assetCommitInput.parse(raw);
  const asset = await readAsset(c, input.id);
  if (asset.productionId !== input.productionId) fail("Wrong production", 404);
  if (asset.ready) return asset;
  const target = {
    space: "productions",
    key: `${input.productionId}/${input.id}`,
  };
  const bytes = await files(c).takeUpload(target, asset);
  if (!bytes) return fail("Upload has not arrived", 409);
  await files(c).put(target.space, target.key, bytes, {
    contentType: asset.contentType,
  });
  await c.store().batch([
    {
      sql: "UPDATE planning_video_assets SET ready=1 WHERE installationId=? AND id=?",
      params: [scope(c), input.id],
    },
  ]);
  await files(c).discardUpload(target, asset);
  return readAsset(c, input.id);
}
export async function publishProduction(c: VideoContext, raw: unknown) {
  requireEditor(c.identity);
  const input = publishVideoInput.parse(raw);
  const production = await readProduction(c, input.id);
  if (production.revision !== input.revision)
    fail("Production changed; read again");
  const wiki = await defaultWiki(c.host());
  const id = await stableGraphId(`planning-video:${scope(c)}:${input.id}`);
  const ref = { installationId: wiki.installationId, type: "graph-node", id };
  const attributes = {
    id,
    title: production.packet.title,
    summary:
      "Marketing production with versioned storyboard and private video assets",
    typeId: "71000000-0000-4000-8000-000000000012",
    body: JSON.stringify({
      recordKind: "marketing-production",
      planningInstallationId: scope(c),
      productionId: input.id,
      productionRevision: input.revision,
      ...production.packet,
    }),
    properties: {},
    archived: false,
  };
  let current;
  try {
    current = await c.host().call("entities.get", ref);
  } catch (error) {
    if (!(error instanceof Response && error.status === 404)) throw error;
  }
  const references = [
    production.packet.product,
    ...(production.packet.productRevision
      ? [production.packet.productRevision]
      : []),
  ].map(({ revision, ...r }) => r);
  const call = async (action: string, input: unknown) =>
    c.host().call("actions.call", {
      installationId: wiki.installationId,
      action,
      input: JSON.parse(JSON.stringify(input)),
    }) as Promise<any>;
  const opened = await call("batch.open", {
    title: production.packet.title,
    purpose: "Publish marketing production",
    anchors: references.map((r) => r.id),
    policy: { kind: "member" },
  });
  const nodeRef = "$production";
  const proposals: any[] = [
    {
      operation: current
        ? {
            operation: "update",
            ref: nodeRef,
            type: "graph-node",
            id,
            revision: current.revision,
            attributes,
          }
        : { operation: "create", ref: nodeRef, type: "graph-node", attributes },
    },
  ];
  for (const target of references) {
    const edgeId = await stableGraphId(
      "planning-video-documents",
      id,
      target.id,
    );
    try {
      await c.host().call("entities.get", {
        installationId: wiki.installationId,
        type: "graph-edge",
        id: edgeId,
      });
    } catch (error) {
      if (!(error instanceof Response && error.status === 404)) throw error;
      proposals.push({
        operation: {
          operation: "create",
          ref: `$edge_${target.id.replaceAll("-", "")}`,
          type: "graph-edge",
          attributes: {
            id: edgeId,
            typeId: "71000000-0000-4000-8000-000000000031",
            fromId: nodeRef,
            toId: target.id,
          },
        },
      });
    }
  }
  await call("batch.add", { batchId: opened.batch.id, proposals });
  return { ref, batchId: opened.batch.id, state: "draft" };
}

/** Bounded product/revision evidence selection through the owner's graph provider. */
export async function videoSourceEvidence(
  c: VideoContext,
  productId: string,
  cursor?: string,
) {
  return queryWikiGraph(c.host(), {
    maxBytes: 256 * 1024,
    queries: [
      {
        name: "evidence",
        entity: "node",
        ids: [productId],
        types: ["Product", "SoftwareProduct"],
        fields: "full",
        limit: 1,
        ...(cursor ? { cursor } : {}),
        expand: {
          edgeTypes: [
            "revision_of",
            "evidence_for",
            "includes_record",
            "demonstrates",
          ],
          direction: "both",
          depth: 3,
          maxNodes: 100,
        },
      },
    ],
  });
}

export async function uploadAssetBytes(
  c: VideoContext,
  id: string,
  bytes: Uint8Array,
) {
  requireEditor(c.identity);
  const asset = await readAsset(c, id);
  if (
    bytes.byteLength !== asset.size ||
    (await sha256Hex(new Uint8Array(bytes))) !== asset.sha256
  )
    fail("Uploaded bytes do not match the reserved size and hash", 422);
  if (asset.ready) return asset;
  await files(c).put(
    "productions",
    `${asset.productionId}/${asset.id}`,
    bytes,
    { contentType: asset.contentType },
  );
  await c.store().batch([
    {
      sql: "UPDATE planning_video_assets SET ready=1 WHERE installationId=? AND id=?",
      params: [scope(c), id],
    },
  ]);
  return readAsset(c, id);
}
