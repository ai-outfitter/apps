import { core, type Graph } from "../lib/graph";
import type { Finding } from "./batch-advice";

type Proposal = { ref: string; operation: Record<string, unknown>; evidence: unknown; state: string; recordId?: string | null };
const nameKey = (value: unknown) => typeof value === "string"
  ? value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";

function hostname(value: unknown) {
  if (typeof value !== "string" || !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/i.test(value)) return "";
  return value.toLowerCase().replace(/^www\./, "");
}

// A profile URL identifies a record on a shared service, not the organization's domain.
function domains(attributes: Record<string, unknown>) {
  const properties = attributes.properties as Record<string, unknown> | undefined;
  const hosts = new Set([hostname(properties?.domain)]);
  if (typeof attributes.website === "string" && URL.canParse(attributes.website)) {
    const url = new URL(attributes.website);
    if (/^https?:$/.test(url.protocol) && url.pathname === "/" && !url.search && !url.hash)
      hosts.add(hostname(url.hostname));
  }
  hosts.delete("");
  return hosts;
}

const personalMailHosts = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com"]);

function accountDomains(evidence: unknown) {
  const hosts = new Set<string>();
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!["gmail", "google-calendar"].includes(item?.provider) || typeof item.recordId !== "string") continue;
    // Forerunner scopes these record IDs as <connection mailbox>/<provider record>.
    const match = /^[^@/\s]+@([^@/\s]+)\/.+/.exec(item.recordId);
    const host = hostname(match?.[1]);
    if (host && !personalMailHosts.has(host)) hosts.add(host);
  }
  return hosts;
}

export function isOrganizationCreate(row: Proposal) {
  return row.state !== "rejected" && row.operation.operation === "create" && row.operation.type === "graph-node"
    && (row.operation.attributes as Record<string, unknown>)?.typeId === core.organization;
}

type DuplicateFinding = Finding & { ref: string };

/** Identity hints are review findings, never authority to merge records or infer affiliations. */
export function organizationDuplicates(graph: Graph, rows: Proposal[]): DuplicateFinding[] {
  const proposals = rows.filter(isOrganizationCreate);
  if (!proposals.length) return [];
  const organizations = graph.nodes.filter(node => !node.archived && node.typeId === core.organization)
    .map(node => ({ node, names: [nameKey(node.title), nameKey(node.slug)].filter(Boolean), hosts: domains(node) }));
  const findings: DuplicateFinding[] = [];
  for (const row of proposals) {
    const attrs = row.operation.attributes as Record<string, unknown>;
    const name = nameKey(attrs.title);
    const proposedHosts = domains(attrs);
    const accounts = accountDomains(row.evidence);
    const candidates = organizations.flatMap(({ node, names, hosts }) => {
      if (node.id === attrs.id || node.id === row.recordId) return [];
      let match = "";
      if (name && names.includes(name)) match = "matching normalized organization name";
      for (const domain of proposedHosts) if (hosts.has(domain)) match = "matching organization domain " + domain;
      for (const domain of accounts) {
        if (match) break;
        // The mailbox scopes the source. Only use it when the proposal itself names that
        // domain. An outside vendor mentioned by the mailbox is not the mailbox owner.
        const labels = domain.split(".");
        const label = labels.length === 2 ? nameKey(labels[0]) : "";
        if (name !== nameKey(domain) && name !== label && !proposedHosts.has(domain)) continue;
        if (hosts.has(domain) || (label && names.includes(label)))
          match = "organization name corroborated by scoped account domain " + domain;
      }
      return match ? [{ id: node.id, title: node.title, slug: node.slug, match }] : [];
    });
    if (!candidates.length) continue;
    const [first] = candidates;
    const ambiguous = candidates.length > 1;
    findings.push({
      ref: row.ref, rule: "node.duplicate", severity: "warning",
      organizationCandidates: candidates.slice(0, 5),
      message: ambiguous ? `Found ${candidates.length} possible existing Organizations${candidates.length > 5 ? " (showing five)" : ""}. A member must disambiguate before creating another.`
        : `Possible existing Organization "${first.title}" (${first.id}): ${first.match}.`,
      fix: ambiguous ? "Compare the existing candidate IDs and confirm the intended Organization before revising dependent proposals."
        : `Confirm the match, then withdraw the duplicate create and point supported references to existing Organization ${first.id}. A mailbox alone does not establish employment.`,
    });
  }
  return findings;
}
