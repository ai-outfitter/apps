import { bomRows, type Assembly } from "../lib/assembly";
import type { readWorkshopPrint } from "../server/print-analysis";
import { appBase } from "../lib/sections";

export type PrintAnalysis = Awaited<ReturnType<typeof readWorkshopPrint>>;
type Part = PrintAnalysis["parts"][number];
type Plate = PrintAnalysis["plates"][number];
type Estimate = Pick<Plate, "durationSeconds" | "filamentGrams" | "printer" | "material" | "slicer" | "profileSha256">;

function text(tag: string, value: string) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

export function printableParts(view: Assembly) {
  const parts = new Map<string, { name: string; quantity: number; locations: string[] }>();
  const labels = new Map<string, string>();
  for (const { item, quantity, path, refdes } of bomRows(view)) {
    const parent = labels.get(path.slice(0, path.lastIndexOf("/")));
    const label = refdes || item.name;
    const location = parent ? parent + " / " + label : label;
    labels.set(path, location);
    if (item.kind !== "printed") continue;
    const part = parts.get(item.id) ?? { name: item.name, quantity: 0, locations: [] };
    part.quantity += quantity;
    if (parent && !part.locations.includes(location)) part.locations.push(location);
    parts.set(item.id, part);
  }
  return parts;
}

