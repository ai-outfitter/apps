import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
import { productsFocus } from "../agent-focus";
import { format as timeAgo } from "timeago.js";
import { livePoll } from "@ai-outfitter/ui/live";
import productsQuery from "../../queries/products.graphql?raw";
import { typeSegment } from "@ai-outfitter/app-sdk/graph-client";
import { onPageLoad } from "@ai-outfitter/ui/page";
import type { Graph, GraphNode } from "../lib/graph";
import { type EvidenceBundle, evidenceBody, evidenceURL, isRecordType, revisionEvidence, screenshotMetadata } from "../lib/revision-evidence";
import { type WikiContext, wikiHref } from "./wiki-context";

type Child = Node | string | null | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("aria-")) node.setAttribute(key, String(value));
    else if (key === "class") node.className = String(value);
    else Object.assign(node, { [key]: value });
  }
  node.replaceChildren(...children.filter((child): child is Node | string => child !== null && child !== false));
  return node;
}
const text = (value: unknown) => typeof value === "string" ? value : "";
type Story = ReturnType<ReturnType<typeof revisionEvidence>["stories"]>[number];
type Capture = NonNullable<ReturnType<typeof evidenceURL>> & { path: string; title: string; route: string; finalRoute: string; viewport: string; state: string };
type Step = { key: string; title: string; route: string; captures: Capture[] };
type Chapter = { story: Story; steps: Step[] };
const mountFor = () => location.pathname.replace(/^(.*)\/(?:products|projects)(?:\/.*)?$/, "$1");
const localReview = evidenceURL(location.origin, location.origin)?.local ?? false;
const productUrl = (mount: string, id: string) => `${mount}/products/${encodeURIComponent(id)}`;
const revisionUrl = (mount: string, product: string, revision: string) => `${productUrl(mount, product)}/revisions/${encodeURIComponent(revision)}`;
const button = (label: string, run: () => void, selected?: boolean) => el("button", { type: "button", onclick: run, ...(selected === undefined ? {} : {"aria-pressed": selected}) }, label);
function control(key: string, label: string, run: () => void, selected?: boolean) {
  const element = button(label, run, selected);
  element.dataset.control = key;
  return element;
}
function currentStep(element: HTMLElement, selected: boolean) {
  if (selected) element.setAttribute("aria-current", "step");
  else element.removeAttribute("aria-current");
}

function chaptersFor(stories: Story[], bundle?: EvidenceBundle): Chapter[] {
  const assets = (bundle?.capturedMembers ?? []).flatMap(node => {
    const values = evidenceBody(node.body).assets;
    return Array.isArray(values) ? values.filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)) : [];
  });
  const chapters = stories.map(story => {
    const pages = new Map<string, Step>();
    for (const value of story.media) {
      const url = evidenceURL(value, location.origin);
      if (!url) continue;
      const metadata = screenshotMetadata(assets, url.pathname);
      const route = text(metadata.route);
      const key = route || url.href;
      const page = pages.get(key) ?? { key, title: text(metadata.pageTitle) || "Captured page", route, captures: [] };
      page.captures.push({ ...url, path: text(metadata.path), title: text(metadata.pageTitle), route, finalRoute: text(metadata.finalRoute), viewport: text(metadata.viewport) || "unknown", state: text(metadata.state) || "page" });
      pages.set(key, page);
    }
    return { story, steps: [...pages.values()] };
  });
  // Capture filenames carry their original traversal order. Keep uncaptured stories last.
  return chapters.sort((a, b) => Number(!a.steps.length) - Number(!b.steps.length) || (a.steps[0]?.captures[0]?.path || "~").localeCompare(b.steps[0]?.captures[0]?.path || "~", undefined, { numeric: true }));
}

function related(graph: Graph, id: string, name: string, incoming = false) {
  const type = graph.types.find(type => !type.archived && type.name === name)?.id;
  return graph.edges.filter(edge => !edge.archived && edge.typeId === type && (incoming ? edge.toId : edge.fromId) === id)
    .flatMap(edge => graph.nodes.filter(node => !node.archived && node.id === (incoming ? edge.fromId : edge.toId)));
}

