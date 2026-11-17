import { onPageLoad } from "@ai-outfitter/ui/page";
import { z } from "zod";
import { appBase, slugId } from "../lib/sections";
import { type BuildManifest, WorkspaceSchema } from "../lib/workspace";
import {
  boardArtifact, isQuoted, missingFileMessage, parsePcbReview, powerRows, provenanceFacts,
  quotesHeading, resolveWorkspacePcbBuild, type PcbProvenance, type PcbReview,
} from "../lib/pcb-review";
import { PcbSnapshotSchema } from "../lib/pcb-snapshot";
import { resolvePcbSnapshot } from "../lib/pcb-snapshot-review";
import { type CameraView, mountPcbViewer } from "./pcb-viewer";

/** Everything the page renders. A loader builds one; `renderPcbReview` only reads it,
 * so another record type (an imported snapshot) needs only its own loader. */
export interface PcbReviewSource {
  review: PcbReview;
  artifacts: BuildManifest["artifacts"];
  provenance: PcbProvenance;
  /** The URL of a registered artifact. */
  artifactUrl(path: string): string;
  bundleHref?: string;
  notes: string[];
}

const readOnly = import.meta.env.OUTFITTER_APP_MODE === "demo";

class HttpError extends Error {
  constructor(readonly status: number, url: string) { super(`HTTP ${status}: ${url}`); }
}
async function fetchOk(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new HttpError(response.status, url);
  return response;
}
function issues(error: z.ZodError) {
  return error.issues.slice(0, 3).map(i => `${i.path.join(".") || "record"}: ${i.message}`).join("; ");
}

const SummariesSchema = z.array(z.object({ id: z.string() }).loose());
const ProjectRecordSchema = z.object({ id: z.uuid(), workspace: WorkspaceSchema.optional(), pcbSnapshots: z.array(PcbSnapshotSchema).optional() }).loose();
export type PcbProjectRecord = z.infer<typeof ProjectRecordSchema>;
const projectsApi = (base: string) => `${base}/api/apps/workshop/projects`;

/** The slug's project, with only the fields PCB review reads, validated. */
export async function fetchPcbProject(base: string, slug: string, signal: AbortSignal): Promise<PcbProjectRecord | undefined> {
  const key = slugId(slug);
  const summaries = SummariesSchema.safeParse(await (await fetchOk(projectsApi(base), signal)).json());
  if (signal.aborted) return undefined;
  if (!summaries.success) throw Error(`The project list could not be read: ${issues(summaries.error)}`);
  const found = key ? summaries.data.find(p => p.id.endsWith(key)) : undefined;
  if (!found) throw Error("Project not found in this Workshop installation.");
  const parsed = ProjectRecordSchema.safeParse(await (await fetchOk(`${projectsApi(base)}/${found.id}`, signal)).json());
  if (signal.aborted) return undefined;
  if (!parsed.success) throw Error(`This project's build records could not be read: ${issues(parsed.error)}`);
  return parsed.data;
}

