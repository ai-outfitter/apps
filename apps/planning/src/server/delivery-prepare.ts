// The planning-delivery-prepare task (docs/plans/project-delivery-flow.md): for one saved project
// revision, revise the intake, route the work, find questions and conflicts, freeze a Workshop and
// a Foundry package, create or update the proposed Workshop project with Workshop's own published
// documents, read it back, and check Foundry's readiness. It submits nothing and approves nothing.
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/app-graphql";
import { requireEditor } from "@ai-outfitter/app-sdk/server";
import { taskInvocation, type PhaseInput } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import {
  getPreparation, latestPreparation, type PreparationRow, preparationSummary, preparationTask, stableId, updatePreparation,
} from "./delivery";
import { IntakeService, type PlanningContext, reviseScope, validateRoutes } from "./intake";
import { hardwareKinds, type RequirementInput, requirementInput, softwareKinds } from "./requirements";
import { packageDigest } from "./work-packages";

export type Requirement = { id: string; key: string; revision: number; body: RequirementInput };
type Target = "workshop" | "foundry";
type Statement = { sql: string; params?: unknown[] };

// ---- Analysis: routes, questions, conflicts and deferred claims, from requirement content only.

export type Question = { requirement: string; question: string; targets: Target[] };
export type Conflict = { interface: string; values: { requirement: string; value: string }[]; targets: Target[] };
export type Deferred = { requirement: string; reason: string; waitsFor: string[] };
const normal = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

/** Which handoffs a requirement feeds. Unset kinds take the router's answer. */
export function targetsOf(requirement: RequirementInput, routed: Partial<Record<string, Target[]>> = {}): Target[] {
  const kind = requirement.kind;
  if (!kind) return routed[requirement.key] ?? [];
  if (hardwareKinds.includes(kind)) return ["workshop"];
  if (softwareKinds.includes(kind)) return ["foundry"];
  return [];
}

const unresolved = (r: Requirement) => r.body.dimensions.some((d) => d.value === null || !d.verified) || r.body.unknowns.length > 0;

/** Questions one requirement raises from its own content. */
function ownQuestions(r: Requirement, routed: Partial<Record<string, Target[]>>): string[] {
  const { title } = r.body;
  return [
    ...(!r.body.kind && !routed[r.key] ? [`Is "${title}" hardware, firmware/software or research? Set its kind.`] : []),
    ...(r.body.acceptanceCriteria.length ? [] : [`What observable result accepts "${title}"?`]),
    ...(/\bTBD\b|\?\?\?/i.test(r.body.statement) ? [`"${title}" still says TBD: what is the intended value?`] : []),
    ...r.body.unknowns.map((unknown) => `${title}: ${unknown}`),
    ...r.body.dimensions
      .filter((d) => d.value === null || !d.verified)
      .map((d) => `Measure ${d.name} for "${title}" (${d.value === null ? "unknown" : "unverified"}).`),
  ];
}

/** A claim that depends on an unknown waits; it does not stop independent work. */
function dependencyWaits(r: Requirement, byKey: Map<string, Requirement>) {
  const missing = r.body.dependsOn.filter((key) => !byKey.has(key));
  return {
    questions: missing.map((key) => `"${r.body.title}" depends on ${key}, which is not an active requirement.`),
    waits: r.body.dependsOn.filter((key) => { const d = byKey.get(key); return d ? unresolved(d) : true; }),
  };
}

type InterfaceEntry = { name: string; values: { requirement: string; value: string; targets: Target[] }[] };
function interfaceTable(requirements: Requirement[], routed: Partial<Record<string, Target[]>>) {
  const interfaces = new Map<string, InterfaceEntry>();
  for (const r of requirements)
    for (const item of r.body.interfaces) {
      const entry = interfaces.get(normal(item.name)) ?? { name: item.name, values: [] };
      entry.values.push({ requirement: r.key, value: item.value, targets: targetsOf(r.body, routed) });
      interfaces.set(normal(item.name), entry);
    }
  return [...interfaces.values()];
}
const distinctValues = (entry: InterfaceEntry) => new Set(entry.values.map((v) => normal(v.value))).size;

function routesOf(requirements: Requirement[], routed: Partial<Record<string, Target[]>>) {
  const groups = [
    { kind: "research" as const, keys: requirements.filter((r) => r.body.kind === "research").map((r) => r.key) },
    { kind: "hardware" as const, keys: requirements.filter((r) => targetsOf(r.body, routed).includes("workshop")).map((r) => r.key) },
    { kind: "implementation" as const, keys: requirements.filter((r) => targetsOf(r.body, routed).includes("foundry")).map((r) => r.key) },
  ];
  return groups.filter((group) => group.keys.length);
}