function catalog(root: HTMLElement, mount: string, graph: Graph, productId?: string) {
  const products = graph.nodes.filter(node => !node.archived && isRecordType(graph, node, "Product") && (!productId || node.id === productId));
  if (!products.length) { root.replaceChildren(el("p", {}, productId ? "Product not found." : "No products have been recorded yet.")); return; }
  const list = el("div", { class: "planning-card-grid" });
  for (const product of products) {
    const revisions = related(graph, product.id, "revision_of", true).filter(node => isRecordType(graph, node, "ProductRevision"));
    list.appendChild(el("article", { class: "planning-card product-card" }, el("h2", {}, el("a", { href: productUrl(mount, product.id) }, product.title)), el("p", {}, product.summary), el("h3", {}, "Revisions"),
      ...revisions.map(revision => el("a", { class: "product-revision-link", href: revisionUrl(mount, product.id, revision.id) }, el("strong", {}, revision.title), el("span", {}, "Explore the experience →"))),
      !revisions.length && el("p", {}, "No revisions recorded yet.")));
  }
  root.replaceChildren(list);
  const heading = document.querySelector(".intro h1");
  if (productId && heading) heading.textContent = products[0].title;
}

function bundleFacts(bundle: EvidenceBundle) {
  return [["Source commit", bundle.commits.join(", ") || "Not recorded"], ["Working tree", bundle.clean === true ? "Clean" : bundle.clean === false ? "Changed during capture" : "Unknown"], ["Captured", bundle.capturedAt ? new Date(bundle.capturedAt).toISOString() : "Not recorded"], ["Environment", bundle.environment || "Not recorded"]];
}

function evidencePanel(graph: Graph, bundle: EvidenceBundle | undefined, wiki?: WikiContext) {
  const panel = el("section", { class: "product-evidence" }, el("h2", {}, "Evidence & review"));
  if (!bundle) { panel.appendChild(el("p", {}, "No evidence bundle has been recorded for this revision.")); return panel; }
  const facts = el("dl");
  for (const [label, value] of bundleFacts(bundle)) {
    facts.appendChild(el("dt", {}, label)); facts.appendChild(el("dd", {}, value));
  }
  panel.appendChild(facts);
  panel.appendChild(el("p", {}, "Screenshots show observed pages and states. They do not by themselves establish a completed flow or approval."));
  if (!bundle.reviews.length) panel.appendChild(el("p", {}, "No independent review recorded in this snapshot."));
  panel.appendChild(el("ul", {}, ...bundle.evaluations.map(node => el("li", {}, `${node.title}: ${text(evidenceBody(node.body).result) || "Not recorded"}`)), ...bundle.warnings.map(warning => el("li", { class: "product-warning" }, warning)), ...bundle.limitations.map(value => el("li", {}, value))));
  const receipts = el("details", {}, el("summary", {}, "Source records and receipts"));
  for (const node of [bundle.node, ...bundle.members.filter(node => isRecordType(graph, node, "Document"))]) {
    const type = graph.types.find(type => type.id === node.typeId);
    receipts.appendChild(wiki ? el("p", {}, el("a", { href: wikiHref(wiki, `${typeSegment(type?.name || "Document")}/${encodeURIComponent(node.id)}`) }, node.title)) : el("p", {}, node.title));
  }
  panel.appendChild(receipts);
  return panel;
}

function storyDescription(story: Story) {
  if (story.sourceChanged) return "The story has changed since capture. See Evidence & review for the captured scope.";
  const body = evidenceBody(story.node.body);
  return body.actor && body.capability && body.benefit ? `As ${text(body.actor)}, I want to ${text(body.capability)}, so that ${text(body.benefit)}.` : story.node.summary;
}

function flowContext(story: Story) {
  const details = el("details", { class: "walkthrough-flow" }, el("summary", {}, "Intended flow"));
  for (const flow of story.flows) {
    const body = evidenceBody(flow.body);
    details.appendChild(el("h3", {}, flow.title));
    details.appendChild(el("ol", {}, ...text(body.steps).split(/\n+|;\s*/).filter(Boolean).map(step => el("li", {}, step.trim().replace(/^\d+[.)]\s*/, "")))));
    if (body.alternatives) details.appendChild(el("p", {}, text(body.alternatives)));
  }
  return details;
}

