// ProjectDelivery and SubmitDeliveryPackage (docs/plans/project-delivery-flow.md). Readiness is
// computed from persisted records read back from each app, never from agent prose or a task's
// completion. Submission is separate from preparation: editor, current package, ready route,
// Governance approval of the package subject, then Foundry's existing work.submit.
import { requireEditor, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { latestPreparation, loadRequirements, preparationSummary } from "./delivery";
import {
  appCall, foundryReadiness, getPackage, listPackages, packageMarker, type PackageRow, workshopDocuments,
} from "./delivery-prepare";
import { IntakeService, type PlanningContext } from "./intake";
import { intakeQuestions } from "./intake-conversation";
import { canonicalJSON } from "./work-packages";

export const deliveryInput = z.strictObject({ projectId: z.uuid() });

type Milestone = { id: string; label: string; state: "not_started" | "not_required" | "prepared" | "in_progress" | "evidenced" | "blocked"; evidence: string[]; missing: string[] };
const latestOf = (packages: PackageRow[], target: "workshop" | "foundry") =>
  packages.filter((p) => p.target === target && p.state !== "superseded").sort((a, b) => b.sequence - a.sequence)[0] ?? null;
const text = async (error: unknown) => error instanceof Response ? `${error.status}: ${(await error.text()).slice(0, 300)}` : String(error).slice(0, 300);

/** The Workshop project as persisted now, and its inventory units. */
async function workshopReadback(c: PlanningContext, pkg: PackageRow | null) {
  const receipt = pkg?.receipt as { installationId?: string; projectId?: string } | null | undefined;
  if (!pkg || !receipt?.installationId || !receipt.projectId) return null;
  try {
    const { workshopProjectHandoff } = await appCall(c, receipt.installationId, workshopDocuments.handoff, { input: { id: receipt.projectId } }) as { workshopProjectHandoff: Record<string, unknown> & { requirements: string } };
    const units = await appCall(c, receipt.installationId, `query PlanningWorkshopUnits($projectId: [ID!]) { workshopUnits(projectId: $projectId, first: 100) { nodes { id partNumber status firmware } } }`, { projectId: [receipt.projectId] })
      .then((data) => (data.workshopUnits as { nodes: Record<string, unknown>[] }).nodes).catch(() => null);
    return { ...workshopProjectHandoff, matchesPackage: workshopProjectHandoff.requirements.includes(packageMarker(pkg.digest)), units };
  } catch (error) {
    return { error: await text(error) };
  }
}

/** Foundry's own readback of a submitted package: issue, run, PRs and checks. */
async function foundryReadback(c: PlanningContext, pkg: PackageRow | null) {
  const submission = (pkg?.receipt as { submission?: { submissionId?: string; installationId?: string } } | null | undefined)?.submission;
  if (!submission?.submissionId || !submission.installationId) return null;
  try { return await c.host().call("actions.call", { installationId: submission.installationId, action: "work.get", input: { submissionId: submission.submissionId } }) as Record<string, unknown>; }
  catch (error) { return { error: await text(error) }; }
}

type MilestoneInput = {
  workshop: PackageRow | null; foundry: PackageRow | null; workshopRead: Record<string, unknown> | null; foundryRead: Record<string, unknown> | null; pressRelease: string;
};
type PullRequest = { merged?: boolean; state?: string; url?: string; checks?: { check_runs?: { conclusion?: string }[] } };

function documentsMilestone({ workshop, foundry, workshopRead }: MilestoneInput): Milestone {
  const docs: Milestone = { id: "documents", label: "Prepared documents and BOM", state: "not_started", evidence: [], missing: [] };
  if (workshop && workshopRead?.matchesPackage) docs.evidence.push(`Workshop project ${String(workshopRead.id)} rev ${String(workshopRead.revision)} persists package ${workshop.digest.slice(0, 12)}`);
  if (workshop && !workshopRead?.matchesPackage) docs.missing.push("Workshop project does not yet persist the current hardware package");
  if (foundry) docs.evidence.push(`Foundry package ${foundry.digest.slice(0, 12)} frozen (sequence ${foundry.sequence})`);
  if (workshop || foundry) docs.state = docs.missing.length ? "prepared" : "evidenced";
  return docs;
}

function cadMilestone({ workshop }: MilestoneInput): Milestone {
  const cad = (workshop?.body as { cad?: { required: boolean; for: string[] } } | undefined)?.cad;
  if (!cad?.required) return { id: "cad", label: "Generated CAD and valid exports", state: "not_required", evidence: [], missing: [] };
  return { id: "cad", label: "Generated CAD and valid exports", state: "not_started", evidence: [], missing: [`CAD and STEP/STL exports for ${cad.for.join(", ")}: no export record is readable yet`] };
}

function softwareMilestones({ foundry, foundryRead }: MilestoneInput): Milestone[] {
  const label = { build: "Generated software and successful validation/build", pr: "Reviewable PR", release: "Merged or released software" };
  if (!foundry) return [
    { id: "software-build", label: label.build, state: "not_required", evidence: [], missing: [] },
    { id: "pull-request", label: label.pr, state: "not_required", evidence: [], missing: [] },
    { id: "software-release", label: label.release, state: "not_required", evidence: [], missing: [] },
  ];
  const prs = (foundryRead?.pullRequests as PullRequest[] | undefined) ?? [];
  const blockers = (foundry.receipt as { readiness?: { blockers?: { message: string }[] } } | null)?.readiness?.blockers ?? [];
  const runs = (pr: PullRequest) => pr.checks?.check_runs ?? [];
  const passing = prs.some((pr) => runs(pr).length > 0 && runs(pr).every((run) => run.conclusion === "success"));
  const merged = prs.filter((p) => p.merged);
  const buildState = passing ? "evidenced" : foundryRead ? "in_progress" : blockers.length ? "blocked" : "not_started";
  return [
    { id: "software-build", label: label.build, state: buildState, evidence: passing ? ["Passing checks on a Foundry pull request"] : [], missing: passing ? [] : ["Passing checks on the candidate commit", ...blockers.map((b) => b.message)] },
    { id: "pull-request", label: label.pr, state: prs.some((p) => p.state === "open" || p.merged) ? "evidenced" : "not_started", evidence: prs.map((p) => p.url ?? "").filter(Boolean), missing: prs.length ? [] : ["No pull request read back from Foundry"] },
    { id: "software-release", label: label.release, state: merged.length ? "evidenced" : "not_started", evidence: merged.map((p) => p.url ?? ""), missing: merged.length ? [] : ["No merged pull request or release"] },
  ];
}

function physicalMilestone({ workshop, workshopRead }: MilestoneInput): Milestone {
  const label = "Physical fabrication, assembly, flashing and bench results";
  if (!workshop) return { id: "physical", label, state: "not_required", evidence: [], missing: [] };
  const units = (workshopRead?.units as { status?: string; firmware?: string }[] | null | undefined) ?? [];
  const flashed = units.filter((u) => u.status === "installed" && u.firmware);
  return { id: "physical", label, state: flashed.length ? "in_progress" : "not_started",
    evidence: flashed.length ? [`${flashed.length} unit(s) installed with firmware in Workshop inventory`] : [], missing: ["Bench results for every hardware acceptance criterion (wiring, I²C scan, readings)"] };
}

/** Separate milestones; each is evidenced only by what an app reads back, never by a finished task. */
export function milestones(input: MilestoneInput): Milestone[] {
  const drafted = input.pressRelease.trim().length > 0;
  const marketing: Milestone = { id: "marketing", label: "Marketing assets and publication readiness", state: drafted ? "prepared" : "not_started", evidence: drafted ? ["Draft press release in the Planning project"] : [], missing: ["Publication needs its own approval"] };
  const manufacturing: Milestone = { id: "manufacturing", label: "Manufacturing readiness", state: input.workshopRead?.phase === "manufacturing" ? "in_progress" : "not_started", evidence: [], missing: ["Manufacturing evaluations; never inferred from preparation"] };
  return [documentsMilestone(input), cadMilestone(input), ...softwareMilestones(input), physicalMilestone(input), marketing, manufacturing];
}

/** Everything the handoff persisted, read back from each app. */
export async function projectDelivery(c: PlanningContext, { projectId }: z.output<typeof deliveryInput>) {
  const [project] = await c.store().query({ sql: "SELECT id,name,revision,githubRepository,pressRelease FROM planning_projects WHERE installationId=? AND id=?", params: [c.identity.installationId, projectId] });
  if (!project) throw new Response("Project not found", { status: 404 });
  const [requirements, prep, packages, intakes] = await Promise.all([loadRequirements(c, projectId), latestPreparation(c, projectId), listPackages(c, projectId), new IntakeService(c).forProject(projectId)]);
  const workshop = latestOf(packages, "workshop"), foundry = latestOf(packages, "foundry");
  const [workshopRead, foundryRead] = await Promise.all([workshopReadback(c, workshop), foundryReadback(c, foundry)]);
  const preparations = await c.store().query({ sql: "SELECT id,projectRevision,state,dispatchError FROM planning_preparations WHERE installationId=? AND projectId=? ORDER BY projectRevision", params: [c.identity.installationId, projectId] });
  return {
    project: { id: String(project.id), name: String(project.name), revision: Number(project.revision) },
    intakeDecisions: { items: intakes.rows.map(intakeQuestions), truncated: intakes.truncated, coverage: "Latest 100 project-linked intakes in this installation; questions are pending decisions, not delivery evidence." },
    requirements: requirements.map((r) => ({ id: r.id, revision: r.revision, retired: r.retired, ...r.body })),
    preparation: { ...preparationSummary(prep), plan: prep?.plan ?? null },
    preparations,
    packages: packages.map((p) => ({ ...p, readback: p.id === workshop?.id ? workshopRead : p.id === foundry?.id ? foundryRead : null })),
    milestones: milestones({ workshop, foundry, workshopRead, foundryRead, pressRelease: String(project.pressRelease ?? "") }),
    acceptance: requirements.filter((r) => !r.retired).flatMap((r) => r.body.acceptanceCriteria.map((criterion) => ({ requirement: r.key, criterion, state: "unverified", evidence: [] as string[] }))),
  };
}

export const submitPackageInput = z.strictObject({
  requestId: z.uuid().describe("Your retry key: the same id with the same package returns the same submission."),
  packageId: z.uuid(),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Foundry's frozen package shape, built from the Planning package. */
function frozenFor(c: PlanningContext, pkg: PackageRow) {
  const body = pkg.body as { objective: string; repository: string; requirements: { id: string; key: string; revision: number; title: string }[]; acceptanceCriteria: { requirement: string; criterion: string }[];
    deliverables: { path: string }[]; sharedInterfaces: { name: string; value: string }[]; unknowns: { unknown: string }[] };
  const ref = (r: { id: string; revision: number }) => ({ installationId: c.identity.installationId, type: "requirement", id: r.id, revision: r.revision });
  const rendered = [`# ${body.objective.slice(0, 300)}`, "", `Planning package ${pkg.digest} (sequence ${pkg.sequence}).`, "",
    "## Requirements", ...body.requirements.map((r) => `- ${r.title} (${r.key} rev ${r.revision})`), "",
    "## Shared interfaces", ...body.sharedInterfaces.map((i) => `- ${i.name}: ${i.value}`), "",
    "## Deliverables", ...body.deliverables.map((d) => `- ${d.path}`), "",
    "## Unknowns", ...(body.unknowns.length ? body.unknowns.map((u) => `- ${u.unknown}`) : ["- None stated"])].join("\n").slice(0, 40000);
  const criteria = body.acceptanceCriteria.map((a) => {
    const r = body.requirements.find((item) => item.key === a.requirement)!;
    return { ...ref(r), condition: r.title.slice(0, 2000), expectedOutcome: a.criterion.slice(0, 2000) };
  });
  return { version: 1 as const, rendered, sources: body.requirements.map(ref), criteria };
}

/** A replay of the same request returns the earlier submission; anything else not proposed is refused. */
function priorSubmission(pkg: PackageRow, v: z.output<typeof submitPackageInput>) {
  if (pkg.target !== "foundry") throw new Response("Only a Foundry package is submitted; the Workshop handoff is prepared in Workshop and built under its own review", { status: 409 });
  if (pkg.digest !== v.expectedDigest) throw new Response("The package changed; read ProjectDelivery and review the current digest", { status: 409 });
  const prior = (pkg.receipt as { submission?: Record<string, unknown> & { requestId?: string } } | null)?.submission;
  if (pkg.state === "submitted" && prior) {
    if (prior.requestId !== v.requestId) throw new Response("This package was already submitted under another request", { status: 409 });
    return { status: "submitted", package: { id: pkg.id, digest: pkg.digest }, submission: prior };
  }
  if (pkg.state === "blocked") throw new Response("Conflicting requirements block this package; resolve them with a requirement revision", { status: 409 });
  if (pkg.state !== "proposed") throw new Response(`This package is ${pkg.state}; submit the current package instead`, { status: 409 });
  return null;
}

/** The routed implementation child and its Governance gate. */
async function gatedImplementation(c: PlanningContext, service: IntakeService, pkg: PackageRow) {
  const prep = await latestPreparation(c, pkg.projectId);
  const plan = prep?.plan as { intakeId?: string; conflicts?: unknown[] } | null | undefined;
  if (!plan?.intakeId) throw new Response("Preparation has not routed this work yet", { status: 409 });
  if (plan.conflicts?.length) throw new Response("Conflicting requirements block execution", { status: 409 });
  const row = await service.get(plan.intakeId);
  const child = row.body.routes.find((route) => route.kind === "implementation");
  if (!child?.gate) throw new Response("No Governance work gate governs this implementation; add one before submitting", { status: 409 });
  await service.ready(row, child);
  return { row, child, gate: child.gate };
}

/** Null when the gate approves this exact package; otherwise the review it requested. */
async function gateReview(c: PlanningContext, gate: { installationId: string; controlId: string }, pkg: PackageRow) {
  const subject = { ref: { installationId: c.identity.installationId, type: "delivery-package", id: pkg.id }, revision: pkg.sequence, digest: pkg.digest };
  try {
    await c.host().call("actions.call", { installationId: gate.installationId, action: "governance.verify-gate", input: { controlId: gate.controlId, subject } });
    return null;
  } catch (error) {
    if (!(error instanceof Response && error.status === 409)) throw error;
    return c.host().call("actions.call", { installationId: gate.installationId, action: "governance.request-gate", input: { controlId: gate.controlId, subject } });
  }
}

export async function submitDeliveryPackage(c: PlanningContext, v: z.output<typeof submitPackageInput>) {
  requireEditor(c.identity);
  const pkg = await getPackage(c, v.packageId);
  if (!pkg) throw new Response("Package not found", { status: 404 });
  const replay = priorSubmission(pkg, v);
  if (replay) return replay;
  const service = new IntakeService(c);
  const { row, child, gate } = await gatedImplementation(c, service, pkg);
  const review = await gateReview(c, gate, pkg);
  if (review) return { status: "awaiting_review", package: { id: pkg.id, digest: pkg.digest }, review,
    instructions: [{ code: "AWAIT_REVIEW", actor: "human", required: true, message: "The package's Governance decision is required before Foundry receives it; submitting again after approval sends it." }] };
  const readiness = await foundryReadiness(c, pkg);
  if (!readiness.ready || !readiness.installationId) throw new Response(`Foundry is not ready: ${readiness.blockers.map((b) => `${b.message} (${b.remediation})`).join("; ")}`, { status: 409 });
  const attempt = await service.beginSubmission(row, child, v.requestId, pkg.digest);
  const body = pkg.body as { objective: string; repository: string; acceptanceCriteria: { criterion: string }[] };
  const frozen = frozenFor(c, pkg);
  try {
    const workPackage = { ...frozen, digest: await sha256Hex(canonicalJSON(frozen)) };
    const submission = await c.host().call("actions.call", { installationId: readiness.installationId, action: "work.submit", input: {
      target: { repository: body.repository }, requestId: v.requestId, title: body.objective.slice(0, 200), description: frozen.rendered,
      acceptanceCriteria: body.acceptanceCriteria.map((a) => a.criterion.slice(0, 2000)).slice(0, 50), workPackage,
    } as never }) as Record<string, unknown>;
    const receipt = { ...submission, requestId: v.requestId, installationId: readiness.installationId };
    await c.store().batch([{ sql: "UPDATE planning_delivery_packages SET state='submitted',receipt=?,updatedAt=? WHERE id=? AND installationId=? AND state='proposed'", params: [JSON.stringify({ ...(pkg.receipt ?? {}), submission: receipt }), Date.now(), pkg.id, c.identity.installationId] }]);
    await service.saveDeliveryReceipt(row.id, child.id, receipt);
    return { status: "submitted", package: { id: pkg.id, digest: pkg.digest }, submission: receipt };
  } catch (error) {
    await service.failedSubmission(row.id, child.id, attempt, error);
    throw error;
  }
}
