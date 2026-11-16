/** Import adapter: caller supplies authorized graph reads/staging and artifact registration.
 * No approval, provider execution, filesystem or storage operations occur in this module. */
import { canonical, digest, type CreativeKind } from "./index.ts";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
type RecordInput = {
  address: string;
  revision: number;
  kind: CreativeKind;
  title: string;
  body: any;
  subject: string;
  batchId?: string;
};
export async function importArtera(
  manifest: any,
  options: {
    installationId: string;
    subject: { id: string; revision: number; address?: string };
    owner: { installationId: string; type: string; id: string };
    batchId: string;
    read: (
      id: string,
      address: string,
    ) => Promise<{ revision: number; body: any } | null>;
    stage: (record: RecordInput) => Promise<unknown>;
    artifact: (candidate: any) => Promise<any>;
  },
) {
  if (manifest.format !== "artera-creative-import/1")
    throw Error("Unsupported Artera import format");
  const { hash, ...raw } = manifest;
  if ((await digest(JSON.stringify(raw))) !== hash)
    throw Error("Import manifest changed");
  const source = `artera:${options.subject.id}:${manifest.source.deck}`,
    pin = (id: string, revision = 1) => ({
      installationId: options.installationId,
      type: "graph-node",
      id,
      revision,
    });
  const kindFor = (key: string): CreativeKind =>
    key.startsWith("snapshot:")
      ? "GenerationSnapshot"
      : key.startsWith("candidate:")
        ? "CreativeCandidate"
        : key.startsWith("selection:")
          ? "CreativeSelection"
          : "PromptFragment";
  const addressFor = async (key: string) =>
    `${kindFor(key)}:artera-${key
      .split("/")
      .at(-1)!
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)}-${(await digest(source + ":" + key)).slice(0, 12)}`;
  const idFor = async (key: string) =>
    key.startsWith("selection:")
      ? stableGraphId(
          "creative-selection",
          options.installationId,
          options.subject.id,
          key.slice("selection:".length),
        )
      : stableGraphId(
          "creative-address",
          options.installationId,
          await addressFor(key),
        );
  const receipts: any[] = [],
    deferredCandidates: string[] = [];
  async function put(key: string, kind: CreativeKind, body: any) {
    const id = await idFor(key),
      address = await addressFor(key),
      existing = await options.read(id, address);
    if (existing) {
      if (canonical(existing.body) !== canonical(body))
        throw Error(`Imported record changed: ${key}; revise it explicitly`);
      return { id, address, revision: existing.revision };
    }
    receipts.push(
      await options.stage({
        address,
        revision: 0,
        kind,
        title: key.slice(0, 200),
        body,
        subject: options.subject.address ?? options.subject.id,
        batchId: options.batchId,
      }),
    );
    return { id, address, revision: 1 };
  }
  // Preserve dependency edges and raw text, including legacy cycles. Native
  // freezing refuses those cycles; the explicit legacy adapter resolves them once.
  for (const [path, text] of Object.entries(manifest.files)) {
    const references: string[] = [];
    for (const match of String(text).matchAll(/@([\w./-]+\.md)/g)) {
      const parts = path.split("/").slice(0, -1);
      for (const part of match[1].split("/")) {
        if (part === "..") {
          if (!parts.length)
            throw Error("Reference escapes imported repository");
          parts.pop();
        } else if (part !== "." && part) parts.push(part);
      }
      const target = parts.join("/");
      if (!(target in manifest.files))
        throw Error(`Missing imported fragment: ${target}`);
      references.push(await idFor(target));
    }
    await put(path, "PromptFragment", {
      id: await idFor(path),
      revision: 1,
      text,
      references,
      sourcePath: path,
    });
  }
  const candidates = new Map<
    string,
    { id: string; address: string; revision: number }
  >();
  for (const row of manifest.candidates) {
    let snapshot;
    if (row.snapshot) {
      const key = `snapshot:${row.source.prompt}`,
        saved = row.snapshot;
      const ref = await put(key, "GenerationSnapshot", {
        resolver: "artera/legacy",
        hash: row.source.prompt,
        text: saved.text,
        manifest: saved.manifest,
        sourcePath: `${manifest.source.deck}/candidates/prompts/${row.source.prompt}`,
      });
      snapshot = pin(ref.id, ref.revision);
      if (!(await options.read(ref.id, ref.address))) {
        deferredCandidates.push(row.source.image);
        continue;
      }
    }
    const asset = await options.artifact(row);
    const feedback = manifest.feedback
      .filter((f: any) => f.image === row.source.image)
      .map((f: any) => ({
        at: String(f.at ?? f.time ?? ""),
        author: String(f.author ?? "Artera import"),
        text: String(f.text ?? f.note ?? f.verdict),
      }));
    const record = await put(
      `candidate:${row.source.image}`,
      "CreativeCandidate",
      {
        subject: pin(options.subject.id, options.subject.revision),
        ...(snapshot ? { snapshot } : {}),
        artifact: asset,
        owner: options.owner,
        concept: true,
        feedback,
        sourcePath:
          row.source.sourcePath ??
          `${manifest.source.deck}/candidates/${row.source.image}`,
        sourceRecord: row.source,
      },
    );
    candidates.set(row.source.image, record);
  }
  // Selection staging requires committed candidates. A second import after review
  // completes these references, without silently accepting a legacy newest default.
  const deferred: string[] = [];
  for (const selected of manifest.selections.filter((s: any) => s.explicit)) {
    const chosen = candidates.get(selected.file);
    if (!chosen) {
      deferred.push(selected.slot);
      continue;
    }
    if (!(await options.read(chosen.id, chosen.address))) {
      deferred.push(selected.slot);
      continue;
    }
    await put(`selection:${selected.slot}`, "CreativeSelection", {
      use: pin(options.subject.id, options.subject.revision),
      slot: selected.slot,
      candidate: pin(chosen.id, chosen.revision),
    });
  }
  return { receipts, deferredCandidates, deferredSelections: deferred };
}