const grams = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
function formatEstimate(data: Estimate) {
  const minutes = Math.round(data.durationSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const time = hours ? `${hours} h ${minutes % 60} min` : minutes ? `${minutes} min` : `${Math.round(data.durationSeconds)} sec`;
  return `${time} · ${grams.format(data.filamentGrams)} g`;
}

function profile(data: Estimate) {
  const label = text("small", [data.printer, data.material, data.slicer, `Profile ${data.profileSha256.slice(0, 12)}`].join(" · "));
  label.title = data.profileSha256;
  return label;
}

function totalEstimate(base: Estimate, entries: { estimate?: Estimate; quantity: number }[]) {
  return entries.reduce((total, { estimate, quantity }) => {
    if (estimate) {
      total.durationSeconds += estimate.durationSeconds * quantity;
      total.filamentGrams += estimate.filamentGrams * quantity;
    }
    return total;
  }, { ...base, durationSeconds: 0, filamentGrams: 0 });
}

function plateDownload(plate: Plate) {
  const artifact = plate.artifact;
  if (!artifact?.downloadPath?.startsWith("/files/")) return;
  const link = document.createElement("a");
  link.href = appBase(location.pathname) + artifact.downloadPath;
  link.download = artifact.fileName;
  link.title = artifact.sha256;
  link.textContent = `Download ${artifact.fileName}`;
  return link;
}

function plateSummary(plate: Plate, heading?: string) {
  const section = document.createElement("article");
  if (heading) section.append(text("h3", heading));
  section.append(text(heading ? "p" : "h3", plate.name), text("strong", formatEstimate(plate)), profile(plate));
  const members = plate.members.map(member => {
    const name = member.fileName ?? member.itemId;
    return member.quantity === 1 ? name : `${name} × ${member.quantity}`;
  });
  section.append(text("small", members.join(" · ")));
  if (plate.warnings.length) {
    const warnings = document.createElement("ul");
    warnings.append(...plate.warnings.map(value => text("li", value)));
    section.append(warnings);
  }
  return section;
}

function partSummary(part: Part | undefined, name: string, quantity: number, locations: string[]) {
  const section = document.createElement("article");
  section.append(text("h3", quantity === 1 ? name : `${name} × ${quantity}`));
  if (locations.length) section.append(text("small", locations.join(" · ")));
  if (part?.fileName) {
    const identity = text("small", [part.fileName, part.sha256?.slice(0, 12)].filter(Boolean).join(" · "));
    identity.title = part.sha256 ?? "";
    section.append(identity);
  }
  if (part?.state === "completed" && part.result) {
    const result = part.result;
    const messages = { pass: "Printability check passed", warning: "Printability warning", fail: "Printability check failed" };
    section.append(text("p", messages[result.status]));
    if (result.message) section.append(text("p", result.message));
    if (result.support_heights_mm?.length) {
      const heights = result.support_heights_mm.map(height => `Z ${grams.format(height)} mm`);
      section.append(text("p", "Support at " + heights.join(", ")));
    }
    if (result.findings?.length) {
      const findings = document.createElement("ul");
      for (const finding of result.findings) {
        findings.append(text("li", `Z ${grams.format(finding.z_mm)} mm · ${grams.format(finding.unsupported_area_mm2)} mm² unsupported`));
      }
      section.append(findings);
    }
  } else {
    const messages = { pending: "Printability check pending", stale: "Printability check stale", error: "Printability check unavailable", completed: "Printability check pending" };
    section.append(text("p", messages[part?.state ?? "pending"]));
    if (part?.result?.message) section.append(text("p", part.result.message));
  }
  if (part?.estimate && part.estimate.profileSha256 === part.profileSha256) {
    section.append(text("p", `Per-part slice estimate · ${formatEstimate(part.estimate)}`), profile(part.estimate));
  }
  return section;
}

export function renderPrintAnalysis(host: HTMLElement, view: Assembly, data?: PrintAnalysis, unavailable = false) {
  const parts = printableParts(view);
  host.replaceChildren();
  if (!parts.size) return;
  if (!data && unavailable) host.append(text("p", "Print evidence unavailable for this view."));
  const partRecords = new Map(data?.parts.map(part => [part.itemId, part]));
  const assemblies = view.items.find(item => item.id === view.rootId)?.kind === "assembly";
  const plates = data?.plates.filter(plate => plate.members.some(member => parts.has(member.itemId))) ?? [];
  const completed = plates.filter(plate => plate.state === "completed");
  const coversView = (candidate: Plate[]) => {
    const quantities = new Map<string, number>();
    for (const plate of candidate) {
      for (const member of plate.members) {
        const part = partRecords.get(member.itemId);
        if (!part?.sha256 || part.sha256 !== member.sha256 || !parts.has(member.itemId)) return false;
        quantities.set(member.itemId, (quantities.get(member.itemId) ?? 0) + member.quantity);
      }
    }
    return Array.from(parts).every(([id, part]) => quantities.get(id) === part.quantity);
  };
  const byArtifact = new Map<string, Plate[]>();
  for (const plate of completed) {
    if (!plate.artifact) continue;
    const key = plate.artifact.sha256 + ":" + plate.profileSha256;
    const entries = byArtifact.get(key) ?? [];
    entries.push(plate);
    byArtifact.set(key, entries);
  }
  const jobs = [...byArtifact.values()].filter(group => group.length > 1 && coversView(group));
  const grouped = completed.filter(plate => coversView([plate]));
  for (const plates of jobs) {
    const total = totalEstimate(plates[0], plates.map(plate => ({ estimate: plate, quantity: 1 })));
    host.append(text("h3", "Grouped plate estimate"), text("p", `${plates.length} plates · ${formatEstimate(total)}`), profile(total));
    const link = plateDownload(plates[0]);
    if (link) host.append(link);
    for (const plate of plates) host.append(plateSummary(plate));
  }
  for (const plate of grouped) {
    const summary = plateSummary(plate, assemblies ? "Grouped plate estimate" : "Single-part plate estimate");
    const link = plateDownload(plate);
    if (link) summary.append(link);
    host.append(summary);
  }
  if (assemblies && !grouped.length && !jobs.length) {
    const estimates = Array.from(parts, ([id, { quantity }]) => {
      const part = partRecords.get(id);
      const estimate = part?.estimate;
      return { estimate: estimate?.profileSha256 === part?.profileSha256 ? estimate : undefined, quantity };
    });
    const first = estimates[0]?.estimate;
    if (first && estimates.every(({ estimate }) => estimate?.profileSha256 === first.profileSha256)) {
      const total = totalEstimate(first, estimates);
      host.append(text("h3", "Independent part estimate roll-up"), text("p", formatEstimate(total)), profile(total));
    } else {
      host.append(text("h3", "Assembly estimate incomplete"), text("p", "A complete slice estimate for this assembly is pending."));
    }
  }
  const presented = new Set([...grouped, ...jobs.flat()]);
  for (const plate of plates) {
    if (plate.state === "stale") host.append(text("p", `Stale plate evidence · ${plate.name}`));
    else if (!presented.has(plate)) {
      host.append(plateSummary(plate, assemblies ? "Partial plate estimate" : "Shared plate estimate"));
    }
  }
  for (const [id, { name, quantity, locations }] of parts) {
    host.append(partSummary(partRecords.get(id), name, quantity, locations));
  }
}