function captureFigure(capture: Capture, allowed: Set<string>, redraw: () => void) {
  const figure = el("figure", { class: "walkthrough-capture" });
  figure.dataset.viewport = capture.viewport;
  const url = capture;
  const canLoad = url.preview || (localReview && url.local) || allowed.has(url.origin);
  if (canLoad) {
    const image = el("img", { src: url.href, alt: `${capture.title || "Captured page"} — ${capture.viewport}, ${capture.state}`, referrerPolicy: "no-referrer" });
    image.onerror = () => image.replaceWith(el("p", { role: "status", class: "walkthrough-unavailable" }, "Screenshot unavailable. Start the capture server or open the image directly."));
    figure.appendChild(el("div", {class: "walkthrough-image"}, image));
  } else {
    figure.appendChild(el("div", { class: "walkthrough-load" }, el("p", {}, `Screenshots are stored at ${url.host}.`), control("load-images", "Load screenshots from this location", () => { allowed.add(url.origin); redraw(); })));
  }
  figure.appendChild(el("figcaption", {}, el("strong", {}, capture.title || "Captured page"), el("code", {}, capture.route || "Route not recorded"), capture.finalRoute !== capture.route && !!capture.finalRoute && el("small", {}, `Observed route: ${capture.finalRoute}`), el("a", { href: url.href, target: "_blank", rel: "noopener noreferrer" }, "Open original screenshot ↗")));
  return figure;
}

function walkthrough(chapters: Chapter[]) {
  const area = el("section", { class: "walkthrough", "aria-label": "Product walkthrough" });
  const contents = el("nav", { class: "walkthrough-chapters", "aria-label": "Walkthrough chapters" }, el("h2", {}, "The experience"));
  const eyebrow = el("p", { class: "walkthrough-eyebrow" });
  const heading = el("h2", {tabIndex: -1});
  const purpose = el("p", { class: "walkthrough-purpose" });
  const flow = el("div");
  const status = el("span", { class: "walkthrough-status", role: "status" });
  const views = el("div", { role: "group", "aria-label": "Screenshot viewport" });
  const states = el("div", { role: "group", "aria-label": "Captured state" });
  const controls = el("div", { class: "walkthrough-controls" }, status, views, states);
  const media = el("div");
  const pages = el("nav", { class: "walkthrough-pages", "aria-label": "Pages in this chapter" });
  let chapterIndex = 0, stepIndex = 0, renderedChapter = -1;
  let viewport = matchMedia("(max-width: 800px)").matches ? "mobile" : "desktop", state = "page";
  const allowed = new Set<string>();
  const previous = control("previous", "← Previous", () => move(-1));
  const next = control("next", "Next →", () => move(1));
  const pagination = el("nav", { class: "walkthrough-pagination", "aria-label": "Walkthrough navigation" }, previous, next);
  const content = el("div", { class: "walkthrough-stage" }, eyebrow, heading, purpose, flow, controls, media, pages, pagination);
  const chapterButtons = chapters.map((item, index) => control(`chapter-${index}`, `${String(index + 1).padStart(2, "0")}  ${item.story.node.title}${!item.steps.length ? " · Not captured" : ""}`, () => { chapterIndex = index; stepIndex = 0; state = "page"; draw(); }));
  contents.replaceChildren(el("h2", {}, "The experience"), ...chapterButtons);
  area.replaceChildren(contents, content);

  function move(direction: number) {
    const current = chapters[chapterIndex];
    const index = stepIndex + direction;
    if (index >= 0 && index < current.steps.length) stepIndex = index;
    else if (chapters[chapterIndex + direction]) {
      chapterIndex += direction;
      stepIndex = direction > 0 ? 0 : Math.max(0, chapters[chapterIndex].steps.length - 1);
    }
    state = "page"; draw();
  }
  function revealChapter(index: number) {
    const target = chapterButtons[index].getBoundingClientRect();
    const bounds = contents.getBoundingClientRect();
    if (target.left < bounds.left) contents.scrollLeft -= bounds.left - target.left;
    else if (target.right > bounds.right) contents.scrollLeft += target.right - bounds.right;
  }
  function restoreFocus(key?: string) {
    if (!key) return;
    const target = [...area.querySelectorAll<HTMLButtonElement>("button[data-control]")].find(element => element.dataset.control === key);
    (target && !target.disabled ? target : key === "next" && !previous.disabled ? previous : heading).focus({preventScroll: true});
  }
  function updateChapter(chapter: Chapter) {
    if (renderedChapter === chapterIndex) return;
    renderedChapter = chapterIndex;
    eyebrow.textContent = `Chapter ${chapterIndex + 1} of ${chapters.length}`;
    heading.textContent = chapter.story.node.title;
    purpose.textContent = storyDescription(chapter.story);
    flow.replaceChildren(...(chapter.story.flows.length ? [flowContext(chapter.story)] : []));
    pages.replaceChildren(...chapter.steps.map((page, index) => control(`page-${index}`, `${index + 1}. ${page.route || page.title}`, () => { stepIndex = index; state = "page"; draw(); })));
    pages.scrollLeft = 0;
    chapterButtons.forEach((element, index) => { currentStep(element, index === chapterIndex); });
    revealChapter(chapterIndex);
  }
  function updateCapture(step: Step) {
    const matching = step.captures.filter(capture => capture.viewport === viewport);
    const available = matching.length ? matching : step.captures;
    const capture = available.find(capture => capture.state === state) ?? available[0];
    views.replaceChildren(...[...new Set(step.captures.map(capture => capture.viewport))].map(option => control(`viewport-${option}`, option, () => { viewport = option; draw(); }, capture.viewport === option)));
    states.replaceChildren(...[...new Set(available.map(item => item.state))].map(option => control(`state-${option}`, option.replaceAll("-", " "), () => { state = option; draw(); }, capture.state === option)));
    media.replaceChildren(captureFigure(capture, allowed, draw));
  }
  function draw() {
    const focused = area.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.control : undefined;
    const chapter = chapters[chapterIndex];
    if (!chapter) { area.replaceChildren(el("p", {}, "No user stories are linked to this revision yet.")); return; }
    updateChapter(chapter);
    const step = chapter.steps[stepIndex];
    status.textContent = step ? `Chapter ${chapterIndex + 1} of ${chapters.length}, page ${stepIndex + 1} of ${chapter.steps.length}` : `Chapter ${chapterIndex + 1} of ${chapters.length}, not captured`;
    views.hidden = states.hidden = pages.hidden = !step;
    if (step) updateCapture(step);
    else media.replaceChildren(el("p", { class: "walkthrough-gap" }, "This part of the experience has not been captured yet."));
    [...pages.querySelectorAll("button")].forEach((element, index) => { currentStep(element, index === stepIndex); });
    previous.disabled = chapterIndex === 0 && stepIndex === 0;
    next.disabled = chapterIndex === chapters.length - 1 && stepIndex >= chapter.steps.length - 1;
    restoreFocus(focused);
  }
  draw(); return area;
}

