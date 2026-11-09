import { storage, type StorageLocals } from "@ai-outfitter/app-sdk/storage";
import type { API, ChangeReceipt } from "./forge";
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { imageDimensions } from "./image-dimensions";

/** Demo screenshots of a run live in this installation's `runs` space under
 * `<runId>/demo-<headSha>-…png` and are linked by their public file URL. */
export const evidenceSpace = "runs";
export const evidenceKey = (runId: string, headSha: string, sha256: string, filename: string) =>
  `${runId}/demo-${headSha}-${sha256.slice(0, 16)}-${filename}`;
const visualSource = (path: string) => !path.startsWith("src/pages/api/") &&
  (/\.(?:astro|tsx|jsx|css|scss|html|svg)$/.test(path) || path.startsWith("packages/ui/"));
/** Evidence keys a Demo section displays as images of this run, ignoring code and
 * comments. Images are HTTPS, or plain HTTP only from one of `origins`: the app's
 * own, which is loopback HTTP in local development and sealed boxes. */
export function demoImageKeys(demo: string, runId: string, origins: ReadonlySet<string> = new Set()) {
  const visible = demo.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[ \t]*(?=\n|$)|$)/g, "")
    .replace(/`+[^`]*`+/g, "").replace(/^(?: {4}|\t).*$/gm, "");
  const image = new RegExp(`^(https?://[a-z0-9.-]+(?::\\d{1,5})?)/files/main/${evidenceSpace}/(${runId}/demo-[a-f0-9]{40}-[a-f0-9]{16}-[A-Za-z0-9_-]{1,48}\\.png)$`);
  const keys = new Set<string>();
  const add = (url: string | undefined) => {
    const match = url && image.exec(url);
    if (match && (match[1].startsWith("https://") || origins.has(match[1]))) keys.add(match[2]);
  };
  for (const match of visible.matchAll(/(?<!\\)!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi)) add(match[1]);
  for (const tag of visible.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attributes = new Map([...tag[0].matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1].toLowerCase(), match[2] ?? match[3]]));
    add(attributes.get("src"));
  }
  return keys;
}
async function visualChange(api: API, repository: string, candidate: ChangeReceipt) {
  let visual = false;
  for (let page = 1; ; page++) {
    if (page > 30) throw new Response("PR file list needs attention", { status: 422 });
    const files = await api<Array<{ filename: string; status: string }>>(`/repos/${repository}/pulls/${candidate.number}/files?per_page=100&page=${page}`);
    if (files.some(file => file.status !== "removed" && (/^docs\/(?:evidence|plans|issues)\//.test(file.filename) ||
        /^docs\/screenshots\/.*\.(?:png|jpe?g|webp|gif)$/.test(file.filename))))
      throw new Response("Run plans and issue notes belong in workflow outputs or GitHub; demo screenshots belong in run storage, never Git", { status: 422 });
    visual ||= files.some(file => visualSource(file.filename));
    if (files.length < 100) break;
  }
  return visual;
}

/** The run's published screenshots for one commit, newest key order. */
export async function publishedFoundryEvidence(locals: StorageLocals, origin: string, runId: string, headSha: string) {
  const files = storage(locals, "main");
  const prefix = `${runId}/demo-${headSha}-`;
  const evidence = [];
  // Sequential bounded reads avoid retaining all screenshot bodies in memory.
  for (const file of await files.list(evidenceSpace, { prefix })) {
    if (file.visibility !== "public" || file.contentType !== "image/png" || file.size > 512 * 1024) continue;
    const object = await files.get(file);
    if (!object) continue;
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if (await sha256Hex(bytes) !== file.sha256)
      throw new Response("Published image changed during verification", { status: 409 });
    evidence.push({ runId, headSha, createdAt:file.createdAt, url: new URL(files.url(file), origin).href, sha256: file.sha256,
      filename: file.key.slice(prefix.length + 17), expiresAt: file.expiresAt, ...imageDimensions(bytes) });
  }
  return evidence;
}

type Evidence = Awaited<ReturnType<typeof publishedFoundryEvidence>>;

/** Screenshot gaps are review findings, not implementation completion gates.
 * The actual pinned PR and forbidden committed run artifacts remain hard checks. */
export async function demoStatus(api: API, repository: string, candidate: ChangeReceipt, runId: string, published: Evidence | Promise<Evidence>) {
  const [visual, evidence] = await Promise.all([visualChange(api, repository, candidate), published]);
  if (!visual) return { status: "not-required" as const, missing: [], evidence };
  const pull = await api<{ head: { sha: string }; body: string }>(`/repos/${repository}/pulls/${candidate.number}`);
  if (pull.head.sha !== candidate.headSha) throw new Response("PR changed during Demo verification", { status: 409 });
  const demo = pull.body?.split(/^## Demo\s*$/m)[1]?.split(/^## /m)[0];
  const shown = new Map<string, Set<string>>();
  const displayed = demoImageKeys(demo ?? "", runId, new Set(evidence.map(receipt => new URL(receipt.url).origin)));
  for (const receipt of evidence) {
    if (!displayed.has(new URL(receipt.url).pathname.slice(`/files/main/${evidenceSpace}/`.length))) continue;
    const viewport = /(?:^|[-_])(desktop|mobile)(?=[-_.]|$)/.exec(receipt.filename.toLowerCase())?.[1];
    if (viewport) {
      const hashes = shown.get(viewport) ?? new Set<string>();
      hashes.add(receipt.sha256);
      shown.set(viewport, hashes);
    }
  }
  const missing = [...(!demo ? ["Demo section"] : []), ...["desktop", "mobile"].filter(viewport => !shown.has(viewport))];
  if (!missing.length && ![...(shown.get("desktop") ?? [])].some(desktop =>
    [...(shown.get("mobile") ?? [])].some(mobile => desktop !== mobile))) missing.push("distinct desktop/mobile captures");
  return { status: missing.length ? "needs-attention" as const : "complete" as const, missing, evidence };
}

/** The Demo status of a candidate against the run's published screenshots for its commit. */
export async function verifyFoundryDemo(locals: StorageLocals, origin: string, api: API, repository: string, candidate: ChangeReceipt, runId: string) {
  return demoStatus(api, repository, candidate, runId, publishedFoundryEvidence(locals, origin, runId, candidate.headSha));
}