export function analyze(requirements: Requirement[], routed: Partial<Record<string, Target[]>> = {}) {
  const byKey = new Map(requirements.map((r) => [r.key, r]));
  const questions: Question[] = [];
  const deferred: Deferred[] = [];
  const assumptions = requirements.flatMap((r) => r.body.assumptions.map((assumption) => ({ requirement: r.key, assumption })));
  for (const r of requirements) {
    const targets = targetsOf(r.body, routed);
    const dependencies = dependencyWaits(r, byKey);
    for (const question of [...ownQuestions(r, routed), ...dependencies.questions]) questions.push({ requirement: r.key, question, targets });
    const waits = dependencies.waits;
    if (waits.length) deferred.push({ requirement: r.key, waitsFor: waits, reason: `"${r.body.title}" cannot be claimed until ${waits.join(", ")} ${waits.length === 1 ? "is" : "are"} measured or resolved.` });
  }
  // The same named interface with different values is a conflict that stops execution.
  const interfaces = interfaceTable(requirements, routed);
  const conflicts: Conflict[] = interfaces
    .filter((entry) => distinctValues(entry) > 1)
    .map((entry) => ({
      interface: entry.name,
      values: entry.values.map(({ requirement, value }) => ({ requirement, value })),
      // An interface is shared: a conflict blocks every package that uses it.
      targets: [...new Set(entry.values.flatMap((v) => v.targets))],
    }));
  const sharedInterfaces = interfaces.filter((entry) => entry.values.length && distinctValues(entry) === 1)
    .map((entry) => ({ name: entry.name, value: entry.values[0].value, requirements: entry.values.map((v) => v.requirement) }));
  return { routes: routesOf(requirements, routed), questions, conflicts, deferred, assumptions, sharedInterfaces };
}
export type Analysis = ReturnType<typeof analyze>;

// ---- Packages: frozen bodies with digests; identical content reuses its row.

const ref = (r: Requirement) => ({ id: r.id, key: r.key, revision: r.revision, title: r.body.title, kind: r.body.kind ?? null });
const productRevisionOf = (requirements: Requirement[]) => {
  const named = requirements.map((r) => r.body.target).find((t) => t.productRevision || t.productRevisionId);
  return named ? { title: named.productRevision ?? null, id: named.productRevisionId ?? null } : null;
};

export function workshopBody(project: { id: string; name: string }, all: Requirement[], analysis: Analysis, routed: Partial<Record<string, Target[]>> = {}) {
  const rs = all.filter((r) => targetsOf(r.body, routed).includes("workshop"));
  if (!rs.length) return null;
  const deferredKeys = new Set(analysis.deferred.map((d) => d.requirement));
  const cad = rs.filter((r) => r.body.kind === "enclosure" || r.body.kind === "mechanical" || r.body.components.some((c) => c.kind === "printed"));
  return {
    version: 1, target: "workshop" as const,
    project: { id: project.id, name: project.name },
    productRevision: productRevisionOf(all),
    objective: rs.filter((r) => !deferredKeys.has(r.key)).map((r) => r.body.statement).join(" "),
    requirements: rs.map(ref),
    acceptanceCriteria: rs.filter((r) => !deferredKeys.has(r.key)).flatMap((r) => r.body.acceptanceCriteria.map((criterion) => ({ requirement: r.key, criterion }))),
    // Cost, source and inventory stay null unless a requirement states them.
    bom: rs.flatMap((r) => r.body.components.map((c) => ({ requirement: r.key, name: c.name, kind: c.kind, manufacturer: c.manufacturer ?? null, mpn: c.mpn ?? null, quantity: c.quantity, unitCost: c.unitCost, source: null, inventory: null }))),
    assembly: { root: project.name, contains: [...new Set(rs.flatMap((r) => r.body.components.map((c) => c.name)))], placement: "unverified" },
    wiring: rs.flatMap((r) => r.body.connections.map((c) => ({ requirement: r.key, ...c }))),
    interfaces: analysis.sharedInterfaces,
    dimensions: rs.flatMap((r) => r.body.dimensions.map((d) => ({ requirement: r.key, ...d }))),
    constraints: rs.flatMap((r) => r.body.constraints.map((constraint) => ({ requirement: r.key, constraint }))),
    assumptions: analysis.assumptions.filter((a) => rs.some((r) => r.key === a.requirement)),
    questions: analysis.questions.filter((q) => q.targets.includes("workshop")).map(({ requirement, question }) => ({ requirement, question })),
    deferred: analysis.deferred.filter((d) => rs.some((r) => r.key === d.requirement)),
    cad: cad.length ? { required: true, for: cad.map((r) => r.key), exports: ["STEP", "STL"] } : { required: false, for: [], exports: [] },
  };
}