function revisionPage(root: HTMLElement, mount: string, graph: Graph, product: GraphNode, revision: GraphNode, wiki?: WikiContext) {
  const model = revisionEvidence(graph, revision);
  const requested = new URLSearchParams(location.search).get("bundle");
  const bundle = requested ? model.bundles.find(bundle => bundle.node.id === requested) : model.bundles[0];
  const heading = document.querySelector(".intro h1"); if (heading) heading.textContent = revision.title;
  document.title = `${revision.title} — Planning`;
  const breadcrumb = el("nav", { class: "product-breadcrumb", "aria-label": "Product navigation" }, el("a", { href: `${mount}/products` }, "Products"), " / ", el("a", { href: productUrl(mount, product.id) }, product.title), " / ", revision.title);
  const select = el("select", { "aria-label": "Evidence snapshot" });
  if (!bundle) select.appendChild(el("option", {value: "", disabled: true, selected: true}, "Choose a capture"));
  for (const item of model.bundles) select.appendChild(el("option", { value: item.node.id, selected: bundle?.node.id === item.node.id }, item.node.title));
  select.onchange = () => { const url = new URL(location.href); url.searchParams.set("bundle", select.value); location.assign(url.href); };
  const captureSelect = model.bundles.length > 0 && el("label", {}, "Capture", select);
  const toolbar = el("div", { class: "product-revision-toolbar" }, captureSelect);
  if (requested && !bundle) { root.replaceChildren(breadcrumb, el("p", { role: "alert" }, "This evidence snapshot is unavailable. Choose a recorded capture."), toolbar); return; }
  const content = el("div");
  const chapters = chaptersFor(model.stories(bundle), bundle);
  const walk = walkthrough(chapters), evidence = evidencePanel(graph, bundle, wiki);
  const tabs = el("nav", { class: "product-tabs", "aria-label": "Revision views" });
  const walkButton = button("Walkthrough", () => show("walkthrough"), true);
  const evidenceButton = button("Evidence & review", () => show("evidence"), false);
  tabs.replaceChildren(walkButton, evidenceButton);
  function show(which: "walkthrough" | "evidence") {
    walkButton.setAttribute("aria-pressed", String(which === "walkthrough"));
    evidenceButton.setAttribute("aria-pressed", String(which === "evidence"));
    content.replaceChildren(which === "walkthrough" ? walk : evidence);
  }
  show("walkthrough");
  toolbar.insertBefore(tabs, toolbar.firstChild);
  root.replaceChildren(breadcrumb, toolbar, !bundle ? el("p", { class: "walkthrough-gap" }, "No capture recorded. These stories describe the intended experience.") : el("p", { class: "walkthrough-scope" }, `${chapters.filter(chapter => chapter.steps.length).length} captured chapters · ${chapters.reduce((total, chapter) => total + chapter.steps.length, 0)} pages · Page observations; full-flow acceptance has not been established.`), content);
}