/** Loads the review from a project's workspace build: `?build=` exactly, or the current build. */
export async function loadWorkspacePcbSource(base: string, project: PcbProjectRecord, requested: string | null, signal: AbortSignal, requestedSnapshot: string | null = null): Promise<PcbReviewSource | undefined> {
  const api = projectsApi(base);
  if(requested && requestedSnapshot) throw Error("Choose either a workspace build or an imported snapshot.");
  if(requestedSnapshot || (!requested && project.pcbSnapshots?.length)) {
    const {snapshot,review: reviewFile,current}=resolvePcbSnapshot(project.pcbSnapshots,requestedSnapshot);
    const manifest=snapshot.manifest;
    const artifactUrl=(path:string)=>{
      if(!manifest.artifacts.some(a=>a.path===path))throw Error("Unregistered PCB artifact");
      return `${base}${snapshot.artifactBase}${path}`;
    };
    let record: unknown;
    try { record=await (await fetchOk(artifactUrl(reviewFile.path),signal)).json(); }
    catch(e) { if(e instanceof HttpError)throw Error(missingFileMessage("PCB review record",e.status,snapshot.importedAt)); throw e; }
    if(signal.aborted)return undefined;
    return {
      review:parsePcbReview(record,manifest.artifacts),artifacts:manifest.artifacts,artifactUrl,
      provenance:{kind:"imported",snapshotId:snapshot.id,current,importedAt:snapshot.importedAt,
        sourceCommit:manifest.sourceCommit,sourceHash:manifest.sourceHash,runner:manifest.runner,
        compiler:manifest.compiler,finishedAt:manifest.finishedAt,reviewSha256:reviewFile.sha256},
      notes:[current ? "Showing the latest imported PCB snapshot." : "Showing a historical imported PCB snapshot."],
      bundleHref:`${api}/${project.id}/pcb?snapshot=${snapshot.id}`,
    };
  }
  const resolved = resolveWorkspacePcbBuild(project.workspace, requested);
  if (!resolved.ok) throw Error(resolved.reason);
  const { manifest, artifactBase, build } = resolved;
  const artifactUrl = (path: string) => {
    if (!manifest.artifacts.some(a => a.path === path)) throw Error(`Unregistered PCB artifact: ${path}`);
    return `${base}${artifactBase}${path}`;
  };

  let record: unknown;
  try {
    record = await (await fetchOk(artifactUrl(resolved.review.path), signal)).json();
  } catch (e) {
    if (e instanceof HttpError) throw Error(missingFileMessage("PCB review record", e.status, manifest.finishedAt));
    throw e;
  }
  if (signal.aborted) return undefined;
  let review: PcbReview;
  try {
    review = parsePcbReview(record, manifest.artifacts);
  } catch (e) {
    throw e instanceof z.ZodError ? Error(`The PCB review record is invalid: ${issues(e)}`) : e;
  }
  return {
    review, artifacts: manifest.artifacts, provenance: resolved.provenance, artifactUrl, notes: resolved.notes,
    bundleHref: `${api}/${project.id}/bundle?build=${build.id}`,
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className?: string) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function definitions(list: HTMLElement, rows: [string, string][]) {
  list.replaceChildren(...rows.flatMap(([name, value]) => [el("dt", name), el("dd", value)]));
}

/** Renders a loaded source into the page, then loads the board model. */
export async function renderPcbReview(root: HTMLElement, source: PcbReviewSource, signal: AbortSignal) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const { review, provenance, artifactUrl } = source;

  $("pcb-title").textContent = review.title;
  $("pcb-subtitle").textContent = `${review.revision} · ${review.dimensions} · ${review.components} components`;
  $("pcb-notice").textContent = [review.status, ...source.notes].filter(Boolean).join(" ");
  if (source.bundleHref) {
    const bundle = $<HTMLAnchorElement>("pcb-bundle");
    bundle.href = source.bundleHref;
    bundle.hidden = false;
  }

  const board = boardArtifact(review, source.artifacts);
  definitions($("pcb-facts"), [
    ["Revision", review.revision],
    ["Size", review.dimensions],
    ["Components", String(review.components)],
    ["Board file", board ? `${board.path.split("/").at(-1)} · ${review.boardSha256.slice(0, 12)}` : `${review.boardSha256.slice(0, 12)} · not a registered file`],
  ]);
  definitions($("pcb-provenance"), provenanceFacts(provenance));
  $("pcb-provenance-note").textContent = provenance.kind === "workspace-build"
    ? "The source archive is the exact export input; the commit is the repository base it was taken from."
    : "Imported file evidence. The source archive pins the export input; the repository base may not contain these board files.";

  $("pcb-checks").replaceChildren(...(review.checks.length
    ? review.checks.map(check => {
      const row = el("p", "", `pcb-check pcb-check-${check.status}`);
      row.append(el("strong", check.status.toUpperCase()), ` · ${check.name}`);
      if (check.detail) row.append(el("small", check.detail));
      return row;
    })
    : [el("p", "No electrical checks are recorded for this revision.")]));

  renderBom($, review);
  renderPower($, review);
  renderManufacturing($, review, artifactUrl, provenance.kind === "imported");
  await renderModel($, review, artifactUrl, provenance.kind === "imported" ? provenance.importedAt : provenance.finishedAt, signal);
}

function renderBom($: <T extends HTMLElement = HTMLElement>(id: string) => T, review: PcbReview) {
  const search = $<HTMLInputElement>("pcb-search");
  const rows = () => {
    const query = search.value.toLowerCase();
    const parts = review.parts.filter(p => `${p.Reference} ${p.MPN} ${p.Value} ${p.Description}`.toLowerCase().includes(query));
    $("pcb-bom-count").textContent = `${parts.length} of ${review.parts.length} populated references`;
    $("pcb-rows").replaceChildren(...parts.map(part => {
      const select = el("button", part.Reference);
      select.type = "button";
      select.onclick = () => {
        $("pcb-selection").textContent = `${part.Reference}: ${part.MPN}. ${part.Description} Footprint: ${part.Footprint}`;
      };
      const reference = el("td");
      reference.append(select);
      const tr = el("tr");
      tr.append(reference, el("td", part.Quantity), el("td", part.MPN), el("td", `${part.Value}${part.Description ? ` — ${part.Description}` : ""}`));
      return tr;
    }));
  };
  search.oninput = rows;
  rows();
}

function renderPower($: <T extends HTMLElement = HTMLElement>(id: string) => T, review: PcbReview) {
  $("pcb-power-basis").textContent = review.power.inputVoltageV !== undefined
    ? `Engineering estimates at ${review.power.inputVoltageV} V input. These are not bench measurements.`
    : "Engineering estimates; the review record does not state the input voltage. These are not bench measurements.";
  $("pcb-power-cards").replaceChildren(...powerRows(review).map(row => {
    const card = el("article");
    card.append(el("p", row.mode), el("strong", `${row.inputW.toFixed(3)} W`));
    if (row.withMargin) card.append(el("p", `${row.withMargin.watts.toFixed(3)} W ${row.withMargin.label}`));
    return card;
  }));
  $("pcb-power-notes").textContent = review.powerNotes;
}

