import { appBase, projectPath } from "../lib/sections";
import type { CotsEvidenceResult } from "../server/cots-evidence";

function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}

function link(label: string, href: string) {
  const anchor = text("a", label);
  anchor.href = href;
  return anchor;
}

function revisionUrl(
  projectId: string, revision: number,
  options: { itemId?: string; inspection?: boolean; configuration?: string; parameters?: Record<string, number> } = {},
) {
  const query = new URLSearchParams({ revision: String(revision) });
  if (options.itemId) query.set("item", options.itemId);
  if (options.inspection) query.set("inspection", "cots");
  if (options.configuration) query.set("configuration", options.configuration);
  if (options.parameters) query.set("parameters", JSON.stringify(options.parameters));
  return appBase(location.pathname) + projectPath(projectId.slice(-12)) + "?" + query;
}

// These conditions already have a field or status in the interface card.
const displayedConditions = new Set(["tolerance_unknown", "fit_untested", "fit_interference", "fit_tested_elsewhere"]);

function renderPart(part: CotsEvidenceResult["items"][number], partUrl: (itemId: string) => string, context: CotsEvidenceResult) {
  const section = document.createElement("article");
  const heading = text("h4", "");
  heading.append(link(part.name, partUrl(part.itemId)));
  section.append(heading, text("p", part.number));

  if (part.owner) {
    const owner = text("p", "Evidence owner · ");
    owner.append(link(
      `${part.owner.name} · project save ${part.owner.revision}`,
      revisionUrl(part.owner.projectId, part.owner.revision, { itemId: part.owner.itemId, inspection: true }),
    ));
    owner.append(` · ${part.owner.number} · Part rev ${part.owner.partRevision}`);
    section.append(owner);
  }

  if (part.supplierSource) {
    const source = link("Open supplier reference", part.supplierSource);
    if (source.protocol === "https:" || source.protocol === "http:") {
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      const supplier = text("p", "Supplier documentation · ");
      supplier.append(source);
      section.append(supplier);
    }
  }

  const photos = new Map(part.photos.map((photo) => [photo.sha256, photo]));
  const photoUrl = (path: string) => appBase(location.pathname) + path;
  if (part.photos.length) {
    section.append(text("h5", "Reference photos"));
    for (const photo of part.photos) {
      const figure = document.createElement("figure");
      const anchor = link("", photoUrl(photo.downloadPath));
      anchor.setAttribute("aria-label", `Open reference photo ${photo.fileName}`);
      const image = document.createElement("img");
      image.loading = "lazy";
      image.src = anchor.href;
      image.alt = photo.fileName;
      anchor.append(image);
      const caption = text("figcaption", photo.observation);
      caption.append(text("small", `Attachment at project save ${photo.attachmentRevision}`));
      for (const attachment of photo.attachments ?? []) {
        if (attachment.projectId === part.owner?.projectId && attachment.itemId === part.owner.itemId) continue;
        const source = text("small", "Also attached to ");
        source.append(link(
          `${attachment.itemName} (${attachment.itemNumber}) · project save ${attachment.revision}`,
          revisionUrl(attachment.projectId, attachment.revision, { itemId: attachment.itemId }),
        ));
        caption.append(source);
      }
      figure.append(anchor, caption);
      section.append(figure);
    }
  } else {
    section.append(text("p", "No verified reference photos."));
  }

  function evidenceLinks(hashes: string[]) {
    const list = document.createElement("ul");
    for (const hash of hashes) {
      const photo = photos.get(hash);
      const item = text("li", "");
      if (photo) item.append(link(photo.fileName, photoUrl(photo.downloadPath)));
      else item.textContent = "Photo unavailable";
      list.append(item);
    }
    return list;
  }

  section.append(text("h5", "Interface dimensions and fit"));
  if (!part.interfaces.length) section.append(text("p", "No interface measurements or fit results recorded."));
  for (const measurement of part.interfaces) {
    const details = document.createElement("section");
    details.className = "cots-interface";
    const facts = document.createElement("dl");
    const fact = (label: string, value: string) => facts.append(text("dt", label), text("dd", value));
    const dimension = (value: number) => `${value} ${measurement.unit}`;
    fact("Datum", measurement.datum);
    fact("Axis", measurement.axis);
    const nominal = measurement.nominal;
    const measured = measurement.measured;
    fact("Nominal", nominal ? `${dimension(nominal.value)} · ${nominal.basis} · ${nominal.source}` : "Unknown");
    fact("Measured", measured ? `${dimension(measured.value)} · owned part · ${measured.source}` : "Unknown");
    const tolerance = measurement.tolerance;
    const limits = tolerance.kind === "specified" ? `−${tolerance.minus} / +${tolerance.plus} ${measurement.unit}` : "Unknown";
    fact("Tolerance", limits);
    details.append(text("h5", measurement.feature), facts);
    if (measurement.photoSha256s.length) details.append(evidenceLinks(measurement.photoSha256s));

    const verification = measurement.verification;
    if (verification.status === "untested") {
      details.append(text("p", "Fit status · Untested"));
    } else {
      const testedElsewhere = part.warnings.some(({ code, interfaceId }) =>
        code === "fit_tested_elsewhere" && interfaceId === measurement.id,
      );
      details.append(text("p", `Fit status · ${verification.status === "fits" ? "Fits" : "Interferes"} in recorded trial`));
      const anchor = `fit-trial-${part.owner?.itemId ?? part.itemId}-${measurement.id}-${verification.trialId}`;
      if (part.owner?.projectId === context.projectId && part.owner.itemId === part.itemId) details.id = anchor;
      const tested = text("p", "");
      const label = `Trial ${verification.trialId}`;
      if (part.owner) {
        tested.append(link(label, revisionUrl(part.owner.projectId, part.owner.revision, { itemId: part.owner.itemId, inspection: true }) + "#" + anchor));
      } else {
        tested.append(label);
      }
      tested.append(" · ");
      const configuration = verification.testedConfiguration;
      const testedLabel = `Tested project save ${verification.testedRevision}${configuration ? " · " + configuration : ""}`;
      tested.append(link(testedLabel, revisionUrl(verification.testedProjectId, verification.testedRevision, {
        configuration, parameters: verification.testedParameters,
      })));
      details.append(tested, text("p", verification.observation));
      if (testedElsewhere) details.append(text("p", "Fit in this assembly selection is unknown."));
      if (verification.photoSha256s.length) details.append(evidenceLinks(verification.photoSha256s));
    }
    for (const warning of part.warnings.filter(({ interfaceId, code }) => interfaceId === measurement.id && !displayedConditions.has(code)))
      details.append(text("p", warning.message));
    section.append(details);
  }
  for (const warning of part.warnings.filter(({ interfaceId }) => !interfaceId)) section.append(text("p", warning.message));
  return section;
}

export function renderCotsEvidence(host: HTMLElement, result: CotsEvidenceResult, partUrl: (itemId: string) => string) {
  const nodes = result.items.map((part) => renderPart(part, partUrl, result));
  host.replaceChildren(...(nodes.length ? nodes : [text("p", "No purchased parts in this selection.")]));
  const anchor = document.getElementById(location.hash.slice(1));
  if (anchor && host.contains(anchor)) anchor.scrollIntoView({ block: "nearest" });
}
