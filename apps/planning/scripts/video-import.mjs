/** Import an existing private film through the same documents used by MCP agents.
 * call(document, variables) returns the unwrapped GraphQL data object.
 * upload(ticket, bytes) must use the authenticated installation scope for relative URLs.
 * The caller supplies transport/auth; this module never reads credentials.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export async function importProduction(
  manifest,
  { call, upload, transport = "direct" },
) {
  const { id, packet, assets } = manifest;
  let current, after;
  do {
    const page = (await call("VideoProductions", after ? { after } : {}))
      .videoProductions;
    current = page.items.find((p) => p.id === id);
    after = page.next;
  } while (!current && after);
  if (current && current.revision > 2) throw Error("Production has been edited; use the saved revision workflow instead of importing again");
  let production = current;
  if (!production) {
    const draft = structuredClone(packet);
    for (const shot of draft.shots) if (shot.source) delete shot.source.assetId;
    production = (
      await call("SaveVideoProduction", {
        input: { id, revision: 0, packet: draft },
      })
    ).saveVideoProduction;
  }
  async function put(asset, revision) {
    const { file, ...metadata } = asset;
    const bytes = await readFile(file);
    if (
      bytes.length !== metadata.size ||
      createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
    )
      throw Error(`Changed input: ${metadata.filename}`);
    const reserved = (
      await call("ReserveVideoAsset", {
        input: {
          ...metadata,
          productionId: id,
          productionRevision: revision,
          transport,
        },
      })
    ).reserveVideoAsset;
    if (!reserved.ready) {
      await upload(reserved.upload, bytes);
      await call("CommitVideoAsset", {
        input: { id: asset.id, productionId: id },
      });
    }
  }
  for (const asset of assets.filter((a) => a.kind === "frame"))
    await put(asset, 1);
  if (production.revision === 1)
    production = (
      await call("SaveVideoProduction", { input: { id, revision: 1, packet } })
    ).saveVideoProduction;
  for (const asset of assets.filter((a) => a.kind !== "frame"))
    await put(asset, production.revision);
  return production;
}
