import { z } from "zod";
import {
  defineAction,
  type ActionContext,
} from "@ai-outfitter/app-sdk/actions";
import type {
  AgentDatabase,
  AgentStatement,
} from "@ai-outfitter/app-sdk/agent-store";
import { requireEditor } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { defaultWiki } from "@ai-outfitter/app-sdk/graph-client";
import type { PlanningDatabase } from "./planning";
import { planningEntities } from "./entities";
import { projectWork } from "./work-projection";
import {
  previewWork,
  previewInput,
  packageDigest,
  canonicalJSON,
} from "./work-packages";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
const reference = z.strictObject({
  installationId: z.string().min(1),
  type: z.string().min(1),
  id: z.string().min(1),
});
const evidenceReference = z.strictObject({
  kind: z.enum(["check", "review", "image"]),
  id: z.string().min(1).max(300),
});
const readView = z.enum([
  "full",
  "snapshot",
  "evidence",
  "acceptance",
  "evaluations",
]);
const readbackViews = [
  "snapshot",
  "evidence",
  "acceptance",
  "evaluations",
] as const;
const readbackLimit = 500 * 1024;
const readbackSize = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
function boundedSection<T>(value: T): T {
  if (readbackSize(value) > readbackLimit)
    throw new Response(
      "Requested work section exceeds the 500 KiB response limit",
      { status: 413 },
    );
  return value;
}
export const submitWorkInput = z.strictObject({
  requestId: z.uuid(),
  preview: previewInput,
  expectedDigest: digest,
  foundryInstallationId: z.string().min(1),
  foundryProjectId: z.string().min(1),
  governanceInstallationId: z.string().min(1),
  controlId: z.uuid(),
});
export const evaluateWorkInput = z.strictObject({
  submissionId: z.uuid(),
  criterion: reference,
  criterionRevision: z.number().int().positive(),
  candidateCommit: commit,
  result: z.enum(["passed", "failed", "blocked", "not_run"]),
  method: z.string().trim().min(1).max(2000),
  evidence: z.array(evidenceReference).max(30),
});
const storedPolicy = z
  .object({
    controlRef: reference,
    controlRevision: z.number().int().positive(),
  })
  .passthrough();
const foundryReceipt = z.object({ submissionId: digest }).passthrough();
const pullRequest = z
  .object({
    number: z.number(),
    url: z.string(),
    repository: z.string(),
    headSha: commit,
    mergeSha: commit.nullable(),
    merged: z.boolean(),
    state: z.string(),
    reviews: z.array(z.record(z.string(), z.unknown())),
    checks: z
      .object({ check_runs: z.array(z.record(z.string(), z.unknown())) })
      .passthrough(),
  })
  .passthrough();
const foundryResults = z
  .object({
    submissionId: digest,
    repository: z.string(),
    issue: z.json(),
    workPackage: z.object({ digest }).passthrough(),
    pullRequests: z.array(pullRequest),
    evidence: z
      .object({
        images: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              revision: z.string().nullable(),
              url: z.string(),
            })
            .passthrough(),
        ),
        receipts: z.array(z.json()),
      })
      .passthrough(),
    blockers: z.array(z.string()),
  })
  .passthrough();
function parseResults(value: unknown) {
  const raw = z.record(z.string(), z.unknown()).safeParse(value);
  if (!raw.success)
    throw new Response(
      "Invalid Foundry results; inspect the provider blocker",
      { status: 502 },
    );
  const blockers = Array.isArray(raw.data.blockers)
    ? raw.data.blockers.filter(
        (value): value is string => typeof value === "string",
      )
    : ["Foundry blocker metadata is unavailable"];
  const candidates = Array.isArray(raw.data.pullRequests)
    ? raw.data.pullRequests
    : [];
  const pullRequests = candidates.flatMap((candidate) => {
    const parsed = pullRequest.safeParse(candidate);
    if (!parsed.success) {
      blockers.push(
        "Foundry returned malformed PR evidence; refresh after verification recovers",
      );
      return [];
    }
    return [parsed.data];
  });
  const parsed = foundryResults.safeParse({
    ...raw.data,
    pullRequests,
    blockers,
  });
  if (!parsed.success)
    throw new Response(
      "Foundry results lack a valid frozen package or evidence envelope",
      { status: 502 },
    );
  return parsed.data;
}
function policyBinding(policy: z.infer<typeof storedPolicy>) {
  const record = (value: unknown) =>
    z.record(z.string(), z.unknown()).parse(value);
  const assignment = (value: unknown) => {
    const row = record(value);
    return {
      duty: row.duty,
      roleId: row.roleId,
      assignmentId: record(row.assignment).id,
      holderId: row.holder ? record(row.holder).id : null,
    };
  };
  return canonicalJSON({
    controlRef: policy.controlRef,
    controlRevision: policy.controlRevision,
    accountableAssignment: assignment(policy.accountableAssignment),
    recommenderAssignment: policy.recommenderAssignment
      ? assignment(policy.recommenderAssignment)
      : null,
    requiredReviewers: Array.isArray(policy.requiredReviewers)
      ? policy.requiredReviewers
          .map(assignment)
          .sort((a, b) => canonicalJSON(a).localeCompare(canonicalJSON(b)))
      : [],
  });
}
function providerEvidenceId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value : null;
}
type Context = ActionContext & {
  db: () => PlanningDatabase;
  store: () => AgentDatabase;
  host: () => WorkflowHost<"interactive">;
};
type SubmissionInput = z.infer<typeof submitWorkInput>;
type Preview = Awaited<ReturnType<typeof previewWork>>;
type Evaluation = Omit<z.infer<typeof evaluateWorkInput>, "evidence"> & {
  evidence: (z.infer<typeof evidenceReference> & {
    revision?: string | null;
  })[];
  actor: string;
  recordedAt: number;
};
type Row = {
  id: string;
  installationId: string;
  projectId: string;
  actor: string;
  request: string;
  snapshot: string;
  policy: string;
  foundryReceipt: string | null;
  observation: string | null;
  review: string | null;
  accepted: string | null;
  revision: number;
  createdAt: number;
};
function conflict(message: string): never {
  throw new Response(message, { status: 409 });
}
const actorKey = (context: Context) =>
  `${context.identity.userId}:${context.originActor.kind}:${context.originActor.id}`;
