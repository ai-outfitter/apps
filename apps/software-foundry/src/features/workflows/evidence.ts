import type { WorkflowRun } from "@ai-outfitter/app-sdk/workflows";
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
function safeLink(value: unknown, github = false) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!github || url.hostname === "github.com")
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function imageReceipt(
  run: WorkflowRun,
  nodeId: string,
  candidate: RecordValue,
  entry: unknown,
) {
  const image = object(entry);
  if (
    (image.installationId !== undefined && image.installationId !== run.installationId) ||
    (image.nodeId !== undefined && image.nodeId !== nodeId) ||
    (image.runId !== run.id &&
      image.runId !== run.inputs["land.inputs.sourceRunId"]) ||
    typeof image.filename !== "string" ||
    typeof image.headSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(image.headSha) ||
    typeof image.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(image.sha256) ||
    (candidate.headSha && image.headSha !== candidate.headSha)
  )
    return null;
  const url = safeLink(image.url);
  if (!url) return null;
  const path = `/files/main/runs/${image.runId}/demo-${image.headSha}-${image.sha256.slice(0, 16)}-${image.filename}`;
  if (new URL(url).pathname !== path) return null;
  return {
    filename: image.filename,
    url,
    headSha: image.headSha,
    sha256: image.sha256,
  };
}
function archiveLink(run: WorkflowRun, value: unknown) {
  const archive = object(value);
  if (
    typeof archive.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(archive.id) ||
    (archive.runId !== run.id &&
      archive.runId !== run.inputs["land.inputs.sourceRunId"])
  )
    return null;
  return {
    label: "Download private session archive",
    url: `/api/platform/artifacts/${archive.id}?download=1`,
  };
}
function rowEvidence(run: WorkflowRun, nodeId: string, value: RecordValue) {
  function link(label: string, value: unknown, github = true) {
    const url = safeLink(value, github);
    return url ? { label, url } : null;
  }
  const candidate = object(value.candidate),
    review = object(value.review),
    merge = object(value.merge);
  const checks = Array.isArray(value.checks) ? value.checks : [];
  const links = [
    link("Source issue", object(value.issue).url),
    link("Pull request", candidate.url),
    link(
      `Formal review: ${typeof review.verdict === "string" ? review.verdict : "recorded"}`,
      review.url,
    ),
    link("Merged change", merge.url),
    link("Actions preview", object(value.previews).verifiedUrl, false),
    archiveLink(run, value.sessionArtifact),
    ...checks.map((entry) => {
      const check = object(entry);
      return link(
        `${typeof check.name === "string" ? check.name : "Check"}: ${check.passed === true ? "passed" : "needs attention"}`,
        check.url,
      );
    }),
  ].filter((item) => item !== null);
  const demo = object(value.demo);
  const notices =
    demo.status === "needs-attention" && Array.isArray(demo.missing)
      ? [
          `Demo needs review: ${demo.missing.filter((item) => typeof item === "string").join(", ")}`,
        ]
      : [];
  const images = (Array.isArray(value.evidence) ? value.evidence : [])
    .map((entry) => imageReceipt(run, nodeId, candidate, entry))
    .filter((item) => item !== null);
  for (const entry of Array.isArray(value.intake) ? value.intake : []) {
    const receipt = object(entry);
    if (typeof receipt.deliveryId === "string")
      notices.push(`Connector delivery: ${receipt.deliveryId}`);
  }
  return { links, images, notices };
}
/** Presentation only. Native output admission owns authority; URLs never become HTML. */
export function nodeEvidence(
  run: WorkflowRun,
  nodeId: string,
  rows: WorkflowRun["rows"],
) {
  const entries = Object.values(rows).map((row) =>
    rowEvidence(run, nodeId, object(row.value)),
  );
  if (!entries.length) entries.push(rowEvidence(run, nodeId, {}));
  const links = new Map(
    entries
      .flatMap((entry) => entry.links)
      .map((link) => [`${link.label}:${link.url}`, link]),
  );
  for (const attempt of run.attempts??[]) {
    if(attempt.nodeId!==nodeId)continue;
    const archive=archiveLink(run,attempt.sessionArtifact);
    if(archive)links.set(`${archive.label}:${archive.url}`,archive);
  }
  const images = new Map(
    entries.flatMap((entry) => entry.images).map((image) => [image.url, image]),
  );
  return {
    links: [...links.values()],
    images: [...images.values()],
    notices: [...new Set(entries.flatMap((entry) => entry.notices))],
  };
}
export function renderNodeEvidence(
  run: WorkflowRun,
  nodeId: string,
  rows: WorkflowRun["rows"],
) {
  const view = nodeEvidence(run, nodeId, rows);
  const host = document.createElement("section");
  host.setAttribute("aria-label", `${nodeId} evidence`);
  if (view.links.length) {
    const list = document.createElement("ul");
    for (const item of view.links) {
      const li = document.createElement("li"),
        a = document.createElement("a");
      a.href = item.url;
      a.textContent = item.label;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      li.appendChild(a);
      list.appendChild(li);
    }
    host.appendChild(list);
  }
  for (const notice of view.notices) {
    const p = document.createElement("p");
    p.textContent = notice;
    host.appendChild(p);
  }
  for (const image of view.images) {
    const figure = document.createElement("figure"),
      a = document.createElement("a"),
      img = document.createElement("img"),
      caption = document.createElement("figcaption");
    a.href = image.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    img.src = image.url;
    img.alt = image.filename;
    img.loading = "lazy";
    caption.textContent = `${image.filename} · source ${image.headSha.slice(0, 12)} · SHA-256 ${image.sha256}`;
    a.appendChild(img);
    figure.appendChild(a);
    figure.appendChild(caption);
    host.appendChild(figure);
  }
  return host;
}