export function foundryBody(project: { id: string; name: string; githubRepository: string }, all: Requirement[], analysis: Analysis, routed: Partial<Record<string, Target[]>> = {}) {
  const rs = all.filter((r) => targetsOf(r.body, routed).includes("foundry"));
  if (!rs.length) return null;
  const repository = rs.map((r) => r.body.target.repository).find(Boolean) ?? (project.githubRepository.replace(/^https:\/\/github\.com\//, "") || null);
  return {
    version: 1, target: "foundry" as const,
    project: { id: project.id, name: project.name },
    objective: rs.map((r) => r.body.statement).join(" "),
    requirements: rs.map(ref),
    sharedInterfaces: analysis.sharedInterfaces,
    repository,
    deliverables: rs.flatMap((r) => r.body.deliverables.map((path) => ({ requirement: r.key, path, repository }))),
    dependencies: rs.flatMap((r) => r.body.dependsOn.map((key) => ({ requirement: r.key, dependsOn: key }))),
    unknowns: rs.flatMap((r) => r.body.unknowns.map((unknown) => ({ requirement: r.key, unknown }))),
    acceptanceCriteria: rs.flatMap((r) => r.body.acceptanceCriteria.map((criterion) => ({ requirement: r.key, criterion }))),
    questions: analysis.questions.filter((q) => q.targets.includes("foundry")).map(({ requirement, question }) => ({ requirement, question })),
  };
}

export type PackageRow = { id: string; projectId: string; target: Target; sequence: number; preparationId: string; digest: string; state: string; body: Record<string, unknown>; receipt: Record<string, unknown> | null; supersedes: string | null };
const packageRow = (row: Record<string, unknown>): PackageRow => ({
  id: String(row.id), projectId: String(row.projectId), target: row.target as Target, sequence: Number(row.sequence), preparationId: String(row.preparationId), digest: String(row.digest), state: String(row.state),
  body: JSON.parse(String(row.body)), receipt: row.receipt == null ? null : JSON.parse(String(row.receipt)), supersedes: row.supersedes == null ? null : String(row.supersedes),
});
export async function listPackages(c: PlanningContext, projectId: string) {
  return (await c.store().query({ sql: "SELECT * FROM planning_delivery_packages WHERE installationId=? AND projectId=? ORDER BY target,sequence", params: [c.identity.installationId, projectId] })).map(packageRow);
}
export async function getPackage(c: PlanningContext, id: string) {
  const [row] = await c.store().query({ sql: "SELECT * FROM planning_delivery_packages WHERE installationId=? AND id=?", params: [c.identity.installationId, id] });
  return row ? packageRow(row) : null;
}

/** Freeze `body` for `target`: identical content returns the same package; new content adds the
 * next sequence, supersedes an unsubmitted predecessor and marks a submitted one for reassessment
 * without changing it. */
export async function freezePackage(c: PlanningContext, prep: PreparationRow, target: Target, body: Record<string, unknown>, blocked: boolean) {
  const digest = await packageDigest(body);
  const installation = c.identity.installationId, now = Date.now(), state = blocked ? "blocked" : "proposed";
  const all = (await listPackages(c, prep.projectId)).filter((p) => p.target === target);
  const same = all.find((p) => p.digest === digest);
  const current = all.filter((p) => p.id !== same?.id && ["proposed", "blocked", "submitted"].includes(p.state));
  const retire: Statement[] = current.map((p) => ({ sql: "UPDATE planning_delivery_packages SET state=?,updatedAt=? WHERE id=? AND installationId=?", params: [p.state === "submitted" ? "needs_reassessment" : "superseded", now, p.id, installation] }));
  if (same) {
    const revive = ["superseded"].includes(same.state) ? [{ sql: "UPDATE planning_delivery_packages SET state=?,updatedAt=? WHERE id=? AND installationId=?", params: [state, now, same.id, installation] }] : [];
    if (retire.length || revive.length) await c.store().batch([...retire, ...revive]);
    return { row: (await getPackage(c, same.id))!, reused: true };
  }
  const id = await stableId("planning-package", installation, prep.projectId, target, digest);
  const sequence = Math.max(0, ...all.map((p) => p.sequence)) + 1;
  await c.store().batch([
    ...retire,
    { sql: "INSERT OR IGNORE INTO planning_delivery_packages(id,installationId,projectId,target,sequence,preparationId,digest,state,body,supersedes,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [id, installation, prep.projectId, target, sequence, prep.id, digest, state, JSON.stringify(body), current.at(-1)?.id ?? null, now, now] },
  ]);
  return { row: (await getPackage(c, id))!, reused: false };
}
export async function setPackageReceipt(c: PlanningContext, id: string, receipt: Record<string, unknown>) {
  await c.store().batch([{ sql: "UPDATE planning_delivery_packages SET receipt=?,updatedAt=? WHERE id=? AND installationId=?", params: [JSON.stringify(receipt), Date.now(), id, c.identity.installationId] }]);
}

// ---- Workshop: create or update the proposed project with Workshop's published documents.

// Workshop's documents as it publishes them (apps/workshop/src/server/documents.ts). The
// platform runs another app's mutation only when its text is one of these.
export const workshopDocuments = {
  create: `mutation CreateWorkshopProject($input: CreateWorkshopProjectInput!) {
      createWorkshopProject(input: $input) { id name revision productRevisionId productRevisionTitle createdBy updatedBy createdAt updatedAt }
    }`,
  describe: `mutation DescribeWorkshopProject($input: DescribeWorkshopProjectInput!) {
      describeWorkshopProject(input: $input) { id name revision createdBy updatedBy createdAt updatedAt }
    }`,
  assembly: `mutation SaveWorkshopAssembly($input: SaveWorkshopAssemblyInput!) {
      saveWorkshopAssembly(input: $input) { id name revision createdBy updatedBy createdAt updatedAt }
    }`,
  handoff: `query WorkshopProjectHandoff($input: WorkshopProjectHandoffInput!) { workshopProjectHandoff(input: $input) }`,
  projects: `query PlanningWorkshopProjects { workshopProjects(first: 100) { nodes { id name } } }`,
};
const operationName = (query: string) => /(?:mutation|query)\s+(\w+)/.exec(query)?.[1];

export async function appCall(c: PlanningContext, installationId: string, query: string, variables: Record<string, unknown> = {}) {
  const action = query.trimStart().startsWith("mutation") ? "graph.mutate" : "graph.graphql";
  const result = graphGraphqlResult.parse(await c.host().call("actions.call", { installationId, action, input: { query, operationName: operationName(query), variables } as never }));
  const error = result.errors?.[0];
  if (error || !result.data) {
    const status = Number(error?.extensions?.status ?? 422);
    throw new Response(error?.message ?? "No data", { status: status >= 400 && status < 600 ? status : 422 });
  }
  return result.data as Record<string, unknown>;
}
/** The one installation of `template` this owner has, or a blocker. */
export async function appInstallation(c: PlanningContext, template: string, label: string) {
  const apps = await c.host().call("actions.list", { template });
  if (apps.length === 1) return { installationId: apps[0].installationId, actions: apps[0].actions, blocker: null };
  return { installationId: null, actions: [], blocker: apps.length ? `More than one ${label} is installed; the handoff needs exactly one.` : `${label} is not installed for this owner.` };
}

export const planningMarker = (projectId: string) => `planning-project: ${projectId}`;
export const packageMarker = (digest: string) => `planning-package: ${digest}`;
const slug = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "PART";

/** The Workshop text and assembly the package projects to. Unknown cost and placement are said
 * in notes: Workshop's schema stores 0, which the package keeps as null. */
async function workshopProjection(projectId: string, pkg: PackageRow, foundry: PackageRow | null) {
  const body = pkg.body as ReturnType<typeof workshopBody> & {};
  const list = (title: string, items: string[]) => items.length ? [`## ${title}`, "", ...items.map((item) => `- ${item}`), ""] : [];
  const brief = [body.objective || `Hardware for ${body.project.name}.`, "", body.productRevision?.title ? `Product revision: ${body.productRevision.title}.` : "", "This is a proposed handoff from Planning. Nothing has been purchased, generated, fabricated or fit-checked."].filter(Boolean).join("\n").slice(0, 8000);
  const requirements = [
    ...list("Requirements", body.requirements.map((r) => `${r.title} (${r.key} rev ${r.revision})`)),
    ...list("Acceptance criteria", body.acceptanceCriteria.map((a) => `${a.criterion} (${a.requirement})`)),
    ...list("Wiring", body.wiring.map((w) => `${w.from} → ${w.to}: ${w.signal}`)),
    ...list("Interfaces", body.interfaces.map((i) => `${i.name}: ${i.value}`)),
    ...list("Dimensions", body.dimensions.map((d) => `${d.name}: ${d.value === null ? "unknown" : `${d.value} mm`}${d.verified ? "" : " (unverified)"}`)),
    ...list("Constraints", body.constraints.map((x) => x.constraint)),
    ...list("Assumptions", body.assumptions.map((x) => x.assumption)),
    ...list("Open questions", body.questions.map((q) => q.question)),
    ...list("Waiting", body.deferred.map((d) => d.reason)),
    ...(body.cad.required ? list("CAD and exports", [`Required for ${body.cad.for.join(", ")}: ${body.cad.exports.join(" and ")}`]) : []),
    `<!-- ${planningMarker(projectId)} -->`,
    `<!-- ${packageMarker(pkg.digest)} -->`,
  ].join("\n").slice(0, 16000);
  const root = await stableId("workshop-item", projectId, "root");
  const items = await Promise.all(body.bom.map(async (part) => ({
    id: await stableId("workshop-item", projectId, part.name),
    number: slug(part.mpn ?? part.name), revision: "A", name: part.name.slice(0, 150),
    kind: part.kind === "assembly" ? "assembly" : part.kind,
    manufacturer: part.manufacturer ?? "", mpn: part.mpn ?? "", unitCost: part.unitCost ?? 0,
    notes: [part.unitCost === null ? "Cost unknown." : "", "Source and inventory unknown.", "Placement unverified."].filter(Boolean).join(" "),
  })));
  const chip = body.bom.map((p) => `${p.name} ${p.mpn ?? ""}`).join(" ").match(/esp32-?(s3|c3|c6|s2)?/i);
  const repository = (foundry?.body as { repository?: string } | undefined)?.repository;
  const firmware = repository && chip ? [{
    id: await stableId("workshop-item", projectId, "firmware"), number: slug(`${body.project.name}-FW`), revision: "A", name: `${body.project.name} firmware`.slice(0, 150), kind: "firmware",
    firmware: { repository: `https://github.com/${repository}`, ref: "main", target: `esp32${(chip[1] ?? "").toLowerCase()}` },
    notes: "Proposed build target; no release or flashed unit is implied.",
  }] : [];
  const uses = await Promise.all([...items, ...firmware].map(async (item) => ({ id: await stableId("workshop-usage", projectId, item.id), itemId: item.id, quantity: body.bom.find((p) => slug(p.mpn ?? p.name) === item.number)?.quantity ?? 1 })));
  const assembly = { rootId: root, items: [{ id: root, number: slug(body.project.name), revision: "A", name: body.project.name.slice(0, 150), kind: "assembly", notes: "Proposed product structure from Planning; placements unverified.", uses }, ...items, ...firmware] };
  return { brief, requirements, assembly };
}

type Handoff = { revision: number; phase: string; requirements: string; assembly: { items: unknown[] } };
const readHandoff = async (c: PlanningContext, installationId: string, id: string) =>
  ((await appCall(c, installationId, workshopDocuments.handoff, { input: { id } })) as { workshopProjectHandoff: Handoff }).workshopProjectHandoff;

/** The Workshop project a receipt names, if it still exists. */
async function linkedWorkshopProject(c: PlanningContext, installationId: string, pkg: PackageRow, projectId: string) {
  const prior = (await listPackages(c, projectId)).filter((p) => p.target === "workshop" && p.receipt?.installationId === installationId && p.receipt?.projectId).at(-1);
  const id = (pkg.receipt?.projectId as string | undefined) ?? (prior?.receipt?.projectId as string | undefined);
  if (!id) return undefined;
  try { await readHandoff(c, installationId, id); return id; }
  catch (error) { if (error instanceof Response && error.status === 404) return undefined; throw error; }
}

/** After a lost reply, adopt the same-named project that carries this Planning project's marker or none. */
async function adoptableWorkshopProject(c: PlanningContext, installationId: string, projectId: string, projectName: string) {
  const { workshopProjects } = await appCall(c, installationId, workshopDocuments.projects) as { workshopProjects: { nodes: { id: string; name: string }[] } };
  for (const candidate of workshopProjects.nodes.filter((p) => p.name === projectName.slice(0, 100))) {
    const read = await readHandoff(c, installationId, candidate.id);
    if (read.requirements.includes(planningMarker(projectId)) || !read.requirements.includes("planning-project:")) return candidate.id;
  }
  return undefined;
}

async function workshopProjectFor(c: PlanningContext, installationId: string, pkg: PackageRow, projectId: string, projectName: string) {
  const found = await linkedWorkshopProject(c, installationId, pkg, projectId) ?? await adoptableWorkshopProject(c, installationId, projectId, projectName);
  if (found) return found;
  const created = await appCall(c, installationId, workshopDocuments.create, { input: { example: "node", name: projectName.slice(0, 100) } }) as { createWorkshopProject: { id: string } };
  return created.createWorkshopProject.id;
}

/** Create or update the one proposed Workshop project for this Planning project, then read it back. */
export async function syncWorkshop(c: PlanningContext, pkg: PackageRow, foundry: PackageRow | null, projectId: string, projectName: string) {
  const app = await appInstallation(c, "workshop", "Workshop");
  if (!app.installationId) return { installationId: null, projectId: null, readback: null, blocker: app.blocker };
  const installationId = app.installationId;
  const workshopProjectId = await workshopProjectFor(c, installationId, pkg, projectId, projectName);
  // Recorded before the follow-up writes, so a retry updates this project instead of starting another.
  await setPackageReceipt(c, pkg.id, { installationId, projectId: workshopProjectId, state: "linked" });
  let readback = await readHandoff(c, installationId, workshopProjectId);
  if (!readback.requirements.includes(packageMarker(pkg.digest))) {
    const { brief, requirements, assembly } = await workshopProjection(projectId, pkg, foundry);
    const described = await appCall(c, installationId, workshopDocuments.describe, { input: { id: workshopProjectId, revision: readback.revision, phase: "concept", brief, requirements } }) as { describeWorkshopProject: { revision: number } };
    await appCall(c, installationId, workshopDocuments.assembly, { input: { id: workshopProjectId, revision: described.describeWorkshopProject.revision, assembly } });
    readback = await readHandoff(c, installationId, workshopProjectId);
  }
  const verified = readback.requirements.includes(packageMarker(pkg.digest));
  const receipt = { installationId, projectId: workshopProjectId, state: verified ? "verified" : "unverified", revision: readback.revision, phase: readback.phase, items: readback.assembly.items.length, checkedAt: new Date().toISOString() };
  await setPackageReceipt(c, pkg.id, receipt);
  return { installationId, projectId: workshopProjectId, readback: receipt, blocker: verified ? null : "Workshop did not persist the package marker" };
}

// ---- Foundry: repository, connector and executor readiness, checked without submitting.

export async function foundryReadiness(c: PlanningContext, pkg: PackageRow) {
  const repository = (pkg.body as { repository?: string | null }).repository;
  const blockers: { code: string; message: string; remediation: string }[] = [];
  if (!repository) blockers.push({ code: "repository", message: "No repository target for the firmware/software work", remediation: "Set target.repository on the requirement or the project's GitHub repository." });
  const app = await appInstallation(c, "software-foundry", "Software Foundry");
  if (!app.installationId) blockers.push({ code: "foundry", message: app.blocker!, remediation: "Install Software Foundry for this organization." });
  let readiness: Record<string, unknown> | null = null;
  if (repository && app.installationId) {
    if (!app.actions.some((a) => a.name === "work.readiness" && a.permitted !== false)) blockers.push({ code: "foundry", message: "This Software Foundry cannot report readiness", remediation: "Update Software Foundry." });
    else {
      readiness = await c.host().call("actions.call", { installationId: app.installationId, action: "work.readiness", input: { repository } }) as Record<string, unknown>;
      blockers.push(...((readiness.blockers as typeof blockers | undefined) ?? []));
    }
  }
  return { installationId: app.installationId, repository, ready: blockers.length === 0, blockers, checkedAt: new Date().toISOString() };
}

// ---- Intake: one per project, revised for later changes; frozen delivery gets a follow-up.

function intakeDescription(project: { name: string }, requirements: Requirement[]) {
  return [`Requirements for ${project.name}, prepared from the Planning project.`, "",
    ...requirements.map((r) => `- **${r.body.title}** (${r.key} rev ${r.revision}, ${r.body.kind ?? "unclassified"}): ${r.body.statement}`)].join("\n").slice(0, 16000);
}
async function ensureIntake(service: IntakeService, prep: PreparationRow, project: { id: string; name: string }, requirements: Requirement[], analysis: Analysis) {
  const title = `${project.name}: requirements`.slice(0, 200);
  const description = intakeDescription(project, requirements);
  const proposal = analysis.routes.length ? validateRoutes({ routes: analysis.routes.map((route) => ({ kind: route.kind, dependsOn: [], rationale: `Requirements ${route.keys.join(", ")}` })) }) : null;
  const firstId = await stableId("planning-intake", service.c.identity.installationId, project.id);
  let row = await service.get(firstId).catch(() => null);
  if (!row) row = await service.create({ requestId: firstId, kind: "requirement-change", title, description, projectId: project.id, sources: [] });
  else if (row.body.lastReview !== prep.id && row.body.input.description !== description) {
    try {
      row = await reviseScope(service, { intakeId: row.id, revision: row.revision, requestId: prep.id, title, description, sources: [] });
    } catch (error) {
      // Submitted delivery is frozen: a follow-up intake carries the changed requirements.
      if (!(error instanceof Response && error.status === 409)) throw error;
      const followUp = await stableId("planning-intake", service.c.identity.installationId, project.id, prep.projectRevision);
      row = await service.get(followUp).catch(() => null) ?? await service.create({ requestId: followUp, kind: "requirement-change", title, description, projectId: project.id, sources: [] });
    }
  }
  const kinds = new Set(row.body.routes.map((route) => route.kind));
  const wanted = new Set(proposal?.routes.map((route) => route.kind) ?? []);
  const started = row.body.routes.some((child) => child.claim || child.result || child.receipt || child.submissionIntent);
  if (proposal && !started && (kinds.size !== wanted.size || [...wanted].some((kind) => !kinds.has(kind)))) row = await service.route(row, proposal);
  return row;
}

// ---- The task.

const terminal: readonly string[] = ["prepared", "blocked", "superseded"];
async function newerPreparation(c: PlanningContext, prep: PreparationRow) {
  const latest = await latestPreparation(c, prep.projectId);
  return latest && latest.projectRevision > prep.projectRevision ? latest : null;
}
async function requirementsAt(c: PlanningContext, prep: PreparationRow): Promise<Requirement[]> {
  const out: Requirement[] = [];
  for (const item of prep.changes.requirements) {
    const [row] = await c.store().query({ sql: "SELECT body FROM planning_requirement_revisions WHERE requirementId=? AND revision=?", params: [item.id, item.revision] });
    if (row) out.push({ ...item, body: requirementInput.parse(JSON.parse(String(row.body))) });
  }
  return out;
}

/** Answers the model router's route kinds for requirements with no kind. */
async function routeUnclassified(service: IntakeService, prep: PreparationRow, project: { id: string; name: string }, requirements: Requirement[]) {
  const unset = requirements.filter((r) => !r.body.kind);
  if (!unset.length) return {};
  const scratch = await stableId("planning-route", service.c.identity.installationId, prep.id);
  let row = await service.get(scratch).catch(() => null);
  row ??= await service.create({ requestId: scratch, kind: "requirement-change", title: `${project.name}: unclassified requirements`.slice(0, 200), description: intakeDescription(project, unset), projectId: project.id, sources: [] });
  const { proposal } = await service.proposeRoute(row);
  const kinds = new Set(proposal.routes.map((r) => r.kind));
  const targets: Target[] = [...(kinds.has("hardware") ? ["workshop" as const] : []), ...(kinds.has("implementation") ? ["foundry" as const] : [])];
  return Object.fromEntries(unset.map((r) => [r.key, targets]));
}

type Blocker = { code: string; target?: Target; message: string; remediation: string };
const errorText = async (error: unknown) => (error instanceof Response ? await error.clone().text() : error instanceof Error ? error.message : String(error)).slice(0, 500);
const routeTarget = (kind: string): Target | undefined => (kind === "hardware" ? "workshop" : kind === "implementation" ? "foundry" : undefined);

async function routedKinds(service: IntakeService, prep: PreparationRow, project: { id: string; name: string }, requirements: Requirement[], blockers: Blocker[]) {
  try { return await routeUnclassified(service, prep, project, requirements); }
  catch (error) {
    blockers.push({ code: "routing", message: `Routing unavailable: ${error instanceof Response ? await errorText(error) : "router failed"}`.slice(0, 500), remediation: "Set each requirement's kind, then save again." });
    return {};
  }
}

/** Workshop sync and Foundry readiness run in parallel; each failure becomes a blocker. */
async function handoff(c: PlanningContext, p: { id: string; name: string }, workshop: PackageRow | null, foundry: PackageRow | null, blockers: Blocker[]) {
  const [workshopSync, readiness] = await Promise.all([
    workshop ? syncWorkshop(c, workshop, foundry, p.id, p.name).catch(async (error) => ({ installationId: null, projectId: null, readback: null, blocker: `Workshop handoff failed: ${await errorText(error)}`.slice(0, 500) })) : null,
    foundry ? foundryReadiness(c, foundry).catch(async (error) => ({ installationId: null, repository: null, ready: false, blockers: [{ code: "foundry", message: `Readiness unavailable: ${await errorText(error)}`.slice(0, 500), remediation: "Retry preparation." }], checkedAt: new Date().toISOString() })) : null,
  ]);
  if (workshopSync?.blocker) blockers.push({ code: "workshop", target: "workshop", message: workshopSync.blocker, remediation: "Install Workshop for this organization, then retry preparation." });
  if (foundry && readiness) {
    for (const blocker of readiness.blockers) blockers.push({ ...blocker, target: "foundry" });
    await setPackageReceipt(c, foundry.id, { readiness });
  }
  return { workshop: workshopSync, foundry: readiness };
}

async function loadProject(c: PlanningContext, id: string) {
  const [project] = await c.store().query({ sql: "SELECT id,name,githubRepository FROM planning_projects WHERE installationId=? AND id=?", params: [c.identity.installationId, id] });
  if (!project) throw new Response("Project not found", { status: 404 });
  return { id: String(project.id), name: String(project.name), githubRepository: String(project.githubRepository ?? "") };
}

/** Analysis, intake, packages and handoffs for one running preparation. */
async function prepare(c: PlanningContext, start: PreparationRow): Promise<PreparationRow> {
  let prep = start;
  const p = await loadProject(c, prep.projectId);
  const requirements = await requirementsAt(c, prep);
  const service = new IntakeService(c);
  const blockers: Blocker[] = [];
  const routed = await routedKinds(service, prep, p, requirements, blockers);
  const analysis = analyze(requirements, routed);
  const intake = await ensureIntake(service, prep, p, requirements, analysis);
  const routes = intake.body.routes.map((route) => ({ id: route.id, kind: route.kind, dependsOn: route.dependsOn, gate: route.gate ?? null, requirements: analysis.routes.find((r) => r.kind === route.kind)?.keys ?? [] }));
  for (const route of routes.filter((r) => !r.gate)) blockers.push({ code: "governance", target: routeTarget(route.kind), message: `No active Governance work gate governs ${route.kind} work`, remediation: `Add ${route.kind} to an active work gate's work kinds in Governance (a reviewed Wiki change).` });
  prep = await updatePreparation(c, prep, { plan: { intakeId: intake.id, routes } });
  const conflicted = (target: Target) => analysis.conflicts.some((conflict) => conflict.targets.includes(target));
  const wBody = workshopBody(p, requirements, analysis, routed);
  const fBody = foundryBody(p, requirements, analysis, routed);
  const workshop = wBody ? await freezePackage(c, prep, "workshop", wBody, conflicted("workshop")) : null;
  const foundry = fBody ? await freezePackage(c, prep, "foundry", fBody, conflicted("foundry")) : null;
  for (const conflict of analysis.conflicts) blockers.push({ code: "conflict", message: `${conflict.interface} has conflicting values: ${conflict.values.map((v) => `${v.value} (${v.requirement})`).join(", ")}`, remediation: "Revise one requirement so every requirement gives the interface the same value." });
  // Another revision may have been saved meanwhile: write nothing outside Planning for this one.
  if (await newerPreparation(c, prep)) return updatePreparation(c, prep, { state: "superseded" });
  const handoffs = await handoff(c, p, workshop?.row ?? null, foundry?.row ?? null, blockers);
  const packages = [workshop, foundry].filter((x) => x !== null).map(({ row, reused }) => ({ id: row.id, target: row.target, sequence: row.sequence, digest: row.digest, state: row.state, reused }));
  const plan = { intakeId: intake.id, routes, packages, questions: analysis.questions, conflicts: analysis.conflicts, deferred: analysis.deferred, assumptions: analysis.assumptions, blockers, ...handoffs };
  return updatePreparation(c, prep, { state: analysis.conflicts.length ? "blocked" : "prepared", plan });
}

export async function runPreparation(c: PlanningContext, raw: PhaseInput): Promise<PhaseInput> {
  requireEditor(c.identity);
  const invocation = taskInvocation.parse(raw);
  if (invocation.task !== preparationTask) throw new Response("Unknown registered task", { status: 404 });
  const { preparationId } = z.strictObject({ preparationId: z.uuid() }).parse(invocation.inputs);
  const prep = await getPreparation(c, preparationId);
  if (!prep) throw new Response("Preparation not found", { status: 404 });
  const finish = async (p: PreparationRow) => {
    const result = { preparationId: p.id, projectRevision: p.projectRevision, state: p.state, summary: preparationSummary(p) };
    await c.host().call("workflow.collect", { runId: invocation.runId, slot: "prepare.outputs.result", value: result as never });
    return result as unknown as PhaseInput;
  };
  if (terminal.includes(prep.state)) return finish(prep);
  if (await newerPreparation(c, prep)) return finish(await updatePreparation(c, prep, { state: "superseded" }));
  try {
    return finish(await prepare(c, await updatePreparation(c, prep, { state: "running", dispatchError: null })));
  } catch (error) {
    const message = error instanceof Response ? `${error.status}: ${await errorText(error)}` : error instanceof Error ? error.message.slice(0, 500) : "Preparation failed";
    const current = await getPreparation(c, preparationId);
    if (current) await updatePreparation(c, current, { state: "failed", dispatchError: message }).catch(() => undefined);
    throw error;
  }
}