function json(value: unknown): z.infer<ReturnType<typeof z.json>> {
  return JSON.parse(JSON.stringify(value));
}

/** Installation-owned execution ledger. App scope comes only from trusted
 * dispatch; foreign app reads/writes still cross the standard scoped host. */
export class WorkExecution {
  constructor(readonly context: Context) {}
  async call(installationId: string, action: string, input: unknown = {}) {
    return this.context
      .host()
      .call("actions.call", { installationId, action, input: json(input) });
  }
  async row(id: string): Promise<Row> {
    const [row] = await this.context.store().query({
      sql: "SELECT * FROM planning_work_submissions WHERE id=? AND installationId=?",
      params: [id, this.context.identity.installationId],
    });
    if (!row) throw new Response("Work submission not found", { status: 404 });
    return row as Row;
  }
  async update(
    row: Row,
    fields: Record<string, string | null>,
    extra: AgentStatement[] = [],
  ) {
    if (
      row.accepted &&
      (extra.length > 0 ||
        Object.keys(fields).some((field) => field !== "observation"))
    )
      conflict("Accepted work is immutable; prepare a new work package");
    const names = Object.keys(fields);
    if (
      names.some(
        (name) =>
          !["foundryReceipt", "review", "accepted", "observation"].includes(
            name,
          ),
      )
    )
      throw new Error("Invalid ledger update");
    try {
      await this.context.store().batch([
        {
          sql: `UPDATE planning_work_submissions SET ${names.length ? names.map((name) => `${name}=?`).join(",") + "," : ""}revision=revision+1 WHERE id=? AND installationId=? AND revision=?${row.accepted ? "" : " AND accepted IS NULL"}`,
          params: [
            ...Object.values(fields),
            row.id,
            this.context.identity.installationId,
            row.revision,
          ],
        },
        {
          sql: "INSERT INTO planning_work_guard(value) VALUES(CASE WHEN changes()=1 THEN 1 ELSE NULL END)",
        },
        { sql: "DELETE FROM planning_work_guard" },
        ...extra,
      ]);
    } catch (error) {
      if (error instanceof Error && /constraint|NOT NULL/i.test(error.message))
        conflict("Work changed; reload and retry");
      throw error;
    }
    return this.row(row.id);
  }
  snapshot(row: Row): Preview {
    return JSON.parse(row.snapshot);
  }
  input(row: Row): SubmissionInput {
    return submitWorkInput.parse(JSON.parse(row.request));
  }
  async freshness(row: Row) {
    try {
      const current = await previewWork(
        this.context.db(),
        this.context.identity,
        this.context.host(),
        this.input(row).preview,
      );
      return {
        currentDigest: current.digest,
        stale:
          current.digest !== this.snapshot(row).digest ||
          current.gaps.length > 0,
        blocker: current.gaps.join("; ") || null,
      };
    } catch (error) {
      if (!(error instanceof Response)) throw error;
      return {
        currentDigest: null,
        stale: true,
        blocker: "Source context is unavailable; reassess the package",
      };
    }
  }
  async execution(row: Row) {
    if (!row.foundryReceipt) return null;
    const input = this.input(row),
      receipt = foundryReceipt.parse(JSON.parse(row.foundryReceipt));
    const execution = parseResults(
      await this.call(input.foundryInstallationId, "work.get", {
        submissionId: receipt.submissionId,
      }),
    );
    if (execution.workPackage.digest !== this.snapshot(row).digest)
      conflict("Foundry results belong to a different frozen work package");
    return execution;
  }
  async evaluations(row: Row) {
    const rows = await this.context.store().query({
      sql: "SELECT data FROM planning_work_evaluations WHERE submissionId=? ORDER BY rowid",
      params: [row.id],
    });
    return rows.map((r) => JSON.parse(String(r.data)) as Evaluation);
  }
  candidateEvaluations(
    row: Row,
    candidateCommit: string,
    evaluations: Evaluation[],
  ) {
    return this.snapshot(row).criteria.flatMap((criterion) => {
      const evaluation = evaluations.find(
        (evaluation) =>
          canonicalJSON(evaluation.criterion) ===
            canonicalJSON(criterion.ref) &&
          evaluation.criterionRevision === criterion.revision &&
          evaluation.candidateCommit === candidateCommit,
      );
      return evaluation ? [evaluation] : [];
    });
  }
  async readExecution(row: Row) {
    const observation = row.observation ? JSON.parse(row.observation) : null;
    let currentLookupUnavailable: string | null = null;
    if (this.context.identity.canEdit) {
      try {
        return {
          execution: await this.execution(row),
          source: "live",
          observedAt: Date.now(),
          currentLookupUnavailable,
        };
      } catch (error) {
        if (!(error instanceof Response)) throw error;
        currentLookupUnavailable = `Current Foundry lookup unavailable (${error.status}); displayed evidence is the saved observation.`;
      }
    } else
      currentLookupUnavailable =
        "Current Foundry lookup requires execution authority; displayed evidence is the saved observation.";
    return {
      execution: observation?.execution
        ? foundryResults.parse(observation.execution)
        : null,
      source: observation ? "saved_observation" : "unavailable",
      observedAt: observation?.observedAt ?? null,
      currentLookupUnavailable,
    };
  }
  async readSection(
    row: Row,
    view: z.infer<typeof readView>,
    candidateCommit?: string,
  ) {
    const snapshot = this.snapshot(row);
    if (view === "snapshot") return boundedSection(snapshot);
    if (view === "acceptance")
      return boundedSection(row.accepted ? JSON.parse(row.accepted) : null);
    if (view === "evaluations") {
      const evaluations = await this.evaluations(row);
      const head =
        candidateCommit ??
        (row.accepted
          ? JSON.parse(row.accepted).candidate?.commit
          : evaluations.at(-1)?.candidateCommit);
      return boundedSection(
        this.candidateEvaluations(row, head ?? "", evaluations),
      );
    }
    if (view === "evidence") {
      const { execution, ...executionSource } = await this.readExecution(row);
      return boundedSection({ execution, executionSource });
    }
    throw new Response("Unknown work readback view", { status: 400 });
  }
  async get(
    id: string,
    view: z.infer<typeof readView> = "full",
    candidateCommit?: string,
  ) {
    const row = await this.row(id),
      snapshot = this.snapshot(row);
    if (view !== "full") return this.readSection(row, view, candidateCommit);
    const [freshness, readback, evaluations] = await Promise.all([
      this.freshness(row),
      this.readExecution(row),
      this.evaluations(row),
    ]);
    const projection = row.observation
      ? (JSON.parse(row.observation).projection ?? null)
      : null;
    const state = {
      submission: {
        id: row.id,
        projectId: row.projectId,
        title: snapshot.title,
        createdAt: row.createdAt,
        snapshot,
        policy: JSON.parse(row.policy),
        foundryReceipt: row.foundryReceipt
          ? JSON.parse(row.foundryReceipt)
          : null,
        observation: row.observation
          ? { observedAt: JSON.parse(row.observation).observedAt, projection }
          : null,
        review: row.review ? JSON.parse(row.review) : null,
        accepted: row.accepted ? JSON.parse(row.accepted) : null,
      },
      freshness,
      projection,
      execution: readback.execution,
      executionSource: {
        source: readback.source,
        observedAt: readback.observedAt,
        currentLookupUnavailable: readback.currentLookupUnavailable,
      },
      evaluations,
      evaluationDigest: await packageDigest(
        this.candidateEvaluations(
          row,
          readback.execution?.pullRequests.find((pr) => pr.merged)?.headSha ??
            "",
          evaluations,
        ),
      ),
      blockers: [
        ...(projection?.status === "pending"
          ? [String(projection.message)]
          : []),
        ...(freshness.stale
          ? [
              freshness.blocker ||
                "Source context changed; reassess the work package",
            ]
          : []),
        ...(readback.execution?.blockers ?? []),
        ...(readback.currentLookupUnavailable
          ? [readback.currentLookupUnavailable]
          : []),
      ],
    };
    if (readbackSize(state) <= readbackLimit) return state;
    const notice =
      "Work is saved. Retrieve exact scope, provider evidence, acceptance and evaluations separately because combined readback exceeds 500 KiB.";
    return {
      summary: true,
      submission: {
        id: row.id,
        projectId: row.projectId,
        title: snapshot.title,
        createdAt: row.createdAt,
        accepted: Boolean(row.accepted),
      },
      notice,
      blockers: [notice, ...state.blockers],
      readbackViews,
    };
  }
  async submissions(projectId: string) {
    await planningEntities(this.context.db())[0].get(
      this.context.identity,
      projectId,
    );
    const rows = await this.context.store().query({
      sql: "SELECT id,snapshot,accepted,createdAt FROM planning_work_submissions WHERE installationId=? AND projectId=? ORDER BY createdAt DESC LIMIT 100",
      params: [this.context.identity.installationId, projectId],
    });
    return rows.map((row) => ({
      id: row.id,
      title: JSON.parse(String(row.snapshot)).title,
      createdAt: row.createdAt,
      accepted: Boolean(row.accepted),
    }));
  }
  async refresh(id: string) {
    requireEditor(this.context.identity);
    const original = await this.row(id),
      execution = await this.execution(original),
      observedAt = Date.now();
    const row = await this.update(original, {
      observation: JSON.stringify({
        observedAt,
        execution,
        projection: {
          status: "pending",
          message: "Wiki reconciliation pending",
        },
      }),
    });
    const snapshot = this.snapshot(row),
      evaluations = await this.evaluations(row);
    const body = [
      `# Work package: ${snapshot.title}`,
      `Frozen package SHA-256: ${snapshot.digest}`,
      "This node projects a canonical Planning execution. Provider observations and recorded acceptance are separate; follow its source for full context.",
      `Last observed: ${new Date(observedAt).toISOString()}`,
      `External issue: ${execution ? JSON.stringify(execution.issue) : "Not submitted"}`,
      ...(execution?.pullRequests.map(
        (pr) =>
          `PR: ${pr.url}; head ${pr.headSha}; observed merged ${pr.merged}; merge commit ${pr.mergeSha ?? "unknown"}`,
      ) ?? []),
      "## Criterion evaluations",
      ...evaluations.map(
        (evaluation) =>
          `${evaluation.criterion.id} revision ${evaluation.criterionRevision}, commit ${evaluation.candidateCommit}: ${evaluation.result}`,
      ),
      "## Recorded acceptance",
      row.accepted
        ? JSON.stringify(
            Object.fromEntries(
              Object.entries(JSON.parse(row.accepted)).filter(
                ([key]) => key !== "execution",
              ),
            ),
          )
        : "Acceptance has not been recorded.",
      "Exact evidence retained at acceptance is available through the canonical Planning source.",
    ].join("\n\n");
    let projection = { status: "current", message: "" };
    try {
      await projectWork(
        this.context.host(),
        this.context.identity,
        snapshot,
        id,
        body,
      );
    } catch (error) {
      if (!(error instanceof Response)) throw error;
      projection = {
        status: "pending",
        message: `Work saved; Wiki projection requires refresh (${error.status})`,
      };
    }
    try {
      await this.update(row, {
        observation: JSON.stringify({ observedAt, execution, projection }),
      });
    } catch (error) {
      if (!(error instanceof Response && error.status === 409)) throw error;
    }
    return this.get(id);
  }
  async afterWrite(id: string) {
    try {
      return await this.refresh(id);
    } catch (error) {
      if (!(error instanceof Response)) throw error;
      const state = await this.get(id);
      const message = `Work saved; evidence/graph refresh unavailable (${error.status})`;
      return {
        ...state,
        blockers: [...state.blockers, message],
        projection: {
          status: "pending",
          message,
        },
      };
    }
  }
  assertRequest(row: Row, input: SubmissionInput) {
    if (
      row.actor !== actorKey(this.context) ||
      canonicalJSON(this.input(row)) !== canonicalJSON(input)
    )
      conflict("Request identity is already bound to different work or actor");
    return row;
  }
  async prepare(input: SubmissionInput) {
    try {
      return this.assertRequest(await this.row(input.requestId), input);
    } catch (error) {
      if (!(error instanceof Response && error.status === 404)) throw error;
    }
    const snapshot = await previewWork(
      this.context.db(),
      this.context.identity,
      this.context.host(),
      input.preview,
    );
    if (snapshot.digest !== input.expectedDigest)
      conflict(
        "Preview changed; inspect the current work package before submitting",
      );
    if (snapshot.gaps.length || !snapshot.criteria.length)
      conflict("Every selected requirement needs acceptance criteria");
    const policy = storedPolicy.parse(
      await this.call(
        input.governanceInstallationId,
        "governance.work-policy",
        { controlId: input.controlId },
      ),
    );
    await this.context.store().batch([
      {
        sql: "INSERT OR IGNORE INTO planning_work_submissions(id,installationId,projectId,actor,request,snapshot,policy,createdAt) VALUES(?,?,?,?,?,?,?,?)",
        params: [
          input.requestId,
          this.context.identity.installationId,
          input.preview.projectId,
          actorKey(this.context),
          JSON.stringify(input),
          JSON.stringify(snapshot),
          JSON.stringify(policy),
          Date.now(),
        ],
      },
    ]);
    return this.assertRequest(await this.row(input.requestId), input);
  }
  async recover(input: SubmissionInput) {
    try {
      const recovered = parseResults(
        await this.call(input.foundryInstallationId, "work.get", {
          requestId: input.requestId,
        }),
      );
      if (recovered.workPackage.digest !== input.expectedDigest)
        conflict(
          "Recovered Foundry work belongs to a different frozen package",
        );
      return foundryReceipt.parse(recovered);
    } catch (error) {
      if (!(error instanceof Response && error.status === 404)) throw error;
      return null;
    }
  }
  async submitFrozen(row: Row, resume = false) {
    const input = this.input(row),
      snapshot = this.snapshot(row);
    if (!resume && (await this.freshness(row)).stale)
      conflict("Source context changed; prepare a new package");
    if (!resume) {
      const policy = storedPolicy.parse(
        await this.call(
          input.governanceInstallationId,
          "governance.work-policy",
          { controlId: input.controlId },
        ),
      );
      if (
        !resume &&
        policyBinding(policy) !==
          policyBinding(storedPolicy.parse(JSON.parse(row.policy)))
      )
        conflict(
          "Governance policy or assignments changed; prepare a new package",
        );
    }
    return foundryReceipt.parse(
      await this.call(input.foundryInstallationId, "work.submit", {
        requestId: input.requestId,
        target: { project: input.foundryProjectId },
        title: snapshot.title,
        description: snapshot.description,
        acceptanceCriteria: snapshot.criteria.map(
          (c) => `${c.title}: ${c.condition} → ${c.expectedOutcome}`,
        ),
        workPackage: snapshot.workPackage,
      }),
    );
  }
  async submit(raw: SubmissionInput) {
    requireEditor(this.context.identity);
    const input = submitWorkInput.parse(raw),
      row = await this.prepare(input);
    const prior = row.foundryReceipt
      ? foundryReceipt.parse(JSON.parse(row.foundryReceipt))
      : null;
    if (prior?.issue) return this.afterWrite(row.id);
    // Recover lost responses before considering a new external write.
    const recovered = await this.recover(input);
    const receipt = recovered?.issue
      ? recovered
      : await this.submitFrozen(row, Boolean(recovered || prior));
    try {
      await this.update(row, { foundryReceipt: JSON.stringify(receipt) });
    } catch (error) {
      if (
        !(error instanceof Response && error.status === 409) ||
        !(await this.row(row.id)).foundryReceipt
      )
        throw error;
    }
    return this.afterWrite(row.id);
  }
  providerArtifacts(
    records: Record<string, unknown>[],
    kind: "check" | "review",
    candidateCommit: string,
  ) {
    return records.flatMap((record) => {
      const id = providerEvidenceId(record.id);
      const head = kind === "check" ? record.head_sha : record.commit_id;
      if (!id || head !== candidateCommit) return [];
      return [
        {
          kind,
          id,
          revision: candidateCommit,
          successful:
            kind === "check"
              ? record.status === "completed" && record.conclusion === "success"
              : record.state === "APPROVED",
          url: String(record.html_url ?? ""),
        },
      ];
    });
  }
  artifacts(
    execution: z.infer<typeof foundryResults>,
    candidateCommit: string,
  ) {
    return [
      ...execution.pullRequests
        .filter((pr) => pr.headSha === candidateCommit)
        .flatMap((pr) => [
          ...this.providerArtifacts(
            pr.checks.check_runs,
            "check",
            candidateCommit,
          ),
          ...this.providerArtifacts(pr.reviews, "review", candidateCommit),
        ]),
      ...this.imageArtifacts(execution, candidateCommit),
    ];
  }
  imageArtifacts(
    execution: z.infer<typeof foundryResults>,
    candidateCommit: string,
  ) {
    return execution.evidence.images
      .filter((image) => image.revision === candidateCommit)
      .map((image) => ({
        kind: "image" as const,
        id: image.id,
        revision:
          typeof image.sha256 === "string"
            ? `${candidateCommit}:${image.sha256}`
            : image.revision,
        successful: false,
        url: image.url,
      }));
  }
  validateEvidence(
    execution: z.infer<typeof foundryResults>,
    evaluation: Pick<Evaluation, "candidateCommit" | "evidence" | "result">,
  ) {
    if (
      !execution.pullRequests.some(
        (pr) => pr.headSha === evaluation.candidateCommit,
      )
    )
      conflict("Candidate commit is not a current Foundry PR head");
    const available = this.artifacts(execution, evaluation.candidateCommit);
    const selected = evaluation.evidence.map((ref) => {
      const artifact = available.find(
        (artifact) => artifact.kind === ref.kind && artifact.id === ref.id,
      );
      if (!artifact)
        conflict(
          "Evidence reference is not present in current Foundry results for this candidate",
        );
      if (ref.revision !== undefined && ref.revision !== artifact.revision)
        conflict("Acceptance evidence revision changed; evaluate it again");
      return artifact;
    });
    if (
      evaluation.result === "passed" &&
      !selected.some((artifact) => artifact?.successful)
    )
      conflict(
        "Passed evaluations require successful exact-commit check or approval evidence",
      );
    if (
      evaluation.result === "passed" &&
      selected.some(
        (artifact) => artifact.kind !== "image" && !artifact.successful,
      )
    )
      conflict(
        "Passed evaluations cannot include failing checks or unapproved/dismissed reviews",
      );
    return selected;
  }
  async evaluate(input: z.infer<typeof evaluateWorkInput>) {
    requireEditor(this.context.identity);
    const row = await this.row(input.submissionId),
      snapshot = this.snapshot(row);
    if (
      !snapshot.criteria.some(
        (criterion) =>
          canonicalJSON(criterion.ref) === canonicalJSON(input.criterion) &&
          criterion.revision === input.criterionRevision,
      )
    )
      conflict("Criterion is not part of this frozen package revision");
    const execution = await this.execution(row);
    if (!execution) conflict("Submit work to Foundry before evaluating");
    const selected = this.validateEvidence(execution, input);
    const evaluation: Evaluation = {
      ...input,
      evidence: selected.map(({ kind, id, revision }) => ({
        kind,
        id,
        revision,
      })),
      actor: actorKey(this.context),
      recordedAt: Date.now(),
    };
    const id = await packageDigest({
      submissionId: row.id,
      criterion: input.criterion,
      candidateCommit: input.candidateCommit,
    });
    await this.update(row, {}, [
      {
        sql: "INSERT INTO planning_work_evaluations(id,submissionId,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        params: [id, row.id, JSON.stringify(evaluation)],
      },
    ]);
    return this.afterWrite(row.id);
  }
  async ready(row: Row, candidateCommit: string) {
    if ((await this.freshness(row)).stale)
      conflict("Source context changed; reassess before acceptance");
    const execution = await this.execution(row);
    if (!execution || execution.blockers.length)
      conflict("Foundry results are incomplete or blocked");
    const candidates = execution.pullRequests.filter(
      (pr) => pr.headSha === candidateCommit && pr.merged && pr.mergeSha,
    );
    if (!candidates.length)
      conflict(
        "Acceptance requires a verified merged PR for this exact candidate commit",
      );
    const evaluations = this.candidateEvaluations(
      row,
      candidateCommit,
      await this.evaluations(row),
    );
    for (const criterion of this.snapshot(row).criteria) {
      const evaluation = evaluations.find(
        (e) =>
          canonicalJSON(e.criterion) === canonicalJSON(criterion.ref) &&
          e.criterionRevision === criterion.revision &&
          e.candidateCommit === candidateCommit,
      );
      if (!evaluation || evaluation.result !== "passed")
        conflict(
          "All frozen criteria require passed evaluations for the exact candidate",
        );
      this.validateEvidence(execution, evaluation);
    }
    const policy = storedPolicy.parse(JSON.parse(row.policy));
    const input = this.input(row);
    const current = storedPolicy.parse(
      await this.call(
        input.governanceInstallationId,
        "governance.work-policy",
        { controlId: input.controlId },
      ),
    );
    if (policyBinding(policy) !== policyBinding(current))
      conflict(
        "Governance policy or assignments changed; reassess the package",
      );
    const evaluationDigest = await packageDigest(evaluations);
    return {
      candidate: {
        repository: execution.repository,
        version: `work:${evaluationDigest}`,
        commit: candidateCommit,
      },
      evaluationDigest,
      evaluations,
      execution,
      pullRequests: candidates.map((pr) => ({
        url: pr.url,
        headSha: pr.headSha,
        mergeSha: pr.mergeSha,
      })),
      artifacts: this.artifacts(execution, candidateCommit),
    };
  }
  async saveReview(
    id: string,
    review: {
      candidate: { commit: string };
      document: { evaluationDigest: string };
    },
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.row(id);
      if (current.accepted) return current;
      const evaluations = this.candidateEvaluations(
        current,
        review.candidate.commit,
        await this.evaluations(current),
      );
      if (
        (await packageDigest(evaluations)) !== review.document.evaluationDigest
      )
        conflict("Acceptance evaluations changed while requesting review");
      try {
        return await this.update(current, { review: JSON.stringify(review) });
      } catch (error) {
        if (!(error instanceof Response && error.status === 409)) throw error;
      }
    }
    conflict("Work changed while saving review; retry the same request");
  }
  async requestReview(input: {
    submissionId: string;
    candidateCommit: string;
    recommendation: string;
  }) {
    requireEditor(this.context.identity);
    const row = await this.row(input.submissionId);
    if (row.accepted) return this.get(row.id);
    const ready = await this.ready(row, input.candidateCommit),
      request = this.input(row);
    if (row.review) {
      const previous = JSON.parse(row.review);
      if (
        previous.document.evaluationDigest === ready.evaluationDigest &&
        previous.candidate.commit === input.candidateCommit &&
        previous.revision
      )
        return { ...(await this.afterWrite(row.id)), review: previous };
    }
    const occurrence = z
      .object({ id: z.uuid() })
      .passthrough()
      .parse(
        await this.call(
          request.governanceInstallationId,
          "governance.release",
          { controlId: request.controlId, candidate: ready.candidate },
        ),
      );
    const document = {
      schema_version: 1,
      kind: "planning_work_acceptance",
      packageDigest: this.snapshot(row).digest,
      evaluationDigest: ready.evaluationDigest,
      recommendation: [
        input.recommendation,
        `Work: ${this.snapshot(row).title}`,
        `Candidate: ${ready.candidate.repository} @ ${ready.candidate.commit}`,
        ...ready.pullRequests.map(
          (pr) =>
            `PR: ${pr.url}. Head: ${pr.headSha}. Merged commit: ${pr.mergeSha}.`,
        ),
        ...ready.evaluations
          .filter(
            (evaluation) =>
              evaluation.candidateCommit === input.candidateCommit,
          )
          .map((evaluation) => {
            const criterion = this.snapshot(row).criteria.find(
              (criterion) =>
                canonicalJSON(criterion.ref) ===
                canonicalJSON(evaluation.criterion),
            );
            const evidence = evaluation.evidence.map((reference) =>
              ready.artifacts.find(
                (artifact) =>
                  artifact.kind === reference.kind &&
                  artifact.id === reference.id,
              ),
            );
            return `${criterion?.title ?? evaluation.criterion.id} (revision ${evaluation.criterionRevision}): ${evaluation.result}.\nCondition: ${criterion?.condition}\nExpected: ${criterion?.expectedOutcome}\nMethod: ${evaluation.method}\nEvidence: ${evidence.map((artifact) => `${artifact?.kind}:${artifact?.id} ${artifact?.url ?? ""}`).join(", ")}`;
          }),
      ].join("\n\n"),
    };
    if (document.recommendation.length > 16000)
      conflict(
        "Review evidence exceeds the recommendation limit; narrow the work package",
      );
    const review = {
      occurrenceId: occurrence.id,
      document,
      candidate: ready.candidate,
      revision: null as number | null,
    };
    // Persist the deterministic occurrence before any claim or draft side effect.
    await this.saveReview(row.id, review);
    let claim;
    try {
      claim = z
        .object({
          claim: z.object({ token: z.uuid() }),
          document: z.object({
            revision: z.number().int().positive(),
            attributes: z.record(z.string(), z.unknown()).optional(),
          }),
        })
        .passthrough()
        .parse(
          await this.call(
            request.governanceInstallationId,
            "governance.claim",
            { occurrenceId: occurrence.id },
          ),
        );
    } catch (error) {
      if (!(error instanceof Response && error.status === 409)) throw error;
      // Already routed/decided or another active claimant: retain the durable
      // handle and let Governance expose the existing exact-revision state.
      return {
        ...(await this.afterWrite(row.id)),
        review,
        reviewNotice:
          "Existing Governance review is in progress; inspect its current state.",
      };
    }
    const savedDocumentMatches = (() => {
      try {
        const body = JSON.parse(String(claim.document.attributes?.body));
        return (
          claim.document.revision > 1 &&
          body.schema_version === 1 &&
          body.kind === "planning_work_acceptance" &&
          body.packageDigest === document.packageDigest &&
          body.evaluationDigest === document.evaluationDigest
        );
      } catch {
        return false;
      }
    })();
    const saved = savedDocumentMatches
      ? { revision: claim.document.revision }
      : z
          .object({ revision: z.number().int().positive() })
          .passthrough()
          .parse(
            await this.call(
              request.governanceInstallationId,
              "governance.save-draft",
              {
                occurrenceId: occurrence.id,
                token: claim.claim.token,
                revision: claim.document.revision,
                body: JSON.stringify(document),
              },
            ),
          );
    review.revision = saved.revision;
    // The authenticated current Recommend holder saves the draft. Submission,
    // required agreements and the separate decision remain explicit Governance actions.
    await this.saveReview(row.id, review);
    return { ...(await this.afterWrite(row.id)), review };
  }
  async accept(input: {
    submissionId: string;
    occurrenceId?: string;
    candidateCommit: string;
  }) {
    requireEditor(this.context.identity);
    const row = await this.row(input.submissionId);
    if (row.accepted) {
      if (JSON.parse(row.accepted).candidate?.commit !== input.candidateCommit)
        conflict("Accepted work is for a different candidate commit");
      return this.afterWrite(row.id);
    }
    const ready = await this.ready(row, input.candidateCommit),
      request = this.input(row);
    const occurrenceId =
      input.occurrenceId ??
      (row.review ? JSON.parse(row.review).occurrenceId : undefined);
    if (!occurrenceId)
      conflict("Request and complete Governance review before acceptance");
    const receipt = await this.call(
      request.governanceInstallationId,
      "governance.verify-work-acceptance",
      {
        controlId: request.controlId,
        controlRevision: storedPolicy.parse(JSON.parse(row.policy))
          .controlRevision,
        occurrenceId,
        candidate: ready.candidate,
        packageDigest: this.snapshot(row).digest,
        evaluationDigest: ready.evaluationDigest,
      },
    );
    const verified = z
      .object({
        verified: z.literal(true),
        purpose: z.literal("planning_acceptance"),
      })
      .passthrough()
      .parse(receipt);
    await this.update(row, {
      accepted: JSON.stringify({
        ...verified,
        execution: ready.execution,
        actor: actorKey(this.context),
        recordedAt: Date.now(),
      }),
      observation: JSON.stringify({
        observedAt: Date.now(),
        execution: ready.execution,
      }),
    });
    return this.afterWrite(row.id);
  }
  async destinations() {
    const catalog = await this.context.host().call("actions.list", {});
    const foundries: { installationId: string; projects: unknown[] }[] = [],
      governances: { installationId: string; controls: unknown[] }[] = [];
    const wiki = await defaultWiki(this.context.host());
    const list = async (type: string) => {
      const rows = [];
      for (let offset = 0; offset < 100000; offset += 100) {
        const page = await this.context.host().call("entities.list", {
          installationId: wiki.installationId,
          type,
          offset,
          limit: 100,
        });
        rows.push(...page.filter((record) => !record.attributes.archived));
        if (page.length < 100) return rows;
      }
      throw new Response("Wiki exceeds control discovery limit", {
        status: 413,
      });
    };
    const types = await list("graph-type"),
      controlType = types.find(
        (type) => type.attributes.name === "DecisionControl",
      );
    const controls = controlType
      ? (await list("graph-node"))
          .filter((node) => node.attributes.typeId === controlType.ref.id)
          .flatMap((node) => {
            try {
              const body = JSON.parse(String(node.attributes.body));
              return body.kind === "release_approval" && body.state === "active"
                ? [
                    {
                      id: node.ref.id,
                      title: node.title,
                      revision: node.revision,
                    },
                  ]
                : [];
            } catch {
              return [];
            }
          })
      : [];
    for (const app of catalog) {
      if (
        app.actions.some(
          (action) => action.name === "work.targets" && action.permitted,
        )
      ) {
        const targets = z
          .object({ projects: z.array(z.json()) })
          .parse(await this.call(app.installationId, "work.targets"));
        foundries.push({
          installationId: app.installationId,
          projects: targets.projects,
        });
      }
      if (
        app.actions.some(
          (action) =>
            action.name === "governance.work-policy" && action.permitted,
        )
      )
        governances.push({ installationId: app.installationId, controls });
    }
    return { foundries, governances };
  }
}