function renderManufacturing($: <T extends HTMLElement = HTMLElement>(id: string) => T, review: PcbReview, artifactUrl: (path: string) => string, imported: boolean) {
  $("pcb-manufacturing-note").textContent = review.manufacturingNote;
  $("pcb-downloads").replaceChildren(...review.downloads.map(download => {
    const a = el("a", download.label);
    a.href = artifactUrl(download.path);
    a.download = download.path.split("/").at(-1)!;
    return a;
  }));
  $("pcb-quotes-heading").textContent = quotesHeading(review.quotes);
  $("pcb-quotes").replaceChildren(...(review.quotes.length
    ? review.quotes.map(quote => {
      const card = el("article", "", isQuoted(quote) ? "pcb-quote-quoted" : "pcb-quote-open");
      card.append(el("h4", `${quote.quantity} assembled boards`));
      if (isQuoted(quote)) {
        if(imported) card.append(el("p", "Member-imported quote; supplier authenticity is not verified by Workshop."));
        const evidence = el("a", "Quote evidence");
        evidence.href = artifactUrl(quote.evidence);
        evidence.download = quote.evidence.split("/").at(-1)!;
        card.append(
          el("strong", `${quote.currency} ${quote.total.toFixed(2)}`),
          el("p", `${quote.supplier} · quote ${quote.quoteId}`),
          el("p", `Quoted ${quote.quotedAt.slice(0, 10)} · ${quote.scope}`),
          evidence,
        );
      } else {
        card.append(el("strong", "No price"), el("p", [quote.supplier, quote.status].filter(Boolean).join(" · ")));
      }
      if (quote.detail) card.append(el("p", quote.detail));
      return card;
    })
    : [el("p", "No supplier quotes are recorded for this revision.")]));
}

async function renderModel($: <T extends HTMLElement = HTMLElement>(id: string) => T, review: PcbReview, artifactUrl: (path: string) => string, finishedAt: string, signal: AbortSignal) {
  $("pcb-model-note").textContent = review.modelNote;
  const status = $("pcb-model-status");
  status.textContent = "Loading the exported 3D board…";
  try {
    const glb = await (await fetchOk(artifactUrl(review.model), signal)).arrayBuffer();
    const viewer = await mountPcbViewer($("pcb-canvas"), glb, signal);
    if (!viewer || signal.aborted) return;
    status.textContent = "";
    for (const button of $("pcb-controls").querySelectorAll<HTMLButtonElement>("[data-camera]")) {
      button.disabled = false;
      button.onclick = () => viewer.view(button.dataset.camera as CameraView);
    }
    const spin = $("pcb-spin");
    spin.removeAttribute("disabled");
    spin.onclick = () => spin.setAttribute("aria-pressed", String(viewer.toggleSpin()));
  } catch (e) {
    if (signal.aborted) return;
    status.textContent = e instanceof HttpError
      ? missingFileMessage("3D board model", e.status, finishedAt)
      : `The 3D board model could not be shown: ${(e as Error).message}`;
    if (review.preview) {
      const preview = document.createElement("img");
      preview.alt = `${review.title}: static rendering of the exported board`;
      preview.src = artifactUrl(review.preview);
      preview.style.cssText = "width:100%;height:100%;object-fit:contain";
      preview.onload = () => { if (!signal.aborted) status.textContent = "Interactive 3D is unavailable. Showing a static rendering of the exported board."; };
      preview.onerror = () => { if (!signal.aborted) { preview.remove(); status.textContent += " The static rendering is also unavailable."; } };
      $("pcb-canvas").replaceChildren(preview);
    }
  }
}

onPageLoad(async signal => {
  const root = document.querySelector<HTMLElement>("#pcb-review");
  if (!root) return;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const fail = (message: string) => {
    $("pcb-subtitle").textContent = "No board revision to show.";
    $("pcb-notice").textContent = message;
    $("pcb-model-status").textContent = "";
  };
  if (readOnly) {
    fail("The demo has no imported board. PCB review shows KiCad exports saved in an installation's build storage.");
    return;
  }
  try {
    const base = appBase(location.pathname);
    const project = await fetchPcbProject(base, root.dataset.slug ?? "", signal);
    if (!project || signal.aborted) return;
    const requested = new URLSearchParams(location.search).get("build");
    const source = await loadWorkspacePcbSource(base, project, requested, signal, new URLSearchParams(location.search).get("snapshot"));
    if (!source || signal.aborted) return;
    await renderPcbReview(root, source, signal);
  } catch (e) {
    if (!signal.aborted) fail(e instanceof Error ? e.message : String(e));
  }
});
