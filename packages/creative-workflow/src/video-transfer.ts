import { z } from "zod";
import { requireEditor } from "@ai-outfitter/app-sdk/server";
import { canonical, digest } from "./index.ts";
import { readProduction, type VideoContext } from "./video-store.ts";
export const transferInput = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  targetInstallationId: z.string().min(1),
});
export const importTransferInput = z.strictObject({
  id: z.uuid(),
  sourceInstallationId: z.string().min(1),
});
const rows = (c: VideoContext, sql: string, params: any[]) =>
  c.store().query({ sql, params });
async function seal(c: VideoContext, id: string) {
  const [row] = await rows(
    c,
    "SELECT * FROM planning_video_transfers WHERE installationId=? AND productionId=?",
    [c.identity.installationId, id],
  );
  return row;
}
export async function beginTransfer(
  c: VideoContext,
  input: z.infer<typeof transferInput>,
) {
  requireEditor(c.identity);
  if (input.targetInstallationId === c.identity.installationId)
    throw new Response("Choose another installation", { status: 400 });
  await readProduction(c, input.id);
  await c.store().batch([
    {
      sql: `INSERT INTO planning_video_transfers (installationId,productionId,targetInstallationId,state) SELECT ?,?,?,'sealed' WHERE EXISTS (SELECT 1 FROM planning_video_productions WHERE installationId=? AND id=? AND revision=?) AND NOT EXISTS (SELECT 1 FROM planning_video_takes WHERE installationId=? AND productionId=? AND json_extract(body,'$.state') IN ('submitting','submitted','uncertain')) AND NOT EXISTS (SELECT 1 FROM planning_video_assets WHERE installationId=? AND productionId=? AND ready=0) ON CONFLICT DO NOTHING`,
      params: [
        c.identity.installationId,
        input.id,
        input.targetInstallationId,
        c.identity.installationId,
        input.id,
        input.revision,
        c.identity.installationId,
        input.id,
        c.identity.installationId,
        input.id,
      ],
    },
  ]);
  const value = await seal(c, input.id);
  if (!value || value.targetInstallationId !== input.targetInstallationId)
    throw new Response(
      "Revision changed, transfer already bound, or submissions/uploads require reconciliation",
      { status: 409 },
    );
  return value;
}
export async function exportTransfer(c: VideoContext, id: string) {
  requireEditor(c.identity);
  const transfer = await seal(c, id);
  if (!transfer)
    throw new Response("Seal the production before transfer", { status: 409 });
  const installationId = c.identity.installationId;
  const production = (
    await rows(
      c,
      "SELECT * FROM planning_video_productions WHERE installationId=? AND id=?",
      [installationId, id],
    )
  )[0];
  const versions = await rows(
    c,
    "SELECT * FROM planning_video_versions WHERE installationId=? AND id=? ORDER BY revision",
    [installationId, id],
  );
  const takes = await rows(
    c,
    "SELECT * FROM planning_video_takes WHERE installationId=? AND productionId=? ORDER BY id",
    [installationId, id],
  );
  const assets = await rows(
    c,
    "SELECT * FROM planning_video_assets WHERE installationId=? AND productionId=? ORDER BY id",
    [installationId, id],
  );
  const data = { production, versions, takes, assets };
  return {
    targetInstallationId: transfer.targetInstallationId,
    data,
    hash: await digest(canonical(data)),
  };
}
async function call(
  c: VideoContext,
  installationId: string,
  query: string,
  variables: unknown,
) {
  const result: any = await c.host().call("actions.call", {
    installationId,
    action: "graph.graphql",
    input: JSON.parse(JSON.stringify({ query, variables })),
    readOnly: true,
  });
  if (result.errors?.length)
    throw new Response("Transfer source unavailable", { status: 502 });
  return result.data;
}
export async function importTransfer(
  c: VideoContext,
  input: z.infer<typeof importTransferInput>,
) {
  requireEditor(c.identity);
  const data = await call(
      c,
      input.sourceInstallationId,
      "query($id:ID!){videoTransfer(id:$id)}",
      { id: input.id },
    ),
    bundle = data.videoTransfer;
  if (
    bundle.targetInstallationId !== c.identity.installationId ||
    (await digest(canonical(bundle.data))) !== bundle.hash
  )
    throw new Response("Transfer is not bound to this installation", {
      status: 403,
    });
  const existing = await rows(
    c,
    "SELECT * FROM planning_video_imports WHERE installationId=? AND productionId=?",
    [c.identity.installationId, input.id],
  );
  if (existing.length) {
    if (
      existing[0].hash !== bundle.hash ||
      existing[0].sourceInstallationId !== input.sourceInstallationId
    )
      throw new Response("Transfer identity changed", { status: 409 });
    return { id: input.id, hash: bundle.hash };
  }
  const [collision] = await rows(
    c,
    "SELECT id FROM planning_video_productions WHERE installationId=? AND id=?",
    [c.identity.installationId, input.id],
  );
  if (collision)
    throw new Response("Destination ID already exists", { status: 409 });
  const p = bundle.data.production;
  if (p.id !== input.id || p.installationId !== input.sourceInstallationId)
    throw new Response("Source identity mismatch", { status: 409 });
  const statements: any[] = [
    {
      sql: "INSERT INTO planning_video_productions VALUES (?,?,?,?,?,?)",
      params: [
        p.id,
        c.identity.installationId,
        p.revision,
        p.packet,
        p.createdAt,
        p.updatedAt,
      ],
    },
  ];
  for (const v of bundle.data.versions)
    statements.push({
      sql: "INSERT INTO planning_video_versions VALUES (?,?,?,?)",
      params: [p.id, c.identity.installationId, v.revision, v.packet],
    });
  for (const t of bundle.data.takes)
    statements.push({
      sql: "INSERT INTO planning_video_takes VALUES (?,?,?,?,?)",
      params: [t.id, c.identity.installationId, p.id, t.revision, t.body],
    });
  for (const a of bundle.data.assets)
    statements.push({
      sql: "INSERT INTO planning_video_assets VALUES (?,?,?,?,0)",
      params: [a.id, c.identity.installationId, p.id, a.body],
    });
  statements.push({
    sql: "INSERT INTO planning_video_imports VALUES (?,?,?,?)",
    params: [
      c.identity.installationId,
      p.id,
      input.sourceInstallationId,
      bundle.hash,
    ],
  });
  await c.store().batch(statements);
  return {
    id: p.id,
    hash: bundle.hash,
    assets: bundle.data.assets.map((a: any) => JSON.parse(a.body)),
  };
}
export async function transferReceipt(c: VideoContext, id: string) {
  requireEditor(c.identity);
  const [receipt] = await rows(
    c,
    "SELECT * FROM planning_video_imports WHERE installationId=? AND productionId=?",
    [c.identity.installationId, id],
  );
  if (!receipt) throw new Response("Import not found", { status: 404 });
  const assets = await rows(
    c,
    "SELECT * FROM planning_video_assets WHERE installationId=? AND productionId=? ORDER BY id",
    [c.identity.installationId, id],
  );
  const source = String(receipt.sourceInstallationId),
    normalize = (row: any) => ({ ...row, installationId: source });
  const production = (
    await rows(
      c,
      "SELECT * FROM planning_video_productions WHERE installationId=? AND id=?",
      [c.identity.installationId, id],
    )
  )[0];
  const versions = await rows(
    c,
    "SELECT * FROM planning_video_versions WHERE installationId=? AND id=? ORDER BY revision",
    [c.identity.installationId, id],
  );
  const takes = await rows(
    c,
    "SELECT * FROM planning_video_takes WHERE installationId=? AND productionId=? ORDER BY id",
    [c.identity.installationId, id],
  );
  if (
    (await digest(
      canonical({
        production: normalize(production),
        versions: versions.map(normalize),
        takes: takes.map(normalize),
        assets: assets.map((a) => ({ ...normalize(a), ready: 1 })),
      }),
    )) !== receipt.hash
  )
    throw new Response("Imported metadata changed before transfer acceptance", {
      status: 409,
    });
  for (const row of assets) {
    const asset = JSON.parse(String(row.body));
    if (!row.ready)
      throw new Response("Media transfer is incomplete", { status: 409 });
    const file = await c.videoFiles!().get({
      space: "productions",
      key: `${id}/${row.id}`,
    });
    if (!file || file.sha256 !== asset.sha256 || file.size !== asset.size)
      throw new Response("Media verification failed", { status: 409 });
  }
  return receipt;
}
export async function finishTransfer(c: VideoContext, id: string) {
  requireEditor(c.identity);
  const transfer = await seal(c, id);
  if (!transfer) throw new Response("Transfer not found", { status: 404 });
  const bundle = await exportTransfer(c, id);
  const result = await call(
    c,
    String(transfer.targetInstallationId),
    "query($id:ID!){videoTransferReceipt(id:$id)}",
    { id },
  );
  if (
    result.videoTransferReceipt.sourceInstallationId !==
      c.identity.installationId ||
    result.videoTransferReceipt.hash !== bundle.hash
  )
    throw new Response("Destination receipt mismatch", { status: 409 });
  await c.store().batch([
    {
      sql: "UPDATE planning_video_transfers SET state='complete' WHERE installationId=? AND productionId=?",
      params: [c.identity.installationId, id],
    },
  ]);
  return { ...transfer, state: "complete" };
}