const idInput = z.strictObject({ submissionId: z.uuid() });
const candidateInput = idInput.extend({ candidateCommit: commit });
const action = <I extends z.ZodType>(
  description: string,
  access: "read" | "write",
  input: I,
  run: (service: WorkExecution, input: z.output<I>) => unknown,
) =>
  defineAction({
    description,
    access,
    input,
    output: z.json(),
    run: async (context: Context, value) =>
      json(await run(new WorkExecution(context), value)),
  });
/** The work page's reads and writes (its route, src/pages/api/apps/planning/work.ts). */
export const planningExecutionActions = {
  "work.destinations": action(
    "Discover same-owner configured Foundry projects and selectable active Governance controls.",
    "read",
    z.strictObject({}),
    (service) => service.destinations(),
  ),
  "work.submissions": action(
    "List saved immutable work submissions for a Planning project.",
    "read",
    z.strictObject({ projectId: z.uuid() }),
    (service, input) => service.submissions(input.projectId),
  ),
  "work.submit": action(
    "Freeze the inspected work package and submit once through Foundry using an explicitly selected Governance control.",
    "write",
    submitWorkInput,
    (service, input) => service.submit(input),
  ),
  "work.refresh": action(
    "Explicitly observe current Foundry evidence and reconcile the sourced Wiki work graph node. Does not approve work.",
    "write",
    idInput,
    (service, input) => service.refresh(input.submissionId),
  ),
  "work.get": action(
    "Retrieve frozen scope, current Foundry evidence, evaluations, freshness and acceptance.",
    "read",
    idInput.extend({
      view: readView.optional(),
      candidateCommit: commit.optional(),
    }),
    (service, input) =>
      service.get(input.submissionId, input.view, input.candidateCommit),
  ),
  "work.evaluate": action(
    "Record an editor's criterion evaluation against exact-commit evidence read from Foundry; passing requires successful check or approval evidence.",
    "write",
    evaluateWorkInput,
    (service, input) => service.evaluate(input),
  ),
  "work.request-review": action(
    "Request existing Governance review for a merged candidate and generate exact package/evaluation evidence. Does not approve work.",
    "write",
    candidateInput.extend({
      recommendation: z.string().trim().min(1).max(16000),
    }),
    (service, input) => service.requestReview(input),
  ),
  "work.accept": action(
    "Accept only fresh, fully evaluated work with a verified exact-candidate Governance decision. Merge and deployment remain separate.",
    "write",
    candidateInput.extend({ occurrenceId: z.uuid().optional() }),
    (service, input) => service.accept(input),
  ),
};
