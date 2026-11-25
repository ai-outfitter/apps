import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";

export class PhaseMismatch extends Response {
  constructor(reason: string) {
    super(reason, { status: 422 });
  }
}

export const phaseMismatch = (reason: string) => new PhaseMismatch(reason);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const treeEntry = z.object({
  path: z.string().min(1).refine(path => !path.includes("/")),
  sha,
  mode: z.string(),
  type: z.string(),
});
const treePage = z.object({ sha, truncated: z.boolean(), total_count: z.number().int().nonnegative(), tree: z.array(treeEntry) });
type TreeEntry = z.infer<typeof treeEntry>;
export type CommitProof = {
  nonce: string;
  headSha?: string;
  summary?: string;
  files: { path: string; beforeSha: string | null; contentHash: string | null }[];
};
type Read = (suffix: string) => Promise<unknown>;

async function readTree(read: Read, treeSha: string | undefined) {
  const entries = new Map<string, TreeEntry>();
  if (!treeSha) return entries;
  let total: number | undefined;
  for (let page = 1; page <= 20; page++) {
    const list = treePage.parse(await read(`/git/trees/${treeSha}?page=${page}&per_page=1000`));
    if (list.sha !== treeSha || (total !== undefined && total !== list.total_count))
      throw phaseMismatch("Forgejo returned a different Git tree");
    total = list.total_count;
    for (const entry of list.tree) {
      if (entries.has(entry.path)) throw phaseMismatch("Forgejo returned an overlapping Git tree");
      entries.set(entry.path, entry);
    }
    // Forgejo 11 can report truncated on every page of a split tree, including the last.
    if (entries.size === total) return entries;
    if (!list.tree.length || entries.size > total || !list.truncated)
      throw phaseMismatch("Forgejo returned an incomplete Git tree");
  }
  throw phaseMismatch("The Git tree exceeds the review verification limit");
}

/** Walk only differing trees. The provider's affected-file list can be truncated,
 * and a correct proposed blob does not by itself rule out changes to other paths. */
export async function verifyCommitTree(read: Read, baseTree: string, headTree: string, proof: CommitProof) {
  const remaining = new Map(proof.files.map(file => [file.path, file]));
  const reject = () => phaseMismatch("The recovered Forgejo commit differs from the frozen file changes");
  async function compare(baseSha: string | undefined, headSha: string | undefined, prefix: string) {
    if (baseSha === headSha) return;
    const [before, after] = await Promise.all([readTree(read, baseSha), readTree(read, headSha)]);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(name);
      const next = after.get(name);
      if (old?.sha === next?.sha && old?.mode === next?.mode && old?.type === next?.type) continue;
      const path = prefix + name;
      if ((!old || old.type === "tree") && (!next || next.type === "tree")) {
        if (!proof.files.some(file => file.path.startsWith(path + "/"))) throw reject();
        await compare(old?.sha, next?.sha, path + "/");
        continue;
      }
      const expected = remaining.get(path);
      if (!expected || (old?.sha ?? null) !== expected.beforeSha) throw reject();
      if (expected.contentHash === null) {
        if (next || old?.type !== "blob" || !["100644", "100755"].includes(old.mode)) throw reject();
      } else {
        if (next?.type !== "blob" || (old && old.type !== "blob") ||
            !["100644", "100755"].includes(next.mode) || next.mode !== (old?.mode ?? "100644"))
          throw reject();
        const blob = z.object({ sha, content: z.string(), encoding: z.literal("base64") }).parse(await read(`/git/blobs/${next.sha}`));
        if (blob.sha !== next.sha || await sha256Hex(blob.content.replace(/\s/g, "")) !== expected.contentHash)
          throw reject();
      }
      remaining.delete(path);
    }
  }
  await compare(baseTree, headTree, "");
  if (remaining.size) throw reject();
}