function resolveRevision(root: HTMLElement, graph: Graph) {
  const product = graph.nodes.find(node => !node.archived && node.id === root.dataset.productId && isRecordType(graph, node, "Product"));
  const revision = product && related(graph, product.id, "revision_of", true).find(node => node.id === root.dataset.revisionId && isRecordType(graph, node, "ProductRevision"));
  return {product, revision};
}
async function loadProducts(mount: string, signal: AbortSignal, projectId?: string): Promise<{graph: Graph; wiki?: WikiContext}> {
  if (import.meta.env.OUTFITTER_APP_MODE === "demo") {
    const graph = structuredClone((await import("../../fixtures/product-evidence.json")).default) as Graph;
    for (const node of graph.nodes) node.body = node.body.replaceAll('"/demo/', `"${mount}/demo/`);
    return {graph};
  }
  const response = await fetch(`${mount}/api/apps/planning/products${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { signal });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the catalog validates scope and complete data before rendering either report or products.
async function loadProductCatalog(root: HTMLElement, mount: string, signal: AbortSignal) {
  // The demo bundle ships no operational browser calls; this branch lets the bundler drop the query.
  if (import.meta.env.OUTFITTER_APP_MODE === "demo") return;
  const scope = /^\/o\/([^/]+)\/planning$/.exec(mount);
  if (!scope) throw new Error("An organization scope is required to load products.");
  const slug = decodeURIComponent(scope[1]);
  const response = await fetch(`${location.origin}/api/graphql`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ query: productsQuery, operationName: "Products", variables: { organizations: [slug], ...(new URLSearchParams(location.search).get("at") ? {at:new URLSearchParams(location.search).get("at")} : {}) }, organizationSlugs: [slug], personal: false, maxBytes: 262144 }),
  });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json() as {data?:{viewer?:{orgs?:{slug:string;weeklyProductRoadmap:import("../server/product-page-data").ProductPageData;products:import("../server/product-page-data").ProductPageData["products"]}[]}};errors?:{message:string}[];extensions?:{truncated?:boolean}};
  if (result.errors?.length || result.extensions?.truncated)
    throw new Error(result.errors?.map((error: {message: string}) => error.message).join("; ") || "Products query returned incomplete data.");
  if (signal.aborted) return;
  const organizations = result.data?.viewer?.orgs ?? [];
  if (organizations.length !== 1 || organizations[0].slug !== slug) throw new Error("Organization scope mismatch.");
  const page = {...organizations[0].weeklyProductRoadmap,products:organizations[0].products};
  if (!page || page.organizationSlug !== slug) throw new Error("Products page unavailable in this organization.");
  const reportRoot = document.getElementById("product-roadmap");
  if (reportRoot) {
    reportRoot.hidden = false;
    const report = page.report;
    const periodEnd = new Date(`${page.periodEnd}T00:00:00Z`);
    periodEnd.setUTCDate(periodEnd.getUTCDate() - 1);
    const dates = new Intl.DateTimeFormat(undefined, {month:"short",day:"numeric",year:"numeric",timeZone:"UTC"});
    const meta = el("p", {class:"planning-roadmap-meta"}, dates.formatRange(new Date(`${page.periodStart}T00:00:00Z`),periodEnd));
    if (report) {
      meta.appendChild(document.createTextNode(` · ${report.status === "open" ? "Draft" : "Sealed"} · Revision ${report.revision ?? "unknown"}`));
      if (report.updated_at && Number.isFinite(new Date(report.updated_at).getTime())) {
        meta.appendChild(document.createTextNode(" · Updated "));
        const updated = el("time", {dateTime:report.updated_at,title:new Date(report.updated_at).toLocaleString()}, timeAgo(report.updated_at));
        meta.appendChild(updated);
        livePoll(signal, () => {updated.textContent=timeAgo(report.updated_at);}, {every:60000});
      }
    }
    const links = el("nav", {class:"planning-roadmap-links","aria-label":"Roadmap documents"}, el("a", {href:`${mount}/products.md${location.search}`}, "Markdown"));
    if(report) links.appendChild(el("a", {href:`${mount.replace(/\/planning$/,"/wiki-map")}/weekly-reports/${encodeURIComponent(report.id)}`}, "Revision history"));
    reportRoot.replaceChildren(el("header", {class:"planning-product-heading"}, el("div", {}, el("h2", {}, "Weekly product roadmap"), meta), links));
    if (!report) reportRoot.appendChild(el("p", {}, "No report has been generated for this week."));
    if (report) {
      // Narrative is untrusted generated content: keep it as text.
      reportRoot.appendChild(el("div", {class:"product-report-narrative",style:"white-space:pre-wrap"}, report.narrative ?? ""));
      for (const [label, key] of [["Changes", "changes"], ["Proposed priorities", "proposed_priorities"], ["Open questions", "open_questions"]]) {
        const values = report[key];
        if (!values?.length) continue;
        reportRoot.appendChild(el("h3", {}, label));
        reportRoot.appendChild(Array.isArray(values) ? el("ul", {}, ...values.map((value: string) => el("li", {}, value))) : el("p", {}, String(values)));
      }
      const sources=el("details",{},el("summary",{},"Source context"),el("p",{},`${report.evidenceManifest?.records?.length??0} cited source records · ${report.evidenceManifest?.complete?"Capture complete; consistency checked at seal":"Evidence incomplete"}`));
      for(const message of report.evidenceManifest?.errors??[])sources.appendChild(el("p",{},String(message)));
      reportRoot.appendChild(sources);
      if(report.seal) {
        reportRoot.appendChild(el("p",{},`Sealed revision ${report.seal.revision} · Cutoff ${report.seal.cutoff} · ${report.seal.control_id?"Governance review configured":"Governance review not configured"}`));
        reportRoot.appendChild(el("a",{href:mount.replace(/\/planning$/,"/governance/controls")},"Inspect Governance review"));
      }
      reportRoot.appendChild(el("p", {}, "Generated recommendations require review. Sealing does not imply approval."));
    }
  }
  const products = page.products as {id:string;title:string;summary?:string;revisions:{id:string;title:string}[];projects:{id:string;title:string;goals:{id:string;title:string}[]}[]}[];
  if (!products.length) { root.replaceChildren(el("p", {}, "No products have been recorded yet.")); return; }
  const list = el("div", { class: "planning-card-grid" });
  const orderEndpoint = `${mount}/api/apps/planning/priority-order`;
  const orderSnapshot = import.meta.env.OUTFITTER_APP_MODE !== "demo" && root.dataset.canEdit === "true" ? fetch(`${orderEndpoint}?kind=products`).then(async response => { if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<{priorityOrder:{revision:number}}> }) : null;
  async function move(index:number, target:number) {
    if (import.meta.env.OUTFITTER_APP_MODE === "demo" || !orderSnapshot) return;
    const {priorityOrder} = await orderSnapshot;
    const items=products.map(item=>item.id); if(index===target || index<0 || target<0 || target>=items.length)return; items.splice(target,0,...items.splice(index,1));
    const saved=await fetch(orderEndpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({kind:"products",items,revision:priorityOrder.revision})});
    if(!saved.ok)throw new Error(await saved.text());
    await loadProductCatalog(root,mount,signal);
  }
  let dragged: number | null = null;
  for (const [index, product] of products.entries()) {
    const revisions = product.revisions;
    const handle = root.dataset.canEdit === "true" ? el("button", {type:"button",class:"planning-drag-handle",draggable:true,"aria-label":`Reorder ${product.title}`,title:"Drag to reorder; use arrow keys to move"}, "⠿") : null;
    const card = el("article", { class: "planning-card product-card" }, el("h2", {}, el("a", { href: productUrl(mount, product.id) }, product.title)), handle, el("p", {}, product.summary ?? ""), ...product.projects.map(project => el("p", {}, `Project: ${project.title}${project.goals.length ? ` · Goals: ${project.goals.map(goal => goal.title).join(", ")}` : ""}`)), el("h3", {}, "Revisions"),
      ...revisions.map(revision => el("a", { class: "product-revision-link", href: revisionUrl(mount, product.id, revision.id) }, el("strong", {}, revision.title), el("span", {}, "Explore the experience →"))),
      !revisions.length && el("p", {}, "No revisions recorded yet."));
    handle?.addEventListener("dragstart", event => {dragged=index; event.dataTransfer?.setData("text/plain",product.id);});
    handle?.addEventListener("dragend",()=>{dragged=null;});
    handle?.addEventListener("keydown",event=>{if(!["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(event.key))return; event.preventDefault(); void move(index,index+(["ArrowUp","ArrowLeft"].includes(event.key)?-1:1)).catch(error=>alert(error.message));});
    card.addEventListener("dragover",event=>{if(dragged!==null)event.preventDefault();});
    card.addEventListener("drop",event=>{if(dragged===null)return;event.preventDefault();const source=dragged;dragged=null;void move(source,index).catch(error=>alert(error.message));});
    list.appendChild(card);
  }
  root.replaceChildren(list);
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: catalog, product and revision routes share the existing loader and its abort/error boundary.
async function load(root: HTMLElement, mount: string, signal: AbortSignal) {
  try {
    if (import.meta.env.OUTFITTER_APP_MODE !== "demo" && !root.dataset.productId && /^\/o\/[^/]+\/planning$/.test(mount)) {
      await loadProductCatalog(root, mount, signal);
      return;
    }
    const data = await loadProducts(mount, signal);
    if (signal.aborted) return;
    const {product, revision} = resolveRevision(root, data.graph);
    if (root.dataset.revisionId) {
      if (!product || !revision) root.replaceChildren(el("p", {}, "Product revision not found."));
      else revisionPage(root, mount, data.graph, product, revision, data.wiki);
    } else catalog(root, mount, data.graph, root.dataset.productId);
  } catch (error) {
    if (!signal.aborted) root.replaceChildren(el("p", { role: "alert" }, `Cannot load products: ${error instanceof Error ? error.message : "Try again."}`));
  }
  finally { root.setAttribute("aria-busy", "false"); }
}

async function projectProductLinks(mount: string, signal: AbortSignal) {
  const section = document.getElementById("project-products");
  if (!section) return;
  try {
    const {graph} = await loadProducts(mount, signal, section.dataset.projectId);
    if (signal.aborted) return;
    const project = graph.nodes.find(node => node.source?.id === section.dataset.projectId && node.source?.type === "project" && isRecordType(graph, node, "Project"));
    if (!project) return;
    const revisions = related(graph, project.id, "produces").filter(node => isRecordType(graph, node, "ProductRevision"));
    const links = revisions.flatMap(revision => related(graph, revision.id, "revision_of").map(product => el("p", {}, el("a", {href: revisionUrl(mount, product.id, revision.id)}, `${revision.title} — Explore the product experience →`))));
    if (links.length) {section.replaceChildren(el("h3", {}, "Product revisions"), ...links); section.hidden = false;}
  } catch {section.hidden = true;}
}
onPageLoad((signal) => {
  const mount = mountFor();
  const root = document.getElementById("products");
  if (root) {
    const page = agentPage("planning");
    page.set({ focus: productsFocus });
    signal.addEventListener("abort", () => page.set({ focus: null }), { once: true });
    void load(root, mount, signal);
  }
  void projectProductLinks(mount, signal);
});
